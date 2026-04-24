import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadManualMappings } from '@/lib/amazon-mapping'

// GET /api/amazon/closure/lautopak-reimb-lines?id=XXX
//
// Lignes à entrer dans la 2e facture LAUTOPAK (pièces remboursées cash).
// Regroupement par pk_code cible (via multi-mapping si dispo, sinon auto-strip).
// Prix unitaires arrondis à 0,10 avec balance auto pour que le total = somme
// des amount_total cash reimbursements (= "Remb. de stock FBA" du relevé).

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

  try {
    const { data: s } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end, lautopak_reimb_invoice_ref, lautopak_reimb_invoice_date')
      .eq('settlement_id', id)
      .maybeSingle()
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    const { data: reimbs } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select('reimbursement_id, sku, traction_code, reason, product_name, quantity_reimbursed_cash, quantity_reimbursed_inventory, amount_per_unit, amount_total')
      .eq('settlement_id', s.settlement_id)

    const cashOnly = (reimbs || []).filter((r: any) => Number(r.quantity_reimbursed_cash || 0) > 0)

    // Résoudre pk_code cible : manual mapping > auto-strip
    const manualMappings = await loadManualMappings()
    const resolvePkCode = (amazonSku: string, tractionCode: string | null): { pk: string; mult: number; manual: boolean } => {
      const manual = manualMappings.get(amazonSku)
      if (manual && manual.length > 0) {
        return { pk: manual[0].pk_code, mult: manual[0].multiplier, manual: true }
      }
      const tc = tractionCode || ''
      const stripped = tc.replace(/^[A]/, '').replace(/^(HUB|FBA|FBM)-/i, '').replace(/-(HUB|FBA|FBM)\d*$/i, '')
      return { pk: stripped ? `FBA-${stripped}` : (tractionCode || amazonSku), mult: 1, manual: false }
    }

    // Regroupement par pk_code cible
    type Variante = { reimbursement_id: string; amazon_sku: string; traction_code: string | null; reason: string | null; qty: number; multiplier: number; qty_lautopak: number; amount_source: number }
    type Group = {
      pk_code: string
      variantes: Variante[]
      product_name: string | null
      qty_amazon_total: number
      qty_lautopak_total: number
      amount: number
      prix_unitaire: number
      amount_balanced: number
      manual_mapping: boolean
    }
    const byPk = new Map<string, Group>()
    for (const r of cashOnly) {
      const qty = Number(r.quantity_reimbursed_cash || 0)
      const amt = Number(r.amount_total || 0)
      const { pk, mult, manual } = resolvePkCode(r.sku, r.traction_code)
      const qtyLpk = qty * mult
      const entry = byPk.get(pk) || {
        pk_code: pk, variantes: [],
        product_name: r.product_name,
        qty_amazon_total: 0, qty_lautopak_total: 0,
        amount: 0, prix_unitaire: 0, amount_balanced: 0,
        manual_mapping: manual,
      }
      entry.qty_amazon_total += qty
      entry.qty_lautopak_total += qtyLpk
      entry.amount += amt
      entry.variantes.push({
        reimbursement_id: r.reimbursement_id, amazon_sku: r.sku, traction_code: r.traction_code,
        reason: r.reason, qty, multiplier: mult, qty_lautopak: qtyLpk,
        amount_source: Number(amt.toFixed(2)),
      })
      if (!entry.product_name && r.product_name) entry.product_name = r.product_name
      byPk.set(pk, entry)
    }

    // Balance : prix unitaire arrondi à 0,10, ajustement pour matcher le total cash
    const target = Number(cashOnly.reduce((s, r: any) => s + Number(r.amount_total || 0), 0).toFixed(2))
    const roundToTenth = (n: number) => Math.round(n * 10) / 10
    const groups = [...byPk.values()]
    for (const g of groups) {
      const divQty = g.qty_lautopak_total || g.qty_amazon_total
      const raw = divQty !== 0 ? g.amount / divQty : 0
      g.prix_unitaire = roundToTenth(raw)
      g.amount_balanced = Number((g.prix_unitaire * divQty).toFixed(2))
    }
    let delta = Number((target - groups.reduce((s, g) => s + g.amount_balanced, 0)).toFixed(2))
    let adjustments = 0
    if (Math.abs(delta) >= 0.005) {
      const direction = delta > 0 ? 1 : -1
      let remaining = Math.abs(delta)
      const sorted = [...groups].filter(g => (g.qty_lautopak_total || g.qty_amazon_total) > 0)
        .sort((a, b) => (b.qty_lautopak_total || b.qty_amazon_total) - (a.qty_lautopak_total || a.qty_amazon_total))
      for (const g of sorted) {
        if (remaining < 0.005) break
        const divQty = g.qty_lautopak_total || g.qty_amazon_total
        const stepValue = divQty * 0.10
        if (stepValue === 0) continue
        const maxSteps = Math.floor(remaining / stepValue)
        if (maxSteps <= 0) continue
        const steps = Math.min(maxSteps, 20)
        g.prix_unitaire = Number((g.prix_unitaire + direction * steps * 0.10).toFixed(2))
        g.amount_balanced = Number((g.prix_unitaire * divQty).toFixed(2))
        remaining = Number((remaining - steps * stepValue).toFixed(2))
        adjustments++
      }
      if (remaining >= 0.005 && sorted.length > 0) {
        const biggest = sorted[0]
        const divQty = biggest.qty_lautopak_total || biggest.qty_amazon_total
        biggest.amount_balanced = Number((biggest.amount_balanced + direction * remaining).toFixed(2))
        biggest.prix_unitaire = Number((biggest.amount_balanced / divQty).toFixed(2))
        adjustments++
      }
    }

    const lignes = groups.map(g => ({
      pk_code: g.pk_code,
      manual_mapping: g.manual_mapping,
      variantes: g.variantes,
      amazon_skus: g.variantes.map(v => v.amazon_sku),
      product_name: g.product_name,
      qty: g.qty_amazon_total,
      qty_lautopak: g.qty_lautopak_total,
      amount: g.amount_balanced,
      prix_unitaire: g.prix_unitaire,
      // backward compat
      sku: g.variantes.length === 1 ? g.variantes[0].amazon_sku : `${g.variantes.length} variantes`,
      fba_pk_code: g.pk_code,
      reason: g.variantes.map(v => v.reason).filter(Boolean).join(', '),
      reimbursement_id: g.variantes.map(v => v.reimbursement_id).join(', '),
      montant: g.amount_balanced,
    })).sort((a, b) => b.amount - a.amount)

    const total_facture = Number(lignes.reduce((s: number, l: any) => s + (l.amount || 0), 0).toFixed(2))

    return NextResponse.json({
      settlement_id: s.settlement_id,
      settlement_start: s.settlement_start,
      settlement_end: s.settlement_end,
      lautopak_reimb_invoice_ref: s.lautopak_reimb_invoice_ref,
      lautopak_reimb_invoice_date: s.lautopak_reimb_invoice_date,
      nb_lignes: lignes.length,
      total_facture,
      target_settlement: target,   // somme brute des cash reimbursements
      adjustments,
      balance_ok: Math.abs(total_facture - target) < 0.01,
      lignes,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
