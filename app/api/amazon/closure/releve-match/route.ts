import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/amazon/closure/releve-match?id=XXX
//
// Reproduit la structure du relevé de paiement papier Amazon depuis les
// amount_description du TSV settlement. Permet de vérifier ligne à ligne
// que ton TSV matche bien le document imprimé.
//
// Mapping (vérifié sur un settlement réel) :
//   VENTES
//     • Frais produit          = Principal [Orders]
//     • Expédition             = Shipping + ShippingTax + GiftWrap + GiftWrapTax [Orders]
//     • Remboursements stock   = REVERSAL_REIMBURSEMENT + WAREHOUSE_DAMAGE + WAREHOUSE_LOST
//   REMBOURSEMENTS
//     • Dépenses remboursées   = tout positif [Refunds] hors Principal/Shipping
//     • Ventes remboursées - Frais produit = Principal [Refunds]
//     • Ventes remboursées - Expédition    = Shipping + ShippingTax [Refunds]
//   DÉPENSES
//     • Rabais promotionnels   = Promotion [Orders]
//     • Frais FBA - Stockage   = Storage Fee
//     • Frais FBA - Autre      = RemovalComplete
//     • Publicité              = TransactionTotalAmount (Cost of Advertising)
//     • Commissions Amazon     = Commission + FBAPerUnitFulfillmentFee
//                              + MarketplaceFacilitatorTax-Principal + MarketplaceFacilitatorTax-Shipping
//                              + ShippingChargeback + ShippingHB + RefundCommission
//     • Remb. inversés FBA     = COMPENSATED_CLAWBACK
//   = PROFITS NETS (= somme totale du TSV = dépôt bancaire)

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

  try {
    const { data: s } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end, deposit_date, total_amount')
      .eq('settlement_id', id)
      .maybeSingle()
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    // Toutes les transactions du settlement
    const tx: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_transactions')
        .select('transaction_type, amount_type, amount_description, amount')
        .eq('settlement_id', id)
        .range(from, from + 999)
      if (error) throw error
      tx.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    const totalTx = Number(tx.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))

    // Breakdown TSV complet par (amount_description, transaction_type)
    const breakdownMap = new Map<string, { amount_description: string; transaction_type: string; amount_type: string; count: number; total: number }>()
    for (const t of tx) {
      const key = `${t.amount_description || '(null)'}|${t.transaction_type || '(null)'}|${t.amount_type || '(null)'}`
      const ex = breakdownMap.get(key) || {
        amount_description: t.amount_description || '(null)',
        transaction_type: t.transaction_type || '(null)',
        amount_type: t.amount_type || '(null)',
        count: 0, total: 0,
      }
      ex.count++
      ex.total += Number(t.amount || 0)
      breakdownMap.set(key, ex)
    }
    const breakdown = [...breakdownMap.values()].map(b => ({ ...b, total: Number(b.total.toFixed(2)) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))

    // Helpers
    const sumWhere = (fn: (t: any) => boolean) =>
      Number(tx.filter(fn).reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))

    // Retourne aussi la liste des composants (breakdown détaillé) d'une catégorie
    function composantsOf(fn: (t: any) => boolean) {
      const m = new Map<string, { amount_description: string; transaction_type: string; count: number; total: number }>()
      for (const t of tx) {
        if (!fn(t)) continue
        const k = `${t.amount_description || '(null)'}|${t.transaction_type || '(null)'}`
        const ex = m.get(k) || { amount_description: t.amount_description || '(null)', transaction_type: t.transaction_type || '(null)', count: 0, total: 0 }
        ex.count++
        ex.total += Number(t.amount || 0)
        m.set(k, ex)
      }
      return [...m.values()].map(b => ({ ...b, total: Number(b.total.toFixed(2)) })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    }
    const isOrder = (t: any) => t.transaction_type === 'Order'
    const isRefund = (t: any) => t.transaction_type === 'Refund'
    const desc = (t: any) => t.amount_description || ''
    const type = (t: any) => t.amount_type || ''

    // === VENTES ===
    const frais_produit = sumWhere(t => isOrder(t) && desc(t) === 'Principal')
    const expedition_ventes = sumWhere(t => isOrder(t) && ['Shipping','ShippingTax','GiftWrap','GiftWrapTax'].includes(desc(t)))
    const remb_stock_fba = sumWhere(t => ['REVERSAL_REIMBURSEMENT','WAREHOUSE_DAMAGE','WAREHOUSE_LOST','WAREHOUSE_DAMAGE_EXCEPTION','WAREHOUSE_LOST_MANIFEST'].includes(type(t)) || ['REVERSAL_REIMBURSEMENT','WAREHOUSE_DAMAGE','WAREHOUSE_LOST'].includes(desc(t)))
    const ventes_total = Number((frais_produit + expedition_ventes + remb_stock_fba).toFixed(2))

    // === REMBOURSEMENTS ===
    const ventes_remb_produit = sumWhere(t => isRefund(t) && desc(t) === 'Principal')
    const ventes_remb_expedition = sumWhere(t => isRefund(t) && ['Shipping','ShippingTax'].includes(desc(t)))
    const ventes_remb_total = Number((ventes_remb_produit + ventes_remb_expedition).toFixed(2))
    // Dépenses remboursées = positifs côté Refunds hors Principal/Shipping
    const depenses_rembourses = sumWhere(t => isRefund(t) && Number(t.amount || 0) > 0 && !['Principal','Shipping','ShippingTax'].includes(desc(t)))
    const remboursements_total = Number((depenses_rembourses + ventes_remb_total).toFixed(2))

    // === DÉPENSES ===
    const rabais_promo = sumWhere(t => isOrder(t) && (desc(t) === 'Promotion' || desc(t).toLowerCase().includes('promo')))
    const storage_fee = sumWhere(t => type(t) === 'Storage Fee' || desc(t) === 'Storage Fee')
    const removal_complete = sumWhere(t => type(t) === 'RemovalComplete' || desc(t) === 'RemovalComplete')
    const frais_fba_total = Number((storage_fee + removal_complete).toFixed(2))
    const publicite = sumWhere(t => type(t) === 'Cost of Advertising' || desc(t) === 'TransactionTotalAmount')
    // Commissions Amazon : tout ce qui reste côté fees
    const commissionDescs = ['Commission','FBAPerUnitFulfillmentFee','MarketplaceFacilitatorTax-Principal','MarketplaceFacilitatorTax-Shipping','ShippingChargeback','ShippingHB','RefundCommission']
    const commissions = sumWhere(t => commissionDescs.includes(desc(t)))
    const remb_inverses = sumWhere(t => type(t) === 'COMPENSATED_CLAWBACK' || desc(t) === 'COMPENSATED_CLAWBACK')
    const depenses_total = Number((rabais_promo + frais_fba_total + publicite + commissions + remb_inverses).toFixed(2))

    // Reste non classé (pour détecter les catégories non matchées)
    const classifiedSum = ventes_total + remboursements_total + depenses_total
    const reste_non_classe = Number((totalTx - classifiedSum).toFixed(2))

    // Filtres utilisés (pour produire les composants de chaque ligne)
    const fFraisProduit = (t: any) => isOrder(t) && desc(t) === 'Principal'
    const fExpedition = (t: any) => isOrder(t) && ['Shipping','ShippingTax','GiftWrap','GiftWrapTax'].includes(desc(t))
    const fRembStockFba = (t: any) => ['REVERSAL_REIMBURSEMENT','WAREHOUSE_DAMAGE','WAREHOUSE_LOST','WAREHOUSE_DAMAGE_EXCEPTION','WAREHOUSE_LOST_MANIFEST'].includes(type(t)) || ['REVERSAL_REIMBURSEMENT','WAREHOUSE_DAMAGE','WAREHOUSE_LOST'].includes(desc(t))
    const fVentesRembProduit = (t: any) => isRefund(t) && desc(t) === 'Principal'
    const fVentesRembExp = (t: any) => isRefund(t) && ['Shipping','ShippingTax'].includes(desc(t))
    const fDepensesRemb = (t: any) => isRefund(t) && Number(t.amount || 0) > 0 && !['Principal','Shipping','ShippingTax'].includes(desc(t))
    const fRabaisPromo = (t: any) => isOrder(t) && (desc(t) === 'Promotion' || desc(t).toLowerCase().includes('promo'))
    const fStorageFee = (t: any) => type(t) === 'Storage Fee' || desc(t) === 'Storage Fee'
    const fRemovalComplete = (t: any) => type(t) === 'RemovalComplete' || desc(t) === 'RemovalComplete'
    const fPublicite = (t: any) => type(t) === 'Cost of Advertising' || desc(t) === 'TransactionTotalAmount'
    const fCommissions = (t: any) => commissionDescs.includes(desc(t))
    const fRembInverses = (t: any) => type(t) === 'COMPENSATED_CLAWBACK' || desc(t) === 'COMPENSATED_CLAWBACK'

    // Union de tous les filtres pour identifier ce qui N'EST PAS classé
    const isClassifie = (t: any) =>
      fFraisProduit(t) || fExpedition(t) || fRembStockFba(t)
      || fVentesRembProduit(t) || fVentesRembExp(t) || fDepensesRemb(t)
      || fRabaisPromo(t) || fStorageFee(t) || fRemovalComplete(t)
      || fPublicite(t) || fCommissions(t) || fRembInverses(t)
    const non_classes_composants = composantsOf((t: any) => !isClassifie(t))

    return NextResponse.json({
      settlement_id: s.settlement_id,
      settlement_start: s.settlement_start,
      settlement_end: s.settlement_end,
      deposit_date: s.deposit_date,
      settlement_total: Number(s.total_amount || 0),
      profits_nets_calcules: totalTx,
      ventes: {
        total: ventes_total,
        frais_produit, frais_produit_composants: composantsOf(fFraisProduit),
        expedition: expedition_ventes, expedition_composants: composantsOf(fExpedition),
        remboursements_stock_fba: remb_stock_fba, remboursements_stock_fba_composants: composantsOf(fRembStockFba),
      },
      remboursements: {
        total: remboursements_total,
        depenses_rembourses, depenses_rembourses_composants: composantsOf(fDepensesRemb),
        ventes_remboursees_total: ventes_remb_total,
        ventes_remboursees_expedition: ventes_remb_expedition, ventes_remb_exp_composants: composantsOf(fVentesRembExp),
        ventes_remboursees_frais_produit: ventes_remb_produit, ventes_remb_produit_composants: composantsOf(fVentesRembProduit),
      },
      depenses: {
        total: depenses_total,
        rabais_promotionnels: rabais_promo, rabais_composants: composantsOf(fRabaisPromo),
        frais_fba_total,
        frais_fba_stockage: storage_fee, frais_fba_stockage_composants: composantsOf(fStorageFee),
        frais_fba_autre: removal_complete, frais_fba_autre_composants: composantsOf(fRemovalComplete),
        publicite, publicite_composants: composantsOf(fPublicite),
        commissions_amazon: commissions, commissions_composants: composantsOf(fCommissions),
        remboursements_inverses_fba: remb_inverses, remb_inverses_composants: composantsOf(fRembInverses),
      },
      reste_non_classe,
      non_classes_composants,
      breakdown_complet: breakdown,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
