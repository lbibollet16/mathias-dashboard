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

    // 5) Chaque ligne = 1 SKU Amazon (pas de regroupement).
    // Colonne "PKCode mapping" = pk_code(s) associé(s) via multi-mapping + multiplier.
    // Quantité = qty Amazon. Quantité LAUTOPAK = qty × multiplier (pour inventaire).
    // Prix unitaires arrondis à 0,10, ajustés pour que Σ (qty × prix) = frais_produit_settlement.
    const manualMappings = await loadManualMappings()

    const roundToTenth = (n: number) => Math.round(n * 10) / 10

    const enrichAndMap = (aggs: Iterable<Agg>, isRefund: boolean) => {
      return [...aggs].map(a => {
        const qtyAmazon = isRefund ? Math.abs(a.qty) : a.qty
        const manual = manualMappings.get(a.sku)
        const pk_codes_mapping = manual && manual.length > 0
          ? manual.map(m => ({ pk_code: m.pk_code, multiplier: m.multiplier, qty_lautopak: qtyAmazon * m.multiplier }))
          : null
        // Qté LAUTOPAK totale = somme des qty_lautopak des mappings (si multi) ou qty Amazon
        const qty_lautopak_total = pk_codes_mapping
          ? pk_codes_mapping.reduce((s, m) => s + m.qty_lautopak, 0)
          : qtyAmazon
        return {
          sku: a.sku,
          traction_code: a.traction_code,
          product_name: a.product_name,
          qty: qtyAmazon,                   // qté Amazon (ventes brutes)
          qty_lautopak: qty_lautopak_total, // qté à débiter dans LAUTOPAK (avec multiplier)
          amount: Number(a.amount.toFixed(2)),
          prix_unitaire_raw: qtyAmazon !== 0 ? Number((a.amount / qtyAmazon).toFixed(4)) : 0,
          prix_unitaire: 0, // calculé plus bas
          amount_balanced: 0,
          manual_mapping: !!pk_codes_mapping,
          pk_codes_mapping,
        }
      })
      .filter(l => l.qty !== 0 || l.amount !== 0)
    }

    const balanceLines = (lines: any[], targetTotal: number) => {
      // Étape 1 : arrondir chaque prix unitaire à 0,10
      for (const l of lines) {
        if (l.qty > 0) {
          l.prix_unitaire = roundToTenth(l.prix_unitaire_raw)
          l.amount_balanced = Number((l.prix_unitaire * l.qty).toFixed(2))
        }
      }
      // Étape 2 : calculer le delta restant
      const sumRounded = Number(lines.reduce((s, l) => s + (l.amount_balanced || 0), 0).toFixed(2))
      let remaining = Number((targetTotal - sumRounded).toFixed(2))
      if (Math.abs(remaining) < 0.005) return { adjustments: 0, delta_residuel: 0 }
      const direction = remaining > 0 ? 1 : -1
      remaining = Math.abs(remaining)
      // Étape 3 : bump par 0,10 sur lignes avec plus grande qty (plus efficace)
      const sorted = [...lines].filter(l => l.qty > 0).sort((a, b) => b.qty - a.qty)
      let adjustments = 0
      for (const l of sorted) {
        if (remaining < 0.005) break
        const stepValue = l.qty * 0.10   // ce que rapporte +0,10 sur le prix unitaire
        if (stepValue === 0) continue
        const maxSteps = Math.floor(remaining / stepValue)
        if (maxSteps <= 0) continue
        const steps = Math.min(maxSteps, 20)
        l.prix_unitaire = Number((l.prix_unitaire + direction * steps * 0.10).toFixed(2))
        l.amount_balanced = Number((l.prix_unitaire * l.qty).toFixed(2))
        remaining = Number((remaining - steps * stepValue).toFixed(2))
        adjustments++
      }
      // Résiduel < 0,10 × qty max : on l'absorbe en ajustant au centime la plus grande ligne
      if (remaining >= 0.005 && sorted.length > 0) {
        const biggest = sorted[0]
        biggest.amount_balanced = Number((biggest.amount_balanced + direction * remaining).toFixed(2))
        biggest.prix_unitaire = Number((biggest.amount_balanced / biggest.qty).toFixed(2))
        remaining = 0
        adjustments++
      }
      return { adjustments, delta_residuel: remaining }
    }

    // ── Orders (Principal brut = Frais produit settlement)
    const fraisProduitTarget = Number(tx.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))
    const lignes = enrichAndMap(bySku.values(), false)
    const { adjustments: adjOrders, delta_residuel: deltaOrders } = balanceLines(lignes, fraisProduitTarget)
    lignes.sort((a: any, b: any) => b.amount - a.amount)

    // ── Refunds (Principal Refund)
    const refundsTarget = Number(refunds.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))
    const refunds_lignes = enrichAndMap(refundsBySku.values(), true)
    // Pour les refunds, montant est négatif. On force le signe du raw unit price à rester négatif.
    for (const l of refunds_lignes) { l.prix_unitaire_raw = -Math.abs(l.prix_unitaire_raw) }
    const { adjustments: adjRef, delta_residuel: deltaRef } = balanceLines(refunds_lignes, refundsTarget)
    refunds_lignes.sort((a: any, b: any) => a.amount - b.amount)

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
    const total_calcule = Number(lignes.reduce((s: number, l: any) => s + (l.amount_balanced || 0), 0).toFixed(2))
    const total_refunds = Number(refunds_lignes.reduce((s: number, l: any) => s + (l.amount_balanced || 0), 0).toFixed(2))
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
