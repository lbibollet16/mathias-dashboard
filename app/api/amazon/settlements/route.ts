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

    // ─── Remboursements du settlement (attribution unique + balance check) ─
    //
    // Stratégie:
    //   1. On trie tous les settlements par settlement_end croissant
    //   2. Chaque remboursement est attribué au premier settlement dont
    //      settlement_end >= approval_date (fenêtre ouverte à gauche par
    //      settlement_end du settlement PRÉCÉDENT).
    //   3. Ceci garantit qu'un même remboursement n'est attribué qu'à UN
    //      seul settlement, quelque soit l'ordre d'import.
    //
    let reimbs: any[] = []
    if (settlement.settlement_end) {
      const { data: allSettlements } = await supabaseAdmin
        .from('amazon_settlements')
        .select('settlement_id, settlement_end')
        .order('settlement_end', { ascending: true })
      const idx = (allSettlements || []).findIndex((s: any) => s.settlement_id === settlement.settlement_id)
      const prevEnd = idx > 0 ? (allSettlements as any[])[idx - 1].settlement_end : null

      let q = supabaseAdmin
        .from('amazon_reimbursements')
        .select('*')
        .lte('approval_date', settlement.settlement_end)
      if (prevEnd) q = q.gt('approval_date', prevEnd)
      const { data: rData } = await q.order('approval_date', { ascending: false })
      reimbs = rData || []
    }

    // Vérification de balance: $ remboursé dans payments (FBA Inventory
    // Reimbursement) vs $ total des remboursements CSV attribués.
    let moneyInPayments = 0
    for (const t of allTx) {
      if (t.amount_type === 'FBA Inventory Reimbursement') moneyInPayments += Number(t.amount || 0)
    }
    const moneyInCsv = reimbs.reduce((a: number, r: any) => a + Number(r.amount_total || 0), 0)
    const balanceDelta = moneyInPayments - moneyInCsv
    const balanceOk = Math.abs(balanceDelta) < 0.01

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
    // Source PRIMAIRE = le fichier payments (garanti d'être complet pour le settlement)
    //
    // net_to_deduct = qty_sold - qty_returned + qty_lost_estimated
    //   qty_sold            = sum quantity_purchased pour Order / ItemPrice / Principal
    //   qty_returned        = 1 par ligne Refund / ItemPrice / Principal
    //   qty_lost_estimated  = ($ FBA Inventory Reimbursement / prix unitaire) arrondi
    //                         prix unitaire = amount_per_unit d'un CSV historique (même SKU)
    //                         fallback = prix coûtant Traction
    //                         fallback = 1 par ligne payment
    type Mouvement = {
      sku: string; traction_code: string | null; description: string | null;
      sold: number; returned: number; lost: number; lost_amount: number; lost_method: string;
      net: number; coutant: number; valeur_net: number;
    }
    const mouvements = new Map<string, Mouvement>()
    const ensure = (sku: string, tractionCode: string | null): Mouvement => {
      if (!mouvements.has(sku)) {
        mouvements.set(sku, {
          sku, traction_code: tractionCode,
          description: null,
          sold: 0, returned: 0, lost: 0, lost_amount: 0, lost_method: '',
          net: 0, coutant: 0, valeur_net: 0,
        })
      }
      const m = mouvements.get(sku)!
      if (!m.traction_code && tractionCode) m.traction_code = tractionCode
      return m
    }

    // 1) Ventes + retours depuis payments
    for (const t of allTx) {
      if (!t.sku) continue
      if (t.amount_type !== 'ItemPrice' || t.amount_description !== 'Principal') continue
      const m = ensure(t.sku, t.traction_code)
      if (t.transaction_type === 'Order') {
        m.sold += Number(t.quantity_purchased || 1)
      } else if (t.transaction_type === 'Refund') {
        const q = Number(t.quantity_purchased || 0)
        m.returned += (q > 0 ? q : 1)
      }
    }

    // 2) Remboursements FBA depuis payments (groupés par SKU)
    type FbaReimb = { sku: string; amount_net: number; lines: number; reasons: Set<string>; traction_code: string | null }
    const fbaReimbBySku = new Map<string, FbaReimb>()
    for (const t of allTx) {
      if (t.amount_type !== 'FBA Inventory Reimbursement') continue
      if (!t.sku) continue
      if (!fbaReimbBySku.has(t.sku)) {
        fbaReimbBySku.set(t.sku, { sku: t.sku, amount_net: 0, lines: 0, reasons: new Set(), traction_code: t.traction_code })
      }
      const e = fbaReimbBySku.get(t.sku)!
      e.amount_net += Number(t.amount || 0)
      e.lines++
      if (t.amount_description) e.reasons.add(t.amount_description)
      if (!e.traction_code && t.traction_code) e.traction_code = t.traction_code
    }

    // 3) CSV du settlement (fenêtre attribuée exclusivement) → qty_cash par SKU
    const csvLostBySku = new Map<string, { qty: number; amount: number; lines: number }>()
    for (const r of reimbursementsEnriched) {
      if (!r.sku) continue
      const q = Number(r.qty_cash || 0)
      if (q <= 0) continue
      if (!csvLostBySku.has(r.sku)) csvLostBySku.set(r.sku, { qty: 0, amount: 0, lines: 0 })
      const e = csvLostBySku.get(r.sku)!
      e.qty += q
      e.amount += Number(r.amount_total || 0)
      e.lines++
    }

    // 4) Fallback: prix unitaire historique (si CSV window ne couvre pas ce SKU)
    const unitPriceBySku = new Map<string, number>()
    const skusFallback = Array.from(fbaReimbBySku.keys()).filter(s => !csvLostBySku.has(s))
    if (skusFallback.length > 0) {
      const { data: anyReimbs } = await supabaseAdmin
        .from('amazon_reimbursements')
        .select('sku, amount_per_unit')
        .in('sku', skusFallback)
        .gt('amount_per_unit', 0)
        .order('approval_date', { ascending: false })
      for (const r of anyReimbs || []) {
        if (r.sku && !unitPriceBySku.has(r.sku)) {
          unitPriceBySku.set(r.sku, Number(r.amount_per_unit))
        }
      }
    }

    // 5) Construire la colonne "lost" par SKU, en PRIORISANT le CSV
    //    Boucle sur l'union des SKU apparaissant dans payments FBA ou dans CSV window
    const skuUniverse = new Set<string>([...fbaReimbBySku.keys(), ...csvLostBySku.keys()])
    for (const sku of skuUniverse) {
      const paymentsData = fbaReimbBySku.get(sku)
      const csvData = csvLostBySku.get(sku)
      const tractionCode = paymentsData?.traction_code || reimbursementsEnriched.find((r:any)=>r.sku===sku)?.traction_code || null
      const m = ensure(sku, tractionCode)

      // PRIORITÉ 1: CSV du settlement (source exacte fournie par Amazon)
      if (csvData && csvData.qty > 0) {
        m.lost = csvData.qty
        m.lost_amount = paymentsData ? paymentsData.amount_net : csvData.amount
        m.lost_method = 'csv_exact'
        continue
      }

      // PRIORITÉ 2: estimation depuis le payments (CSV ne couvre pas)
      if (paymentsData && paymentsData.amount_net > 0) {
        m.lost_amount = paymentsData.amount_net
        let unitPrice = unitPriceBySku.get(sku) || 0
        let method = 'csv_historique'
        if (unitPrice === 0 && paymentsData.traction_code) {
          const coutant = coutantMap.get(paymentsData.traction_code) || 0
          if (coutant > 0) { unitPrice = coutant; method = 'coutant_traction' }
        }
        if (unitPrice > 0) {
          m.lost = Math.max(1, Math.round(paymentsData.amount_net / unitPrice))
          m.lost_method = method
        } else {
          m.lost = paymentsData.lines
          m.lost_method = 'assume_1_par_ligne'
        }
      }
    }

    // 5) Finaliser net + valeur (en utilisant coutant Traction)
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
      acc.lost_amount += m.lost_amount
      acc.net += m.net
      acc.valeur_net += m.valeur_net
      return acc
    }, { sold: 0, returned: 0, lost: 0, lost_amount: 0, net: 0, valeur_net: 0 })

    // Qualité de la dérivation qty pour les pertes
    const allLostMouvs = Array.from(mouvements.values()).filter(m => m.lost > 0)
    const lostQualite = {
      total_amount: moneyInPayments,
      sku_count: allLostMouvs.length,
      sku_csv_exact: allLostMouvs.filter(m => m.lost_method === 'csv_exact').length,
      sku_avec_prix: allLostMouvs.filter(m => m.lost_method === 'csv_historique' || m.lost_method === 'coutant_traction').length,
      sku_sans_prix: allLostMouvs.filter(m => m.lost_method === 'assume_1_par_ligne').length,
    }

    return NextResponse.json({
      settlement,
      totals: { brut: total_brut, fba: total_fba, fbm: total_fbm, nb_orders: orders.size, nb_transactions: allTx.length },
      breakdown: breakdownArr,
      top_skus: topSkus,
      orders: ordersArr,
      reimbursements: reimbursementsEnriched,
      reimb_totals: reimbTotals,
      reimb_balance: {
        money_in_payments: moneyInPayments,
        money_in_csv: moneyInCsv,
        delta: balanceDelta,
        balanced: balanceOk,
      },
      lost_qualite: lostQualite,
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
