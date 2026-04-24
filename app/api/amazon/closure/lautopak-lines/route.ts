import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadManualMappings } from '@/lib/amazon-mapping'

// GET /api/amazon/closure/lautopak-lines?id=XXX
//
// Retourne la ventilation par SKU des ventes à facturer sur la facture
// LAUTOPAK pour un settlement donné.
//
// Logique comptable :
//   - "Frais produit" settlement = SOMME(amount) des lignes dont
//     amount_description = 'Principal'  (Orders +, Refunds −)
//   - La facture LAUTOPAK doit totaliser exactement ce montant en listant
//     chaque produit avec sa qté nette × prix
//   - Tout le reste (Shipping, Tax, Commission, FBA fees, Ads, Promotion,
//     Reimbursements…) va dans le compte "Coût de ventes Amazon".

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

  try {
    // 1) Settlement (pour affichage)
    const { data: s } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end, total_amount')
      .eq('settlement_id', id)
      .maybeSingle()
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    // 2a) TOUTES les transactions avec SKU du settlement (pour breakdown par
    //     amount_description). Permet d'identifier ce qui compose réellement
    //     le "Frais de produits" sur le relevé imprimé.
    const all: any[] = []
    {
      let from = 0
      while (true) {
        const { data, error } = await supabaseAdmin
          .from('amazon_transactions')
          .select('sku, traction_code, quantity_purchased, amount, amount_type, amount_description, transaction_type')
          .eq('settlement_id', id)
          .range(from, from + 999)
        if (error) throw error
        all.push(...(data || []))
        if (!data || data.length < 1000) break
        from += 1000
      }
    }

    // Récapitulatif par amount_description (tous transaction_type confondus)
    const breakdownMap = new Map<string, { count: number; total: number }>()
    for (const t of all) {
      const k = t.amount_description || '(null)'
      const ex = breakdownMap.get(k) || { count: 0, total: 0 }
      ex.count++
      ex.total += Number(t.amount || 0)
      breakdownMap.set(k, ex)
    }
    const breakdown = [...breakdownMap.entries()]
      .map(([amount_description, v]) => ({ amount_description, count: v.count, total: Number(v.total.toFixed(2)) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))

    // 2b) Lignes "Principal" Orders SEULEMENT (= "Frais de produits" du relevé Amazon)
    //     Les refunds sont traités séparément : ils ne sont PAS déduits du total
    //     à facturer dans LAUTOPAK. La comptable gère les refunds comme des
    //     notes de crédit / retours clients dans un compte distinct.
    const tx = all.filter(t => t.amount_description === 'Principal' && t.transaction_type === 'Order')
    const refunds = all.filter(t => t.amount_description === 'Principal' && t.transaction_type === 'Refund')

    // 3) Produit info (nom) — on récupère depuis amazon_fba_inventory (dernier snapshot connu)
    const skus = Array.from(new Set(tx.map(t => t.sku).filter(Boolean)))
    const productNames = new Map<string, string>()
    if (skus.length > 0) {
      for (let i = 0; i < skus.length; i += 500) {
        const batch = skus.slice(i, i + 500)
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, product_name')
          .in('sku', batch)
        for (const r of data || []) {
          if (!productNames.has(r.sku) && r.product_name) productNames.set(r.sku, r.product_name)
        }
      }
    }

    // 4) Agrégation des ORDERS par SKU (ce qui va dans la facture LAUTOPAK)
    type Agg = {
      sku: string; traction_code: string | null; product_name: string | null;
      qty: number; amount: number;
    }
    const bySku = new Map<string, Agg>()
    for (const t of tx) {
      const sku = t.sku || '(sans SKU)'
      if (!bySku.has(sku)) {
        bySku.set(sku, {
          sku,
          traction_code: t.traction_code || null,
          product_name: productNames.get(sku) || null,
          qty: 0, amount: 0,
        })
      }
      const ex = bySku.get(sku)!
      ex.qty += Number(t.quantity_purchased || 0)
      ex.amount += Number(t.amount || 0)
      if (!ex.traction_code && t.traction_code) ex.traction_code = t.traction_code
    }

    // Agrégation des REFUNDS par SKU (pour affichage séparé et note de crédit)
    const refundsBySku = new Map<string, Agg>()
    for (const t of refunds) {
      const sku = t.sku || '(sans SKU)'
      if (!refundsBySku.has(sku)) {
        refundsBySku.set(sku, {
          sku,
          traction_code: t.traction_code || null,
          product_name: productNames.get(sku) || null,
          qty: 0, amount: 0,
        })
      }
      const ex = refundsBySku.get(sku)!
      ex.qty += Math.abs(Number(t.quantity_purchased || 0))
      ex.amount += Number(t.amount || 0)   // négatif
      if (!ex.traction_code && t.traction_code) ex.traction_code = t.traction_code
    }

    // 5) REGROUPEMENT par PKCode cible (après multi-mapping) AVEC détail par SKU variante.
    // Exemple :
    //   AU6913023 (2) + FBA-U6913023 (9) → regroupés sous FBA-U6913023 avec 11 ventes
    //   FBM-78920-2 (5) + FBM-78920-3 (3) + FBM-78920-4 (2) → sous FBM-78920 avec 10 ventes
    //   (qté LAUTOPAK = Σ qty × multiplier)
    const manualMappings = await loadManualMappings()

    const roundToTenth = (n: number) => Math.round(n * 10) / 10

    type Variante = { amazon_sku: string; qty_amazon: number; multiplier: number; qty_lautopak: number; amount_source: number }
    type GroupLine = {
      pk_code: string
      manual_mapping: boolean
      variantes: Variante[]
      product_name: string | null
      qty_amazon_total: number
      qty_lautopak_total: number
      amount: number        // somme des amount sources (brut avant arrondi)
      prix_unitaire: number // calculé lors du balance
      amount_balanced: number
    }

    const groupByPkCode = (aggs: Iterable<Agg>, isRefund: boolean) => {
      const byPk = new Map<string, GroupLine>()
      for (const a of aggs) {
        const qtyAmazon = isRefund ? Math.abs(a.qty) : a.qty
        const amountSource = Number(a.amount.toFixed(2))
        const manual = manualMappings.get(a.sku)
        if (manual && manual.length > 0) {
          const share = 1 / manual.length
          for (const m of manual) {
            const qtyLpk = qtyAmazon * m.multiplier
            const entry = byPk.get(m.pk_code) || {
              pk_code: m.pk_code, manual_mapping: true, variantes: [],
              product_name: a.product_name, qty_amazon_total: 0, qty_lautopak_total: 0,
              amount: 0, prix_unitaire: 0, amount_balanced: 0,
            }
            entry.qty_amazon_total += qtyAmazon
            entry.qty_lautopak_total += qtyLpk
            entry.amount += amountSource * share
            entry.variantes.push({
              amazon_sku: a.sku, qty_amazon: qtyAmazon, multiplier: m.multiplier,
              qty_lautopak: qtyLpk, amount_source: Number((amountSource * share).toFixed(2)),
            })
            if (!entry.product_name && a.product_name) entry.product_name = a.product_name
            byPk.set(m.pk_code, entry)
          }
        } else {
          const pk = a.traction_code || a.sku
          const entry = byPk.get(pk) || {
            pk_code: pk, manual_mapping: false, variantes: [],
            product_name: a.product_name, qty_amazon_total: 0, qty_lautopak_total: 0,
            amount: 0, prix_unitaire: 0, amount_balanced: 0,
          }
          entry.qty_amazon_total += qtyAmazon
          entry.qty_lautopak_total += qtyAmazon   // sans mapping → multiplier = 1
          entry.amount += amountSource
          entry.variantes.push({
            amazon_sku: a.sku, qty_amazon: qtyAmazon, multiplier: 1,
            qty_lautopak: qtyAmazon, amount_source: amountSource,
          })
          if (!entry.product_name && a.product_name) entry.product_name = a.product_name
          byPk.set(pk, entry)
        }
      }
      return byPk
    }

    const balanceGroupLines = (lines: GroupLine[], targetTotal: number) => {
      // Étape 1 : prix unitaire brut = amount / qty_lautopak (ou qty_amazon si 0)
      for (const l of lines) {
        const divQty = l.qty_lautopak_total || l.qty_amazon_total
        const raw = divQty !== 0 ? l.amount / divQty : 0
        l.prix_unitaire = roundToTenth(raw)
        l.amount_balanced = Number((l.prix_unitaire * divQty).toFixed(2))
      }
      const sumRounded = Number(lines.reduce((s, l) => s + (l.amount_balanced || 0), 0).toFixed(2))
      let remaining = Number((targetTotal - sumRounded).toFixed(2))
      if (Math.abs(remaining) < 0.005) return { adjustments: 0, delta_residuel: 0 }
      const direction = remaining > 0 ? 1 : -1
      remaining = Math.abs(remaining)
      const sorted = [...lines].filter(l => (l.qty_lautopak_total || l.qty_amazon_total) > 0)
        .sort((a, b) => (b.qty_lautopak_total || b.qty_amazon_total) - (a.qty_lautopak_total || a.qty_amazon_total))
      let adjustments = 0
      for (const l of sorted) {
        if (remaining < 0.005) break
        const divQty = l.qty_lautopak_total || l.qty_amazon_total
        const stepValue = divQty * 0.10
        if (stepValue === 0) continue
        const maxSteps = Math.floor(remaining / stepValue)
        if (maxSteps <= 0) continue
        const steps = Math.min(maxSteps, 20)
        l.prix_unitaire = Number((l.prix_unitaire + direction * steps * 0.10).toFixed(2))
        l.amount_balanced = Number((l.prix_unitaire * divQty).toFixed(2))
        remaining = Number((remaining - steps * stepValue).toFixed(2))
        adjustments++
      }
      if (remaining >= 0.005 && sorted.length > 0) {
        const biggest = sorted[0]
        const divQty = biggest.qty_lautopak_total || biggest.qty_amazon_total
        biggest.amount_balanced = Number((biggest.amount_balanced + direction * remaining).toFixed(2))
        biggest.prix_unitaire = Number((biggest.amount_balanced / divQty).toFixed(2))
        remaining = 0
        adjustments++
      }
      return { adjustments, delta_residuel: remaining }
    }

    // ── Orders (Principal brut = Frais produit settlement) ──
    const fraisProduitTarget = Number(tx.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))
    const ordersGroups = [...groupByPkCode(bySku.values(), false).values()]
      .filter(g => g.qty_amazon_total !== 0 || g.amount !== 0)
    const { adjustments: adjOrders, delta_residuel: deltaOrders } = balanceGroupLines(ordersGroups, fraisProduitTarget)
    ordersGroups.sort((a, b) => b.amount - a.amount)

    const refundsTarget = Number(refunds.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))
    const refundsGroups = [...groupByPkCode(refundsBySku.values(), true).values()]
      .filter(g => g.qty_amazon_total !== 0 || g.amount !== 0)
    const { adjustments: adjRef, delta_residuel: deltaRef } = balanceGroupLines(refundsGroups, refundsTarget)
    refundsGroups.sort((a, b) => a.amount - b.amount)

    // Format final pour l'UI
    const mapGroupToLine = (g: GroupLine) => ({
      pk_code: g.pk_code,
      manual_mapping: g.manual_mapping,
      variantes: g.variantes,
      amazon_skus: g.variantes.map(v => v.amazon_sku),
      product_name: g.product_name,
      qty: g.qty_amazon_total,            // qté Amazon totale (ventes)
      qty_lautopak: g.qty_lautopak_total, // qté LAUTOPAK (avec multipliers)
      amount: g.amount_balanced,          // montant final balancé
      prix_unitaire: g.prix_unitaire,
      // backward compat
      sku: g.variantes.length === 1 ? g.variantes[0].amazon_sku : `${g.variantes.length} variantes`,
      traction_code: g.pk_code,
    })
    const lignes: any[] = ordersGroups.map(mapGroupToLine)
    const refunds_lignes: any[] = refundsGroups.map(mapGroupToLine)

    // Enrichir avec l'état "facturée" (checkbox persistante, keyée par pk_code)
    // NB: la colonne DB s'appelle "sku" mais on y stocke le pk_code cible pour
    // que la case reste cohérente avec le regroupement par pk_code.
    const { data: facturees } = await supabaseAdmin
      .from('amazon_lautopak_lines_facturees')
      .select('sku, facturee_le, facturee_par')
      .eq('settlement_id', id)
    const facturSet = new Map<string, any>()
    for (const f of facturees || []) facturSet.set(f.sku, f)
    for (const l of lignes as any[]) {
      const f = facturSet.get(l.pk_code)
      l.facturee = !!f
      l.facturee_le = f?.facturee_le || null
      l.facturee_par = f?.facturee_par || null
    }

    // Total calculé = somme des montants BALANCÉS (= settlement Frais produit exactement)
    const total_calcule = Number(lignes.reduce((s: number, l: any) => s + (l.amount || 0), 0).toFixed(2))
    const total_refunds = Number(refunds_lignes.reduce((s: number, l: any) => s + (l.amount || 0), 0).toFixed(2))
    const frais_produit_settlement = fraisProduitTarget

    return NextResponse.json({
      settlement_id: s.settlement_id,
      settlement_start: s.settlement_start,
      settlement_end: s.settlement_end,
      settlement_total: Number(s.total_amount || 0),
      frais_produit_settlement,   // = Orders Principal brut (= relevé Amazon)
      total_calcule,              // = somme des lignes Orders (doit matcher)
      total_refunds,              // = somme des refunds (à traiter séparément)
      nb_lignes: lignes.length,
      nb_refunds: refunds_lignes.length,
      balance_ok: Math.abs(total_calcule - frais_produit_settlement) < 0.01,
      ecart: Number((total_calcule - frais_produit_settlement).toFixed(2)),
      breakdown,   // décomposition par amount_description (aide au diagnostic)
      lignes,              // Orders Principal brut par SKU (avec prix arrondis balancés)
      refunds_lignes,      // Refunds Principal par SKU (note de crédit séparée)
      balance_info: {
        orders_adjustments: adjOrders,
        orders_delta_residuel: deltaOrders,
        refunds_adjustments: adjRef,
        refunds_delta_residuel: deltaRef,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
