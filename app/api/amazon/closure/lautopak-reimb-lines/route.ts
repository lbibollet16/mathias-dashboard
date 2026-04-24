import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/amazon/closure/lautopak-reimb-lines?id=XXX
//
// Retourne les lignes à entrer dans la facture LAUTOPAK SÉPARÉE pour les
// pièces remboursées par Amazon (Lost/Damaged/CustomerReturn cash).
//
// Chaque ligne = 1 reimbursement cash :
//   SKU Amazon | pk_code FBA | qty | prix unitaire (cost Amazon) | total
// Total = somme des amount_total des reimbursements cash
//       = ce que la facture LAUTOPAK reimb doit totaliser.

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

    // Calculer le pk_code FBA à utiliser (même logique que step 2)
    const lignes = cashOnly.map((r: any) => {
      const tc = r.traction_code || ''
      const stripped = tc.replace(/^[A]/, '').replace(/^(HUB|FBA|FBM)-/i, '').replace(/-(HUB|FBA|FBM)\d*$/i, '')
      const fbaPk = stripped ? `FBA-${stripped}` : null
      const qty = Number(r.quantity_reimbursed_cash || 0)
      const amount = Number(r.amount_total || 0)
      const unitPrice = qty > 0 ? Number((amount / qty).toFixed(2)) : Number(r.amount_per_unit || 0)
      return {
        reimbursement_id: r.reimbursement_id,
        sku: r.sku,
        traction_code: r.traction_code,
        fba_pk_code: fbaPk,
        reason: r.reason,
        product_name: r.product_name,
        qty,
        prix_unitaire: unitPrice,
        montant: Number(amount.toFixed(2)),
      }
    }).sort((a: any, b: any) => b.montant - a.montant)

    const total_facture = Number(lignes.reduce((s: number, l: any) => s + l.montant, 0).toFixed(2))

    return NextResponse.json({
      settlement_id: s.settlement_id,
      settlement_start: s.settlement_start,
      settlement_end: s.settlement_end,
      lautopak_reimb_invoice_ref: s.lautopak_reimb_invoice_ref,
      lautopak_reimb_invoice_date: s.lautopak_reimb_invoice_date,
      nb_lignes: lignes.length,
      total_facture,
      lignes,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
