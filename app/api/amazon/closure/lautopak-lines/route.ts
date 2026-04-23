import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

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

    // 2b) Lignes "Principal" du settlement, groupées par SKU (pour facture LAUTOPAK)
    const tx = all.filter(t => t.amount_description === 'Principal')

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

    // 4) Agrégation par SKU
    type Agg = {
      sku: string; traction_code: string | null; product_name: string | null;
      qty_orders: number; qty_refunds: number;
      amount_orders: number; amount_refunds: number;
    }
    const bySku = new Map<string, Agg>()
    for (const t of tx) {
      const sku = t.sku || '(sans SKU)'
      if (!bySku.has(sku)) {
        bySku.set(sku, {
          sku,
          traction_code: t.traction_code || null,
          product_name: productNames.get(sku) || null,
          qty_orders: 0, qty_refunds: 0,
          amount_orders: 0, amount_refunds: 0,
        })
      }
      const ex = bySku.get(sku)!
      const isRefund = t.transaction_type === 'Refund' || Number(t.amount) < 0
      const qty = Number(t.quantity_purchased || 0)
      const amt = Number(t.amount || 0)
      if (isRefund) {
        // qty_purchased peut être positive sur un refund ; on la compte côté refund
        ex.qty_refunds += Math.abs(qty)
        ex.amount_refunds += amt  // négatif généralement
      } else {
        ex.qty_orders += qty
        ex.amount_orders += amt
      }
      if (!ex.traction_code && t.traction_code) ex.traction_code = t.traction_code
    }

    // 5) Lignes finales (nettes)
    const lignes = [...bySku.values()].map(a => {
      const qty_net = a.qty_orders - a.qty_refunds
      const amount_net = Number((a.amount_orders + a.amount_refunds).toFixed(2))
      const prix_unitaire = qty_net !== 0 ? Number((amount_net / qty_net).toFixed(2)) : 0
      return {
        sku: a.sku,
        traction_code: a.traction_code,
        product_name: a.product_name,
        qty_orders: a.qty_orders,
        qty_refunds: a.qty_refunds,
        qty_net,
        amount_orders: Number(a.amount_orders.toFixed(2)),
        amount_refunds: Number(a.amount_refunds.toFixed(2)),
        amount_net,
        prix_unitaire,
      }
    })
      .filter(l => l.qty_net !== 0 || l.amount_net !== 0)
      .sort((a, b) => b.amount_net - a.amount_net)

    const total_calcule = Number(lignes.reduce((s, l) => s + l.amount_net, 0).toFixed(2))
    const frais_produit_settlement = Number(tx.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))

    return NextResponse.json({
      settlement_id: s.settlement_id,
      settlement_start: s.settlement_start,
      settlement_end: s.settlement_end,
      settlement_total: Number(s.total_amount || 0),
      frais_produit_settlement,   // somme Principal (attendu)
      total_calcule,              // somme des lignes (doit être identique)
      nb_lignes: lignes.length,
      balance_ok: Math.abs(total_calcule - frais_produit_settlement) < 0.01,
      ecart: Number((total_calcule - frais_produit_settlement).toFixed(2)),
      breakdown,   // décomposition par amount_description (aide au diagnostic)
      lignes,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
