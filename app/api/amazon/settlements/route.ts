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

    return NextResponse.json({
      settlement,
      totals: { brut: total_brut, fba: total_fba, fbm: total_fbm, nb_orders: orders.size, nb_transactions: allTx.length },
      breakdown: breakdownArr,
      top_skus: topSkus,
      orders: ordersArr,
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
