import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Catégorisation des transactions pour l'affichage compta.
// Retourne { category, sign } ou null si ignoré.
function categorize(amount_type: string | null, amount_description: string | null): { category: string; order: number } | null {
  const t = (amount_type || '').trim()
  const d = (amount_description || '').trim()

  if (t === 'ItemPrice') {
    if (d === 'Principal') return { category: 'Ventes (Principal)', order: 1 }
    if (d === 'Shipping') return { category: 'Frais de livraison (client)', order: 2 }
    if (d === 'Tax' || d === 'ShippingTax') return { category: 'Taxes perçues', order: 3 }
    return { category: 'Ventes — Autre', order: 4 }
  }
  if (t === 'ItemWithheldTax') return { category: 'Taxes retenues par Amazon', order: 5 }
  if (t === 'ItemFees') {
    if (d === 'Commission') return { category: 'Commission Amazon', order: 10 }
    if (d === 'FBAPerUnitFulfillmentFee') return { category: 'Frais FBA (pick & pack)', order: 11 }
    if (d === 'RefundCommission') return { category: 'Commission sur remboursements', order: 12 }
    if (d === 'ShippingChargeback' || d === 'ShippingHB') return { category: 'Frais d\'expédition (rétrofacturés)', order: 13 }
    return { category: 'Autres frais Amazon', order: 14 }
  }
  if (t === 'Promotion') return { category: 'Promotions', order: 15 }
  if (t === 'Cost of Advertising') return { category: 'Publicité Amazon', order: 20 }
  if (t === 'FBA Inventory Reimbursement') return { category: 'Remboursements FBA (Lost/Damaged)', order: 25 }
  if (t === 'other-transaction') {
    if (d === 'StorageRenewalBilling') return { category: 'Frais de stockage FBA', order: 30 }
    if (d === 'Subscription Fee') return { category: 'Abonnement Amazon', order: 31 }
    if (d === 'RemovalComplete') return { category: 'Retours d\'inventaire', order: 32 }
    return { category: 'Autres transactions', order: 33 }
  }
  return { category: 'Non catégorisé', order: 99 }
}

function isFba(fulfillment_id: string | null): boolean { return fulfillment_id === 'AFN' }
function isFbm(fulfillment_id: string | null): boolean { return fulfillment_id === 'MFN' }

