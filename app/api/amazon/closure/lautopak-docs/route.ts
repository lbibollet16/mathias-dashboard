import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadManualMappings } from '@/lib/amazon-mapping'

// GET /api/amazon/closure/lautopak-docs?id=XXX
//
// Génère automatiquement les 4 listes que l'utilisateur doit saisir
// dans LAUTOPAK pour fermer un settlement (workflow v2).
//
// Logique comptable :
//   • Doc 1 — VENTES : Orders Principal du settlement (sortie de stock + revenu)
//   • Doc 2 — NOTE CRÉDIT RETOURS SELLABLE : croisement Refund Principal du
//             settlement × Customer Returns disposition=SELLABLE (entrée stock)
//   • Doc 3 — NOTE CRÉDIT PERTES/DOMMAGES : Reimbursements cash du settlement
//             (perte définitive, $ rendu par Amazon)
//   • Doc 4 — AJUSTEMENT INVENTAIRE : écarts audits AMA mensuel + FBM ce
//             settlement (corrections après comptage physique)
//
// Le reste (commissions, FBA fees, pub, taxes, expédition, refund commission,
// rabais promo) va dans le compte agrégé "Coût des ventes Amazon" — exposé
// dans `couts_amazon` ci-dessous mais PAS dans une facture LAUTOPAK.

interface LigneSku {
  sku: string
  pk_code: string | null
  product_name: string | null
  qty: number
  amount: number
  prix_unitaire: number
  notes?: string
}

