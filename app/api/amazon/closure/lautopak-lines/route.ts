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

    // 5) Re-groupement par pk_code CIBLE (après multi-mapping)
    // Exemple: AU6913023 (2 ventes) + FBA-U6913023 (9 ventes) tous deux mappés
    // à pk_code FBA-U6913023 → 1 seule ligne FBA-U6913023 avec 11 ventes.
    // Si pas de mapping manuel, on garde traction_code auto-résolu comme clé.
    const manualMappings = await loadManualMappings()
    type Source = { amazon_sku: string; qty_amazon: number; multiplier: number; qty_physical: number; amount: number }
    type PkLine = {
      pk_code: string
      amazon_skus: string[]
      sources: Source[]
      product_name: string | null
      qty: number
      amount: number
      has_manual_mapping: boolean
    }
    const groupByPkCode = (aggs: Iterable<Agg>, isRefund: boolean) => {
      const byPk = new Map<string, PkLine>()
      for (const a of aggs) {
        const amazonQty = isRefund ? Math.abs(a.qty) : a.qty
        const manual = manualMappings.get(a.sku)
        if (manual && manual.length > 0) {
          const share = 1 / manual.length
          for (const m of manual) {
            const entry = byPk.get(m.pk_code) || {
              pk_code: m.pk_code, amazon_skus: [], sources: [],
              product_name: a.product_name, qty: 0, amount: 0,
              has_manual_mapping: true,
            }
            const physicalQty = amazonQty * m.multiplier
            entry.qty += physicalQty
            entry.amount += a.amount * share
            if (!entry.amazon_skus.includes(a.sku)) entry.amazon_skus.push(a.sku)
            entry.sources.push({
              amazon_sku: a.sku, qty_amazon: amazonQty, multiplier: m.multiplier,
              qty_physical: physicalQty, amount: Number((a.amount * share).toFixed(2)),
            })
            if (!entry.product_name && a.product_name) entry.product_name = a.product_name
            byPk.set(m.pk_code, entry)
          }
        } else {
          const pk = a.traction_code || a.sku
          const entry = byPk.get(pk) || {
            pk_code: pk, amazon_skus: [], sources: [],
            product_name: a.product_name, qty: 0, amount: 0,
            has_manual_mapping: false,
          }
          entry.qty += amazonQty
          entry.amount += a.amount
          if (!entry.amazon_skus.includes(a.sku)) entry.amazon_skus.push(a.sku)
          entry.sources.push({
            amazon_sku: a.sku, qty_amazon: amazonQty, multiplier: 1,
            qty_physical: amazonQty, amount: Number(a.amount.toFixed(2)),
          })
          if (!entry.product_name && a.product_name) entry.product_name = a.product_name
          byPk.set(pk, entry)
        }
      }
      return byPk
    }

    const toFinal = (pkMap: Map<string, PkLine>, sortDesc: boolean) =>
      [...pkMap.values()].map(a => ({
        pk_code: a.pk_code,
        amazon_skus: a.amazon_skus,
        sources: a.sources,   // détail par SKU source (qty, multiplier, physical, amount)
        sku: a.amazon_skus.length === 1 ? a.amazon_skus[0] : `${a.amazon_skus.length} SKU`,
        traction_code: a.pk_code,
        product_name: a.product_name,
        qty: a.qty,
        amount: Number(a.amount.toFixed(2)),
        prix_unitaire: a.qty !== 0 ? Number((a.amount / a.qty).toFixed(2)) : 0,
        manual_mapping: a.has_manual_mapping,
      }))
        .filter(l => l.qty !== 0 || l.amount !== 0)
        .sort((a, b) => sortDesc ? b.amount - a.amount : a.amount - b.amount)

    const lignes = toFinal(groupByPkCode(bySku.values(), false), true)
    const refunds_lignes = toFinal(groupByPkCode(refundsBySku.values(), true), false)

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

    const total_calcule = Number(lignes.reduce((s, l) => s + l.amount, 0).toFixed(2))
    const total_refunds = Number(refunds_lignes.reduce((s, l) => s + l.amount, 0).toFixed(2))
    // "Frais produit" côté Amazon = Orders Principal (brut, sans refunds)
    const frais_produit_settlement = Number(tx.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))

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
      lignes,              // Orders Principal brut par SKU
      refunds_lignes,      // Refunds Principal par SKU (note de crédit séparée)
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