// GET — liste des settlements (sans id) ou détail complet (avec ?id=...)
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')

    if (!id) {
      // Liste: on enrichit chaque settlement avec total_net et nb_orders agrégés
      const { data: settlements, error } = await supabaseAdmin
        .from('amazon_settlements')
        .select('*')
        .order('deposit_date', { ascending: false })
      if (error) throw error

      // Agréger par settlement_id en une seule requête (via transactions)
      const result: any[] = []
      for (const s of settlements || []) {
        const { data: tx } = await supabaseAdmin
          .from('amazon_transactions')
          .select('amount, fulfillment_id, order_id')
          .eq('settlement_id', s.settlement_id)

        let total_net = 0
        let fba_net = 0
        let fbm_net = 0
        const orders = new Set<string>()
        for (const t of tx || []) {
          const a = Number(t.amount || 0)
          total_net += a
          if (isFba(t.fulfillment_id))      fba_net += a
          else if (isFbm(t.fulfillment_id)) fbm_net += a
          if (t.order_id) orders.add(t.order_id)
        }
        result.push({
          ...s,
          computed_net: total_net,
          computed_fba_net: fba_net,
          computed_fbm_net: fbm_net,
          nb_orders: orders.size,
          nb_transactions: (tx || []).length,
        })
      }
      return NextResponse.json(result)
    }

    // Détail d'un settlement
    const { data: settlement, error: sErr } = await supabaseAdmin
      .from('amazon_settlements')
      .select('*')
      .eq('settlement_id', id)
      .single()
    if (sErr || !settlement) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    // Toutes les transactions (paginé)
    const allTx: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_transactions')
        .select('*')
        .eq('settlement_id', id)
        .range(from, from + 999)
      if (error) throw error
      allTx.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // Breakdown par catégorie (brut / FBA / FBM)
    const breakdown = new Map<string, { category: string; order: number; brut: number; fba: number; fbm: number; count: number }>()
    let total_brut = 0
    let total_fba = 0
    let total_fbm = 0
    for (const t of allTx) {
      const cat = categorize(t.amount_type, t.amount_description)
      if (!cat) continue
      const a = Number(t.amount || 0)
      total_brut += a
      if (isFba(t.fulfillment_id))      total_fba += a
      else if (isFbm(t.fulfillment_id)) total_fbm += a
      const key = cat.category
      if (!breakdown.has(key)) breakdown.set(key, { category: key, order: cat.order, brut: 0, fba: 0, fbm: 0, count: 0 })
      const b = breakdown.get(key)!
      b.brut += a
      if (isFba(t.fulfillment_id))      b.fba += a
      else if (isFbm(t.fulfillment_id)) b.fbm += a
      b.count++
    }
    const breakdownArr = Array.from(breakdown.values()).sort((a, b) => a.order - b.order)

    // Commandes agrégées (somme des montants par order_id)
    const orders = new Map<string, {
      order_id: string
      fulfillment_id: string | null
      skus: Set<string>
      tractions: Set<string>
      qty: number
      brut: number
      ventes: number        // Principal + Shipping
      fees: number          // négatifs
      tax: number
      posted_date: string | null
    }>()
    for (const t of allTx) {
      if (!t.order_id) continue
      if (!orders.has(t.order_id)) {
        orders.set(t.order_id, {
          order_id: t.order_id,
          fulfillment_id: t.fulfillment_id,
          skus: new Set(),
          tractions: new Set(),
          qty: 0,
          brut: 0,
          ventes: 0,
          fees: 0,
          tax: 0,
          posted_date: t.posted_date,
        })
      }
      const o = orders.get(t.order_id)!
      const a = Number(t.amount || 0)
      o.brut += a
      if (t.sku) o.skus.add(t.sku)
      if (t.traction_code) o.tractions.add(t.traction_code)
      if (t.quantity_purchased) o.qty += Number(t.quantity_purchased)
      if (t.amount_type === 'ItemPrice' && (t.amount_description === 'Principal' || t.amount_description === 'Shipping')) o.ventes += a
      else if (t.amount_type === 'ItemFees') o.fees += a
      else if (t.amount_type === 'ItemPrice' && (t.amount_description === 'Tax' || t.amount_description === 'ShippingTax')) o.tax += a
      else if (t.amount_type === 'ItemWithheldTax') o.tax += a
    }
    const ordersArr = Array.from(orders.values()).map(o => ({
      ...o,
      skus: Array.from(o.skus),
      tractions: Array.from(o.tractions),
    })).sort((a, b) => b.brut - a.brut)

    // Top SKU par revenu (Principal + Shipping uniquement)
    const skuStats = new Map<string, { sku: string; traction_code: string | null; qty: number; revenue: number }>()
    for (const t of allTx) {
      if (!t.sku) continue
      if (t.amount_type !== 'ItemPrice' || (t.amount_description !== 'Principal' && t.amount_description !== 'Shipping')) continue
      if (!skuStats.has(t.sku)) skuStats.set(t.sku, { sku: t.sku, traction_code: t.traction_code, qty: 0, revenue: 0 })
      const s = skuStats.get(t.sku)!
      s.revenue += Number(t.amount || 0)
      if (t.amount_description === 'Principal') s.qty += Number(t.quantity_purchased || 0)
      if (!s.traction_code && t.traction_code) s.traction_code = t.traction_code
    }
    const topSkus = Array.from(skuStats.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 20)

    // ─── Remboursements du settlement + traçage prix coûtant ─────────────
    // On joint par approval_date dans la période du settlement.
    let reimbs: any[] = []
    if (settlement.settlement_start && settlement.settlement_end) {
      const { data: rData } = await supabaseAdmin
        .from('amazon_reimbursements')
        .select('*')
        .gte('approval_date', settlement.settlement_start)
        .lte('approval_date', settlement.settlement_end)
        .order('approval_date', { ascending: false })
      reimbs = rData || []
    }

    // Construire le map PKCode → prix_coutant Traction (priorité au premier non-zéro)
    const needCodes = new Set<string>()
    for (const r of reimbs) if (r.traction_code) needCodes.add(r.traction_code)
    for (const o of allTx) if (o.traction_code) needCodes.add(o.traction_code)

    const coutantMap = new Map<string, number>()
    if (needCodes.size > 0) {
      const { data: cData } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, prix_coutant')
        .in('pk_code', Array.from(needCodes))
      for (const c of cData || []) {
        const cur = coutantMap.get(c.pk_code)
        const v = Number(c.prix_coutant || 0)
        if (v > 0 && (cur === undefined || cur === 0)) coutantMap.set(c.pk_code, v)
        else if (cur === undefined) coutantMap.set(c.pk_code, v)
      }
    }

    // Enrichir les remboursements avec traction_coutant + écart
    const reimbursementsEnriched = reimbs.map((r: any) => {
      const coutant = r.traction_code ? (coutantMap.get(r.traction_code) || 0) : 0
      const qtyTotal = Number(r.quantity_reimbursed_total || 0)
      const qtyCash = Number(r.quantity_reimbursed_cash || 0)
      const qtyInv  = Number(r.quantity_reimbursed_inventory || 0)
      const amountPerUnit = Number(r.amount_per_unit || 0)
      const ecartUnit = coutant > 0 ? (amountPerUnit - coutant) : 0
      const ecartTotal = coutant > 0 ? (ecartUnit * qtyTotal) : 0
      const coutantTotal = coutant * qtyTotal
      return {
        ...r,
        traction_coutant: coutant,
        coutant_total: coutantTotal,
        ecart_unitaire: ecartUnit,
        ecart_total: ecartTotal,
        qty_cash: qtyCash,
        qty_inventory: qtyInv,
      }
    })

    const reimbTotals = reimbursementsEnriched.reduce((acc: any, r: any) => {
      acc.count++
      acc.amount_total += Number(r.amount_total || 0)
      acc.coutant_total += Number(r.coutant_total || 0)
      acc.ecart_total += Number(r.ecart_total || 0)
      acc.qty_cash += Number(r.qty_cash || 0)
      acc.qty_inventory += Number(r.qty_inventory || 0)
      return acc
    }, { count: 0, amount_total: 0, coutant_total: 0, ecart_total: 0, qty_cash: 0, qty_inventory: 0 })

    // ─── Mouvements d'inventaire (SKU → qty net à déduire LAUTOPAK) ──────
    // net_to_deduct = qty_sold - qty_returned + qty_reimbursed_cash
    //   qty_sold         = sum quantity_purchased pour Order / ItemPrice / Principal
    //   qty_returned     = 1 par ligne Refund / ItemPrice / Principal (qty non-fournie par Amazon)
    //   qty_reimb_cash   = quantity_reimbursed_cash des remboursements (période settlement)
    type Mouvement = {
      sku: string; traction_code: string | null; description: string | null;
      sold: number; returned: number; lost: number;
      net: number; coutant: number; valeur_net: number;
    }
    const mouvements = new Map<string, Mouvement>()
    const ensure = (sku: string, tractionCode: string | null): Mouvement => {
      if (!mouvements.has(sku)) {
        mouvements.set(sku, {
          sku, traction_code: tractionCode,
          description: null,
          sold: 0, returned: 0, lost: 0,
          net: 0, coutant: 0, valeur_net: 0,
        })
      }
      const m = mouvements.get(sku)!
      if (!m.traction_code && tractionCode) m.traction_code = tractionCode
      return m
    }

    for (const t of allTx) {
      if (!t.sku) continue
      if (t.amount_type !== 'ItemPrice' || t.amount_description !== 'Principal') continue
      const m = ensure(t.sku, t.traction_code)
      if (t.transaction_type === 'Order') {
        m.sold += Number(t.quantity_purchased || 1)
      } else if (t.transaction_type === 'Refund') {
        // qty non fournie par Amazon pour les refunds → 1 par ligne
        const q = Number(t.quantity_purchased || 0)
        m.returned += (q > 0 ? q : 1)
      }
    }

    for (const r of reimbursementsEnriched) {
      if (!r.sku) continue
      const m = ensure(r.sku, r.traction_code)
      m.lost += Number(r.qty_cash || 0)
    }

    // Finaliser net + valeur (en utilisant coutant Traction)
    const mouvementsArr = Array.from(mouvements.values()).map(m => {
      const coutant = m.traction_code ? (coutantMap.get(m.traction_code) || 0) : 0
      const net = m.sold - m.returned + m.lost
      return {
        ...m,
        coutant,
        net,
        valeur_net: coutant * net,
      }
    }).filter(m => m.sold !== 0 || m.returned !== 0 || m.lost !== 0)
      .sort((a, b) => b.net - a.net || b.sold - a.sold)

    const mouvTotals = mouvementsArr.reduce((acc: any, m: any) => {
      acc.sold += m.sold
      acc.returned += m.returned
      acc.lost += m.lost
      acc.net += m.net
      acc.valeur_net += m.valeur_net
      return acc
    }, { sold: 0, returned: 0, lost: 0, net: 0, valeur_net: 0 })

    return NextResponse.json({
      settlement,
      totals: { brut: total_brut, fba: total_fba, fbm: total_fbm, nb_orders: orders.size, nb_transactions: allTx.length },
      breakdown: breakdownArr,
      top_skus: topSkus,
      orders: ordersArr,
      reimbursements: reimbursementsEnriched,
      reimb_totals: reimbTotals,
      mouvements: mouvementsArr,
      mouv_totals: mouvTotals,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH — mettre à jour le statut LAUTOPAK d'un settlement
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { settlement_id, lautopak_status, lautopak_invoice_ref, lautopak_invoice_date, lautopak_notes } = body
    if (!settlement_id) return NextResponse.json({ erreur: 'settlement_id requis' }, { status: 400 })

    const update: any = {}
    if (lautopak_status !== undefined)       update.lautopak_status = lautopak_status
    if (lautopak_invoice_ref !== undefined)  update.lautopak_invoice_ref = lautopak_invoice_ref || null
    if (lautopak_invoice_date !== undefined) update.lautopak_invoice_date = lautopak_invoice_date || null
    if (lautopak_notes !== undefined)        update.lautopak_notes = lautopak_notes || null

    const { error } = await supabaseAdmin
      .from('amazon_settlements')
      .update(update)
      .eq('settlement_id', settlement_id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