interface DocLautopak {
  doc_type: 'ventes' | 'note_credit_retours' | 'note_credit_pertes' | 'ajust_audit'
  label: string
  lignes: LigneSku[]
  total: number
  numero_facture: string | null
  date_facture: string | null
  saisi_le: string | null
  saisi_par: string | null
  notes_saisie: string | null
}

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

    // Charger toutes les transactions du settlement
    const tx: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_transactions')
        .select('sku, traction_code, quantity_purchased, amount, amount_type, amount_description, transaction_type, posted_date')
        .eq('settlement_id', id)
        .range(from, from + 999)
      if (error) throw error
      tx.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // Helpers
    const isOrder = (t: any) => t.transaction_type === 'Order'
    const isRefund = (t: any) => t.transaction_type === 'Refund'
    const desc = (t: any) => t.amount_description || ''
    const sumWhere = (fn: (t: any) => boolean) =>
      Number(tx.filter(fn).reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))

    // Récupérer les noms produit depuis le dernier snapshot FBA
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

    // ─── DOC 1 — VENTES (Orders Principal) ─────────────────────────────────
    const ordersPrincipal = tx.filter((t: any) => isOrder(t) && desc(t) === 'Principal')
    const ventesBySku = new Map<string, LigneSku>()
    for (const t of ordersPrincipal) {
      const sku = t.sku || '(sans SKU)'
      const ex = ventesBySku.get(sku) || {
        sku, pk_code: t.traction_code || null, product_name: productNames.get(sku) || null,
        qty: 0, amount: 0, prix_unitaire: 0,
      }
      ex.qty += Number(t.quantity_purchased || 0)
      ex.amount += Number(t.amount || 0)
      if (!ex.pk_code && t.traction_code) ex.pk_code = t.traction_code
      ventesBySku.set(sku, ex)
    }
    const ventesLignes = [...ventesBySku.values()]
      .map(l => ({ ...l, prix_unitaire: l.qty > 0 ? Number((l.amount / l.qty).toFixed(2)) : 0 }))
      .sort((a, b) => b.amount - a.amount)
    const ventesTotal = Number(ventesLignes.reduce((s, l) => s + l.amount, 0).toFixed(2))

    // ─── DOC 2 — NOTE CRÉDIT RETOURS SELLABLE ──────────────────────────────
    // Refunds Principal du settlement (qty estimée = nb de lignes par SKU,
    // car Amazon ne renseigne pas quantity-purchased pour les Refund)
    const refundsPrincipal = tx.filter((t: any) => isRefund(t) && desc(t) === 'Principal')
    const refundsBySku = new Map<string, { count: number; amount_total: number }>()
    for (const t of refundsPrincipal) {
      const sku = t.sku || '(sans SKU)'
      const ex = refundsBySku.get(sku) || { count: 0, amount_total: 0 }
      ex.count++
      ex.amount_total += Number(t.amount || 0)   // négatif
      refundsBySku.set(sku, ex)
    }

    // Customer Returns SELLABLE pour ces SKUs (toutes périodes confondues
    // pour ne pas rater un retour en transit de la période précédente)
    const refundSkus = Array.from(refundsBySku.keys())
    const sellableBySku = new Map<string, number>()
    if (refundSkus.length > 0) {
      const { data: returns } = await supabaseAdmin
        .from('amazon_customer_returns')
        .select('sku, detailed_disposition, quantity, processed_in_settlement_id')
        .in('sku', refundSkus)
        .eq('detailed_disposition', 'SELLABLE')
        // Ne pas reprendre les retours déjà attribués à un AUTRE settlement
        .or(`processed_in_settlement_id.is.null,processed_in_settlement_id.eq.${id}`)
      for (const r of returns || []) {
        sellableBySku.set(r.sku, (sellableBySku.get(r.sku) || 0) + Number(r.quantity || 1))
      }
    }

    const retoursLignes: LigneSku[] = []
    for (const [sku, refundInfo] of refundsBySku) {
      const sellableQty = sellableBySku.get(sku) || 0
      const aRemettre = Math.min(sellableQty, refundInfo.count)
      if (aRemettre <= 0) continue
      const prixUnitaire = Number((refundInfo.amount_total / refundInfo.count).toFixed(2))
      retoursLignes.push({
        sku,
        pk_code: refundsPrincipal.find((t: any) => t.sku === sku)?.traction_code || null,
        product_name: productNames.get(sku) || null,
        qty: aRemettre,
        amount: Number((aRemettre * prixUnitaire).toFixed(2)),
        prix_unitaire: prixUnitaire,
        notes: `${aRemettre}/${refundInfo.count} remboursements revenus sellable`,
      })
    }
    retoursLignes.sort((a, b) => a.amount - b.amount)
    const retoursTotal = Number(retoursLignes.reduce((s, l) => s + l.amount, 0).toFixed(2))

    // ─── DOC 3 — NOTE CRÉDIT PERTES/DOMMAGES ───────────────────────────────
    // Reimbursements cash liés à ce settlement (Amazon a remboursé en $)
    const { data: reimbs } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select('reimbursement_id, sku, traction_code, product_name, reason, amount_per_unit, amount_total, quantity_reimbursed_cash')
      .eq('settlement_id', id)
      .gt('quantity_reimbursed_cash', 0)

    const pertesBySku = new Map<string, LigneSku>()
    for (const r of reimbs || []) {
      const sku = r.sku || '(sans SKU)'
      const qty = Number(r.quantity_reimbursed_cash || 0)
      const amt = Number(r.amount_total || 0)
      const ex = pertesBySku.get(sku) || {
        sku, pk_code: r.traction_code || null, product_name: r.product_name || null,
        qty: 0, amount: 0, prix_unitaire: Number(r.amount_per_unit || 0),
        notes: r.reason || '',
      }
      ex.qty += qty
      ex.amount += amt
      if (!ex.pk_code && r.traction_code) ex.pk_code = r.traction_code
      pertesBySku.set(sku, ex)
    }
    // Note de crédit = négatif (sortie de stock + perte)
    const pertesLignes = [...pertesBySku.values()].map(l => ({
      ...l,
      amount: -Math.abs(l.amount),
      qty: l.qty,
      prix_unitaire: l.qty > 0 ? Number((Math.abs(l.amount) / l.qty).toFixed(2)) : 0,
    })).sort((a, b) => a.amount - b.amount)
    const pertesTotal = Number(pertesLignes.reduce((s, l) => s + l.amount, 0).toFixed(2))

    // ─── DOC 4 — AJUSTEMENT INVENTAIRE (écarts audits) ─────────────────────
    // SEULEMENT les audits liés explicitement à CE settlement
    // (audit_type='settlement_fbm' ou 'settlement_fba'). L'audit AMA mensuel
    // global a son propre cycle et n'est PAS inclus ici.
    const { data: auditsLies } = await supabaseAdmin
      .from('amazon_audits')
      .select('id, audit_type, mois, label, statut')
      .eq('settlement_id', id)

    const ajustLignes: LigneSku[] = []
    if (auditsLies && auditsLies.length > 0) {
      const auditIds = auditsLies.map((a: any) => a.id)
      const { data: counts } = await supabaseAdmin
        .from('amazon_audit_counts')
        .select('*')
        .in('audit_id', auditIds)
      for (const c of counts || []) {
        const fbmEcart = c.fbm_compte != null ? Number(c.fbm_compte) - Number(c.fbm_theorique || 0) : 0
        const whseTheoNet = Number(c.hub_theorique || 0) + Number(c.sans_prefix_theorique || 0)
          - Math.min(Number(c.fba_amazon_theorique || 0), Number(c.sans_prefix_theorique || 0))
        const whseEcart = c.hub_compte != null ? Number(c.hub_compte) - whseTheoNet : 0
        const ecartTotal = fbmEcart + whseEcart
        if (ecartTotal === 0) continue
        const coutant = Number(c.coutant || 0)
        ajustLignes.push({
          sku: c.base_code,
          pk_code: c.base_code,
          product_name: c.description,
          qty: ecartTotal,
          amount: Number((ecartTotal * coutant).toFixed(2)),
          prix_unitaire: coutant,
          notes: `FBM Δ ${fbmEcart} + Whse Δ ${whseEcart}`,
        })
      }
    }
    ajustLignes.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    const ajustTotal = Number(ajustLignes.reduce((s, l) => s + l.amount, 0).toFixed(2))

    // ─── Coûts Amazon (compte agrégé non-stock) ─────────────────────────────
    // BALANCE GARANTIE PAR CONSTRUCTION :
    //   totalCoutsAmazon = (somme TSV) - (Doc 1 cashflow) - (Doc 2 cashflow) - (Doc 3 cashflow)
    // où :
    //   - Doc 1 cashflow = Order Principal du TSV
    //   - Doc 2 cashflow = partie des Refund Principal correspondant aux retours sellable
    //                     (= -retoursTotal car Doc 2 est négatif côté stock,
    //                      mais l'argent remboursé est dans le TSV via Refund Principal)
    //   - Doc 3 cashflow = reimbursements stock Amazon dans le TSV
    //                     (REVERSAL_REIMBURSEMENT + WAREHOUSE_DAMAGE/LOST/...)
    //   - Doc 4 = ajustement comptable pur, AUCUN cashflow (n'entre pas dans la balance)
    const totalTsv = Number(tx.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(2))
    const doc1CashFlow = ventesTotal                        // = Order Principal
    const doc2CashFlow = retoursTotal                       // négatif déjà (= partie Refund Principal sellable)
    const doc3CashFlow = sumWhere(t => ['REVERSAL_REIMBURSEMENT','WAREHOUSE_DAMAGE','WAREHOUSE_LOST','WAREHOUSE_DAMAGE_EXCEPTION','WAREHOUSE_LOST_MANIFEST'].includes(t.amount_type) || ['REVERSAL_REIMBURSEMENT','WAREHOUSE_DAMAGE','WAREHOUSE_LOST'].includes(desc(t)))
    const totalCoutsAmazon = Number((totalTsv - doc1CashFlow - doc2CashFlow - doc3CashFlow).toFixed(2))

    // Breakdown 3 sections identique au relevé papier d'Amazon
    // pour que l'utilisateur puisse vérifier visuellement.
    //   A — VENTES (hors Doc 1 = Order Principal) : Expédition seulement
    //   B — REMBOURSEMENTS (hors Doc 2 cashflow = part Refund Principal sellable)
    //   C — DÉPENSES (= section "Dépenses" du relevé papier, doit matcher au cent)
    const orderCommissionDescs = ['Commission','FBAPerUnitFulfillmentFee','MarketplaceFacilitatorTax-Principal','MarketplaceFacilitatorTax-Shipping','ShippingChargeback','ShippingHB']

    // Section A — VENTES (hors Doc 1)
    const a_expedition_orders = sumWhere(t => isOrder(t) && ['Shipping','ShippingTax','GiftWrap','GiftWrapTax'].includes(desc(t)))
    const a_taxes_orders_net = sumWhere(t => isOrder(t) && (desc(t) === 'Tax' || desc(t).startsWith('MarketplaceFacilitatorTax')))
    const sectionA_total = Number((a_expedition_orders + a_taxes_orders_net).toFixed(2))

    // Section B — REMBOURSEMENTS (hors Doc 2 cashflow)
    // Dépenses remboursées = Refund non-Principal positif (Promotion + ItemFees - RefundCommission)
    const b_depenses_remboursees = sumWhere(t => isRefund(t) && Number(t.amount || 0) > 0 && !['Principal','Shipping','ShippingTax'].includes(desc(t)))
    const b_depenses_remboursees_neg = sumWhere(t => isRefund(t) && Number(t.amount || 0) < 0 && !['Principal','Shipping','ShippingTax'].includes(desc(t)))
    // Ventes remboursées Frais produit hors sellable
    const refundPrincipalTotal = sumWhere(t => isRefund(t) && desc(t) === 'Principal')
    const b_ventes_remboursees_frais_produit_non_sellable = Number((refundPrincipalTotal - retoursTotal).toFixed(2))
    // Ventes remboursées Expédition (Refund Shipping + ShippingTax)
    const b_ventes_remboursees_expedition = sumWhere(t => isRefund(t) && ['Shipping','ShippingTax'].includes(desc(t)))
    const sectionB_total = Number((b_depenses_remboursees + b_depenses_remboursees_neg + b_ventes_remboursees_frais_produit_non_sellable + b_ventes_remboursees_expedition).toFixed(2))

    // Section C — DÉPENSES (= section "Dépenses" du relevé papier)
    const c_rabais_promotionnels = sumWhere(t => isOrder(t) && t.amount_type === 'Promotion')
    const c_frais_fba_stockage = sumWhere(t => t.amount_type === 'Storage Fee' || desc(t) === 'Storage Fee')
    const c_frais_fba_autres = sumWhere(t => t.amount_type === 'RemovalComplete' || desc(t) === 'RemovalComplete')
    // Frais d'abonnement / autres frais FBA non couverts
    const c_frais_fba_autre_amount_type = sumWhere(t => ['Subscription Fee'].includes(t.amount_type))
    const c_publicite = sumWhere(t => t.amount_type === 'Cost of Advertising' || desc(t) === 'TransactionTotalAmount')
    const c_commissions_amazon = sumWhere(t => isOrder(t) && orderCommissionDescs.includes(desc(t)))
    const c_remboursements_inverses = sumWhere(t => t.amount_type === 'COMPENSATED_CLAWBACK' || desc(t) === 'COMPENSATED_CLAWBACK')
    const sectionC_total = Number((c_rabais_promotionnels + c_frais_fba_stockage + c_frais_fba_autres + c_frais_fba_autre_amount_type + c_publicite + c_commissions_amazon + c_remboursements_inverses).toFixed(2))

    const couts_amazon = {
      // Section A — Ventes (hors Doc 1)
      'A_ventes_expedition': a_expedition_orders,
      'A_ventes_taxes_net': a_taxes_orders_net,
      'A_TOTAL_section_A': sectionA_total,
      // Section B — Remboursements (hors Doc 2 cashflow)
      'B_remb_depenses_pos': b_depenses_remboursees,
      'B_remb_depenses_neg': b_depenses_remboursees_neg,
      'B_remb_ventes_frais_produit_non_sellable': b_ventes_remboursees_frais_produit_non_sellable,
      'B_remb_ventes_expedition': b_ventes_remboursees_expedition,
      'B_TOTAL_section_B': sectionB_total,
      // Section C — Dépenses (= scan papier)
      'C_rabais_promotionnels': c_rabais_promotionnels,
      'C_frais_fba_stockage': c_frais_fba_stockage,
      'C_frais_fba_autres': c_frais_fba_autres,
      'C_publicite': c_publicite,
      'C_commissions_amazon': c_commissions_amazon,
      'C_remboursements_inverses': c_remboursements_inverses,
      'C_TOTAL_section_C': sectionC_total,
    }
    if (Math.abs(c_frais_fba_autre_amount_type) >= 0.01) {
      ;(couts_amazon as any)['C_frais_fba_abonnement'] = c_frais_fba_autre_amount_type
    }

    // Calcul du résiduel non-classé (transactions du TSV non couvertes par les 3 sections)
    const sumABC = Number((sectionA_total + sectionB_total + sectionC_total).toFixed(2))
    const residuel = Number((totalCoutsAmazon - sumABC).toFixed(2))
    if (Math.abs(residuel) >= 0.01) {
      ;(couts_amazon as any).Z_autre_non_classe = residuel
    }

    // ─── Documents existants saisis (n° facture LAUTOPAK déjà entrés) ──────
    const { data: docsExistants } = await supabaseAdmin
      .from('amazon_lautopak_documents')
      .select('*')
      .eq('settlement_id', id)
    const docsExistantsByType = new Map<string, any>()
    for (const d of docsExistants || []) docsExistantsByType.set(d.doc_type, d)

    // ─── Assembler la réponse ──────────────────────────────────────────────
    const buildDoc = (
      doc_type: DocLautopak['doc_type'],
      label: string,
      lignes: LigneSku[],
      total: number,
    ): DocLautopak => {
      const existant = docsExistantsByType.get(doc_type)
      return {
        doc_type, label, lignes, total,
        numero_facture: existant?.numero_facture || null,
        date_facture: existant?.date_facture || null,
        saisi_le: existant?.saisi_le || null,
        saisi_par: existant?.saisi_par || null,
        notes_saisie: existant?.notes || null,
      }
    }

    const docs = [
      buildDoc('ventes', 'Facture VENTES', ventesLignes, ventesTotal),
      buildDoc('note_credit_retours', 'Note de crédit RETOURS SELLABLE', retoursLignes, retoursTotal),
      buildDoc('note_credit_pertes', 'Note de crédit PERTES / DOMMAGES', pertesLignes, pertesTotal),
      buildDoc('ajust_audit', 'Ajustement INVENTAIRE (audits)', ajustLignes, ajustTotal),
    ]

    // Cashflow par doc (= contribution au dépôt bancaire) :
    //   Doc 1 ventes       : +Doc1.total                 (revenu Amazon = Order Principal)
    //   Doc 2 retours      : Doc2.total                  (négatif = remboursement client = Refund Principal)
    //   Doc 3 pertes       : -Doc3.total                 (positif = reim Amazon dans TSV, opposé de la note de crédit)
    //   Doc 4 audit        : 0                           (mouvement comptable pur, hors dépôt)
    const cashFlowDoc1 = doc1CashFlow
    const cashFlowDoc2 = doc2CashFlow
    const cashFlowDoc3 = doc3CashFlow      // déjà calculé plus haut (REVERSAL_REIMBURSEMENT + WAREHOUSE_*)
    const cashFlowDoc4 = 0
    const totalCashFlowDocs = Number((cashFlowDoc1 + cashFlowDoc2 + cashFlowDoc3 + cashFlowDoc4).toFixed(2))

    // Valeur stock LAUTOPAK = somme algébrique des 4 documents (sortie + entrée + ajust)
    const netLautopak = Number(docs.reduce((s, d) => s + d.total, 0).toFixed(2))

    // Balance comptable = cashflow docs + coûts Amazon = dépôt bancaire (par construction)
    const balanceCalcul = Number((totalCashFlowDocs + totalCoutsAmazon).toFixed(2))
    const depotBancaire = Number(s.total_amount || 0)
    const balanceOk = Math.abs(balanceCalcul - depotBancaire) < 0.5

    return NextResponse.json({
      settlement: {
        settlement_id: s.settlement_id,
        settlement_start: s.settlement_start,
        settlement_end: s.settlement_end,
        deposit_date: s.deposit_date,
        depot_bancaire: depotBancaire,
      },
      docs,
      couts_amazon,
      total_couts_amazon: totalCoutsAmazon,
      total_tsv: totalTsv,
      // Cashflow par doc (contribution au dépôt) — utile pour expliquer la balance
      cashflow_docs: {
        doc1_ventes: cashFlowDoc1,
        doc2_retours: cashFlowDoc2,
        doc3_pertes: cashFlowDoc3,
        doc4_audit: cashFlowDoc4,
        total: totalCashFlowDocs,
      },
      net_lautopak: netLautopak,            // valeur stock = somme algébrique des 4 docs
      balance_calcul: balanceCalcul,
      balance_settlement: depotBancaire,
      balance_ok: balanceOk,
      ecart_balance: Number((balanceCalcul - depotBancaire).toFixed(2)),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// POST /api/amazon/closure/lautopak-docs
// Body: { settlement_id, doc_type, numero_facture, date_facture, saisi_par, notes? }
// Saisit/met à jour le n° de facture LAUTOPAK pour un des 4 documents.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { settlement_id, doc_type, numero_facture, date_facture, saisi_par, notes, montant_total } = body
    if (!settlement_id || !doc_type) return NextResponse.json({ erreur: 'settlement_id + doc_type requis' }, { status: 400 })
    const validTypes = ['ventes', 'note_credit_retours', 'note_credit_pertes', 'ajust_audit']
    if (!validTypes.includes(doc_type)) return NextResponse.json({ erreur: 'doc_type invalide' }, { status: 400 })

    const row = {
      settlement_id, doc_type,
      numero_facture: numero_facture || null,
      date_facture: date_facture || null,
      montant_total: montant_total != null ? Number(montant_total) : null,
      saisi_le: numero_facture ? new Date().toISOString() : null,
      saisi_par: saisi_par || null,
      notes: notes || null,
    }
    const { error } = await supabaseAdmin
      .from('amazon_lautopak_documents')
      .upsert(row, { onConflict: 'settlement_id,doc_type' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE — efface la saisie d'un document (laisse la ligne mais vide les n°)
export async function DELETE(req: NextRequest) {
  try {
    const settlement_id = req.nextUrl.searchParams.get('settlement_id')
    const doc_type = req.nextUrl.searchParams.get('doc_type')
    if (!settlement_id || !doc_type) return NextResponse.json({ erreur: 'settlement_id + doc_type requis' }, { status: 400 })
    const { error } = await supabaseAdmin
      .from('amazon_lautopak_documents')
      .delete()
      .eq('settlement_id', settlement_id)
      .eq('doc_type', doc_type)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
