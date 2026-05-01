import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadManualMappings } from '@/lib/amazon-mapping'
import { detectVariant } from '@/lib/amazon-inventory'
import { loadTractionForSettlement } from '@/lib/amazon-traction-snapshot'

// GET /api/amazon/profitabilite?id=settlement_id
//
// Calcule la marge par PKCode pour un settlement, avec drill-down par
// variante Amazon (SKU pack vs unité simple).
//
// Pour chaque PKCode :
//   - Revenu        = somme Order Principal des transactions du settlement
//   - Refunds       = somme Refund Principal (négatif)
//   - Coûtant       = qty × prix_coutant Traction (snapshot du settlement)
//   - Commissions   = somme par order_item_code des Commission +
//                     FBAPerUnitFulfillmentFee + ShippingChargeback +
//                     ShippingHB + RefundCommission
//   - FBA Fees      = Storage Fee + RemovalComplete (alloués au prorata
//                     des ventes, car globaux par settlement)
//   - Pub           = TransactionTotalAmount (alloué au prorata)
//   - Transport     = qty_lautopak × cout_unitaire (de amazon_couts_transport)
//   - Marge $       = Revenu + Refunds - Coûtant - Commissions - FBA - Pub - Transport
//   - Marge %       = Marge / Revenu

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ erreur: 'id settlement requis' }, { status: 400 })

  try {
    const { data: s } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end, deposit_date, total_amount')
      .eq('settlement_id', id)
      .maybeSingle()
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    // Charger toutes les transactions
    const tx: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_transactions')
        .select('sku, traction_code, quantity_purchased, amount, amount_type, amount_description, transaction_type, order_item_code')
        .eq('settlement_id', id)
        .range(from, from + 999)
      if (error) throw error
      tx.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    const isOrder = (t: any) => t.transaction_type === 'Order'
    const isRefund = (t: any) => t.transaction_type === 'Refund'
    const desc = (t: any) => t.amount_description || ''
    const sumWhere = (fn: (t: any) => boolean) =>
      Number(tx.filter(fn).reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))

    // Frais globaux (alloués au prorata)
    const fbaStockage = sumWhere(t => t.amount_type === 'Storage Fee' || desc(t) === 'Storage Fee')
    const fbaAutres = sumWhere(t => t.amount_type === 'RemovalComplete' || desc(t) === 'RemovalComplete')
    const pubTotale = sumWhere(t => t.amount_type === 'Cost of Advertising' || desc(t) === 'TransactionTotalAmount')
    const fraisGlobauxTotal = fbaStockage + fbaAutres + pubTotale  // négatifs

    // Charger les multi-mappings et coûtants Traction
    const manualMappings = await loadManualMappings()
    const tractionRows = await loadTractionForSettlement(id, { code_ligne_in: ['AMA', 'FBA', 'FBM'] })
    // 3 niveaux d'index pour maximiser les chances de trouver le coûtant :
    //   1. par pk_code exact (priorité haute)
    //   2. par base (= pk_code sans préfixe FBA-/FBM-/HUB-)
    //   3. par wide_base (= base sans le préfixe A initial parfois ajouté)
    const coutantByPkExact = new Map<string, number>()
    const coutantByBase = new Map<string, number>()
    const coutantByWideBase = new Map<string, number>()
    const descByPk = new Map<string, string>()
    function wideBase(b: string): string {
      const m = /^[Aa](\d.*)$/.exec(b)
      return m ? m[1] : b
    }
    for (const r of tractionRows) {
      const v = detectVariant(r.pk_code)
      const c = Number(r.prix_coutant || 0)
      if (c > 0) {
        if (!coutantByPkExact.has(r.pk_code)) coutantByPkExact.set(r.pk_code, c)
        if (!coutantByBase.has(v.base)) coutantByBase.set(v.base, c)
        const wb = wideBase(v.base)
        if (!coutantByWideBase.has(wb)) coutantByWideBase.set(wb, c)
      }
      if (!descByPk.has(v.base) && r.desc_fra) descByPk.set(v.base, r.desc_fra)
    }
    // Charger les coûtants manuels (saisis par l'utilisateur, prioritaires)
    const { data: coutsManuelsRows } = await supabaseAdmin
      .from('amazon_couts_manuels')
      .select('pk_code, cout_unitaire')
    const coutsManuelsByPk = new Map<string, number>()
    for (const r of coutsManuelsRows || []) {
      coutsManuelsByPk.set(r.pk_code, Number(r.cout_unitaire || 0))
    }
    function findCoutant(pk_code: string): { value: number; source: 'manuel'|'pk_exact'|'base'|'wide_base'|'aucun' } {
      // Priorité 1 : saisie manuelle (override Traction)
      if (coutsManuelsByPk.has(pk_code)) {
        return { value: coutsManuelsByPk.get(pk_code)!, source: 'manuel' }
      }
      // Priorité 2-4 : recherche dans Traction
      if (coutantByPkExact.has(pk_code)) return { value: coutantByPkExact.get(pk_code)!, source: 'pk_exact' }
      const base = detectVariant(pk_code).base
      if (coutantByBase.has(base)) return { value: coutantByBase.get(base)!, source: 'base' }
      const wb = wideBase(base)
      if (coutantByWideBase.has(wb)) return { value: coutantByWideBase.get(wb)!, source: 'wide_base' }
      return { value: 0, source: 'aucun' }
    }

    // Charger les coûts de transport par pk_code (saisis manuellement)
    const { data: transportRows } = await supabaseAdmin
      .from('amazon_couts_transport')
      .select('pk_code, cout_unitaire')
    const transportByPk = new Map<string, number>()
    for (const r of transportRows || []) {
      transportByPk.set(r.pk_code, Number(r.cout_unitaire || 0))
    }

    // Charger les noms produits depuis le snapshot FBA
    const allSkus = Array.from(new Set(tx.map((t: any) => t.sku).filter(Boolean))) as string[]
    const productNames = new Map<string, string>()
    if (allSkus.length > 0) {
      for (let i = 0; i < allSkus.length; i += 500) {
        const batch = allSkus.slice(i, i + 500)
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, product_name')
          .in('sku', batch)
        for (const r of data || []) {
          if (!productNames.has(r.sku) && r.product_name) productNames.set(r.sku, r.product_name)
        }
      }
    }

    // Helper : résoudre un SKU Amazon vers son pk_code Traction (avec multi-mapping)
    function resolvePkCode(sku: string, traction_code: string | null): { pk_code: string; multiplier: number; manual: boolean } {
      const manual = manualMappings.get(sku)
      if (manual && manual.length > 0) {
        return { pk_code: manual[0].pk_code, multiplier: manual[0].multiplier, manual: true }
      }
      const tc = traction_code || sku
      return { pk_code: tc, multiplier: 1, manual: false }
    }

    // Agréger les transactions par order_item_code pour grouper Order Principal
    // avec ses commissions associées (Commission, FBAPerUnitFulfillmentFee, etc.)
    const orderCommissionDescs = ['Commission','FBAPerUnitFulfillmentFee','MarketplaceFacilitatorTax-Principal','MarketplaceFacilitatorTax-Shipping','ShippingChargeback','ShippingHB']
    const refundCommissionDescs = ['Commission','RefundCommission','MarketplaceFacilitatorTax-Principal','MarketplaceFacilitatorTax-Shipping','ShippingChargeback']

    // Structure par PKCode
    interface LignePk {
      pk_code: string
      product_name: string | null
      qty_amazon_total: number          // qté Amazon vendue (avant multiplier)
      qty_lautopak_total: number         // qté physique (avec multiplier)
      qty_amazon_refund: number          // qté Amazon remboursée
      revenu: number                     // Order Principal
      refunds: number                    // Refund Principal (négatif)
      coutant: number                    // qty_lautopak × prix_coutant (négatif)
      commissions_orders: number         // négatif
      commissions_refunds: number        // positif (Amazon nous rend)
      transport: number                  // négatif
      // Allocation au prorata (ajoutés en seconde passe)
      fba_fees: number                   // négatif
      pub: number                        // négatif
      // Variantes Amazon regroupées sous ce pk_code
      variantes: Map<string, { qty_amazon: number; qty_amazon_refund: number; multiplier: number; revenu: number; refunds: number }>
    }
    const byPk = new Map<string, LignePk>()

    function getOrCreate(pk_code: string): LignePk {
      let ex = byPk.get(pk_code)
      if (!ex) {
        const base = detectVariant(pk_code).base
        ex = {
          pk_code,
          product_name: descByPk.get(base) || null,
          qty_amazon_total: 0, qty_lautopak_total: 0, qty_amazon_refund: 0,
          revenu: 0, refunds: 0, coutant: 0,
          commissions_orders: 0, commissions_refunds: 0,
          transport: 0,
          fba_fees: 0, pub: 0,
          variantes: new Map(),
        }
        byPk.set(pk_code, ex)
      }
      return ex
    }

    function addVariante(line: LignePk, sku: string, qtyAmazon: number, qtyAmazonRefund: number, multiplier: number, revenuPart: number, refundsPart: number) {
      let v = line.variantes.get(sku)
      if (!v) {
        v = { qty_amazon: 0, qty_amazon_refund: 0, multiplier, revenu: 0, refunds: 0 }
        line.variantes.set(sku, v)
      }
      v.qty_amazon += qtyAmazon
      v.qty_amazon_refund += qtyAmazonRefund
      v.revenu += revenuPart
      v.refunds += refundsPart
    }

    // 1ère passe : Orders et Refunds par SKU
    for (const t of tx) {
      const sku = t.sku
      if (!sku) continue
      const isP = desc(t) === 'Principal'
      const isOrderItem = isOrder(t) && isP
      const isRefundItem = isRefund(t) && isP
      const isOrderCommission = isOrder(t) && orderCommissionDescs.includes(desc(t))
      const isRefundCommission = isRefund(t) && refundCommissionDescs.includes(desc(t))
      if (!isOrderItem && !isRefundItem && !isOrderCommission && !isRefundCommission) continue

      const { pk_code, multiplier } = resolvePkCode(sku, t.traction_code || null)
      const line = getOrCreate(pk_code)
      const amount = Number(t.amount || 0)

      if (isOrderItem) {
        const qty = Number(t.quantity_purchased || 0)
        line.qty_amazon_total += qty
        line.qty_lautopak_total += qty * multiplier
        line.revenu += amount
        if (!line.product_name) line.product_name = productNames.get(sku) || null
        addVariante(line, sku, qty, 0, multiplier, amount, 0)
      } else if (isRefundItem) {
        // Refund Principal n'a pas de quantity → 1 ligne = 1 unité présumée
        line.qty_amazon_refund += 1
        line.refunds += amount   // négatif
        if (!line.product_name) line.product_name = productNames.get(sku) || null
        addVariante(line, sku, 0, 1, multiplier, 0, amount)
      } else if (isOrderCommission) {
        line.commissions_orders += amount
      } else if (isRefundCommission) {
        line.commissions_refunds += amount
      }
    }

    // 2ème passe : coûtant, transport, frais globaux au prorata
    const totalRevenuTous = [...byPk.values()].reduce((s, l) => s + l.revenu, 0)
    const skusSansCoutant: string[] = []
    const coutantSourceByPk = new Map<string, string>()
    for (const line of byPk.values()) {
      const base = detectVariant(line.pk_code).base
      const { value: coutantUnit, source } = findCoutant(line.pk_code)
      coutantSourceByPk.set(line.pk_code, source)
      if (coutantUnit === 0 && line.qty_lautopak_total > 0) skusSansCoutant.push(line.pk_code)
      const transportUnit = transportByPk.get(line.pk_code) || transportByPk.get(base) || 0
      line.coutant = -1 * line.qty_lautopak_total * coutantUnit
      line.transport = -1 * line.qty_lautopak_total * transportUnit
      const part = totalRevenuTous > 0 ? line.revenu / totalRevenuTous : 0
      line.fba_fees = (fbaStockage + fbaAutres) * part
      line.pub = pubTotale * part
    }

    // Format de sortie
    const lignes = [...byPk.values()].map(l => {
      const ventesNet = Number((l.revenu + l.refunds).toFixed(2))
      const margeAvantTransport = Number((ventesNet + l.coutant + l.commissions_orders + l.commissions_refunds + l.fba_fees + l.pub).toFixed(2))
      const margeBrute = Number((margeAvantTransport + l.transport).toFixed(2))
      const { value: coutantUnit } = findCoutant(l.pk_code)
      const coutantSource = coutantSourceByPk.get(l.pk_code) || 'aucun'
      const margePct = ventesNet > 0 ? Number(((margeBrute / ventesNet) * 100).toFixed(1)) : null
      const variantes = [...l.variantes.entries()].map(([sku, v]) => ({
        amazon_sku: sku,
        qty_amazon: v.qty_amazon,
        qty_amazon_refund: v.qty_amazon_refund,
        multiplier: v.multiplier,
        revenu: Number(v.revenu.toFixed(2)),
        refunds: Number(v.refunds.toFixed(2)),
      })).sort((a, b) => b.revenu - a.revenu)
      return {
        pk_code: l.pk_code,
        product_name: l.product_name,
        qty_amazon: l.qty_amazon_total,
        qty_lautopak: l.qty_lautopak_total,
        qty_refund: l.qty_amazon_refund,
        revenu: Number(l.revenu.toFixed(2)),
        refunds: Number(l.refunds.toFixed(2)),
        ventes_net: ventesNet,
        coutant: Number(l.coutant.toFixed(2)),
        coutant_unitaire: coutantUnit,
        coutant_source: coutantSource,                                        // 'manuel' | 'pk_exact' | 'base' | 'wide_base' | 'aucun'
        coutant_manquant: coutantUnit === 0 && l.qty_lautopak_total > 0,
        commissions: Number((l.commissions_orders + l.commissions_refunds).toFixed(2)),
        fba_fees: Number(l.fba_fees.toFixed(2)),
        pub: Number(l.pub.toFixed(2)),
        transport: Number(l.transport.toFixed(2)),
        transport_unitaire: transportByPk.get(l.pk_code) || transportByPk.get(detectVariant(l.pk_code).base) || 0,
        marge_brute: margeBrute,
        marge_pct: margePct,
        variantes,
        nb_variantes: variantes.length,
      }
    }).sort((a, b) => b.marge_brute - a.marge_brute)

    // Totaux
    const totaux = {
      revenu: Number(lignes.reduce((s, l) => s + l.revenu, 0).toFixed(2)),
      refunds: Number(lignes.reduce((s, l) => s + l.refunds, 0).toFixed(2)),
      ventes_net: Number(lignes.reduce((s, l) => s + l.ventes_net, 0).toFixed(2)),
      coutant: Number(lignes.reduce((s, l) => s + l.coutant, 0).toFixed(2)),
      commissions: Number(lignes.reduce((s, l) => s + l.commissions, 0).toFixed(2)),
      fba_fees: Number(lignes.reduce((s, l) => s + l.fba_fees, 0).toFixed(2)),
      pub: Number(lignes.reduce((s, l) => s + l.pub, 0).toFixed(2)),
      transport: Number(lignes.reduce((s, l) => s + l.transport, 0).toFixed(2)),
      marge_brute: Number(lignes.reduce((s, l) => s + l.marge_brute, 0).toFixed(2)),
      qty_amazon: lignes.reduce((s, l) => s + l.qty_amazon, 0),
      qty_lautopak: lignes.reduce((s, l) => s + l.qty_lautopak, 0),
    }
    const margePctGlobal = totaux.ventes_net > 0 ? Number(((totaux.marge_brute / totaux.ventes_net) * 100).toFixed(1)) : null

    return NextResponse.json({
      settlement: s,
      lignes,
      totaux: { ...totaux, marge_pct: margePctGlobal },
      frais_globaux: {
        fba_stockage: fbaStockage,
        fba_autres: fbaAutres,
        pub_totale: pubTotale,
        total: fraisGlobauxTotal,
      },
      skus_sans_coutant: skusSansCoutant,
      nb_skus_sans_coutant: skusSansCoutant.length,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
