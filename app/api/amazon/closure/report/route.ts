import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/amazon/closure/report?id=XXX
// Retourne toutes les données ligne-par-ligne pour le rapport comptable final.
// Utilisé par la vue web imprimable (CSS @media print → PDF).

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

  try {
    const { data: s, error: sErr } = await supabaseAdmin
      .from('amazon_settlements')
      .select('*')
      .eq('settlement_id', id)
      .maybeSingle()
    if (sErr) throw sErr
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    // Transactions du settlement (pour le résumé des flux)
    const { data: tx } = await supabaseAdmin
      .from('amazon_transactions')
      .select('transaction_type, amount_type, amount')
      .eq('settlement_id', s.settlement_id)
      .limit(100000)
    const totaux_par_amount_type = new Map<string, { count: number; total: number }>()
    for (const t of tx || []) {
      const k = t.amount_type || '(inconnu)'
      const ex = totaux_par_amount_type.get(k) || { count: 0, total: 0 }
      ex.count++
      ex.total += Number(t.amount || 0)
      totaux_par_amount_type.set(k, ex)
    }
    const flux = [...totaux_par_amount_type.entries()]
      .map(([amount_type, v]) => ({ amount_type, count: v.count, total: v.total }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))

    // Reimbursements du settlement
    const { data: reimbs } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select('*')
      .eq('settlement_id', s.settlement_id)

    // Ajustements Traction FBA requis (reimbursements cash = unités disparues)
    // Priorité au multi-mapping manuel, sinon auto-strip.
    const { loadManualMappings } = await import('@/lib/amazon-mapping')
    const manualMappings = await loadManualMappings()
    const resolveReportPk = (sku: string, tc: string | null): { pk: string | null; mult: number; manual: boolean } => {
      const manual = manualMappings.get(sku)
      if (manual && manual.length > 0) return { pk: manual[0].pk_code, mult: manual[0].multiplier, manual: true }
      const code = tc || ''
      const stripped = code.replace(/^[A]/, '').replace(/^(HUB|FBA|FBM)-/i, '').replace(/-(HUB|FBA|FBM)\d*$/i, '')
      return { pk: stripped ? `FBA-${stripped}` : null, mult: 1, manual: false }
    }
    const reimbCash = (reimbs || []).filter((r: any) => Number(r.quantity_reimbursed_cash || 0) > 0)
    const ajustements_fba: any[] = []
    if (reimbCash.length > 0) {
      const resolved = reimbCash.map((r: any) => ({ reimb: r, ...resolveReportPk(r.sku, r.traction_code) }))
      const fbaPkCodes = Array.from(new Set(resolved.map(x => x.pk).filter(Boolean) as string[]))
      const { data: fbaLines } = fbaPkCodes.length
        ? await supabaseAdmin.from('traction_amazon_lignes').select('pk_code, qty_minus_reserved').in('pk_code', fbaPkCodes)
        : { data: [] }
      const fbaByPk = new Map<string, any>()
      for (const f of fbaLines || []) fbaByPk.set(f.pk_code, f)
      for (const x of resolved) {
        const r = x.reimb
        const qtyCash = Number(r.quantity_reimbursed_cash || 0)
        ajustements_fba.push({
          reimbursement_id: r.reimbursement_id,
          sku: r.sku,
          product_name: r.product_name,
          traction_code: r.traction_code,
          reason: r.reason,
          qty_cash: qtyCash,
          qty_cash_lautopak: qtyCash * x.mult,
          multiplier: x.mult,
          manual_mapping: x.manual,
          amount: Number(r.amount_total || 0),
          pk_code_to_adjust: x.pk,
          current_traction_qty: x.pk && fbaByPk.has(x.pk) ? Number(fbaByPk.get(x.pk).qty_minus_reserved || 0) : null,
        })
      }
    }

    // Audit lié
    const { data: audits } = await supabaseAdmin
      .from('amazon_audits')
      .select('*')
      .eq('settlement_id', s.settlement_id)
      .limit(1)
    const audit = audits && audits[0]

    let ajustements: any[] = []
    let audit_stats = { nb_total: 0, nb_counted: 0, valeur_ecart_abs: 0 }
    if (audit) {
      const { data: counts } = await supabaseAdmin
        .from('amazon_audit_counts')
        .select('*')
        .eq('audit_id', audit.id)
      for (const c of counts || []) {
        audit_stats.nb_total++
        const whseCompte = c.hub_compte != null || c.sans_prefix_compte != null
          ? Number(c.hub_compte || 0) + Number(c.sans_prefix_compte || 0)
          : null
        const fbmCompte = c.fbm_compte != null ? Number(c.fbm_compte) : null
        if (whseCompte != null || fbmCompte != null) audit_stats.nb_counted++

        const hubRaw = Number(c.hub_theorique || 0)
        const fbmRaw = Number(c.fbm_theorique || 0)
        const spRaw = Number(c.sans_prefix_theorique || 0)
        const fbaAmz = Number(c.fba_amazon_theorique || 0)
        // Net warehouse attendu = (hub + sp) - fba_amazon (déjà chez Amazon)
        const dedSp = Math.min(spRaw, fbaAmz)
        const sp_net = spRaw - dedSp
        const remaining = fbaAmz - dedSp
        const dedHub = Math.min(hubRaw, remaining)
        const hub_net = hubRaw - dedHub
        const whse_net = hub_net + sp_net

        const whseEcart = whseCompte != null ? whseCompte - whse_net : 0
        const fbmEcart = fbmCompte != null ? fbmCompte - fbmRaw : 0
        const coutant = Number(c.coutant || 0)
        const valeurAjust = (whseEcart + fbmEcart) * coutant

        if ((whseCompte != null && whseEcart !== 0) || (fbmCompte != null && fbmEcart !== 0)) {
          ajustements.push({
            base_code: c.base_code,
            description: c.description,
            warehouse_theorique_net: whse_net,
            warehouse_compte: whseCompte,
            warehouse_ecart: whseEcart,
            fbm_theorique: fbmRaw,
            fbm_compte: fbmCompte,
            fbm_ecart: fbmEcart,
            coutant,
            valeur_ecart: valeurAjust,
            has_oubli: spRaw > 0,
            sans_prefix_theorique: spRaw,
          })
          audit_stats.valeur_ecart_abs += Math.abs(valeurAjust)
        }
      }
      ajustements.sort((a, b) => Math.abs(b.valeur_ecart) - Math.abs(a.valeur_ecart))
    }

    // Unsellable au moment du settlement
    const settlementEndDate = s.settlement_end ? String(s.settlement_end).split('T')[0] : null
    let unsellable: any[] = []
    if (settlementEndDate) {
      const { data: snapDates } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('snapshot_date')
        .lte('snapshot_date', settlementEndDate)
        .order('snapshot_date', { ascending: false })
        .limit(1)
      const snap = snapDates && snapDates[0]?.snapshot_date
      if (snap) {
        const { data: us } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, traction_code, product_name, afn_unsellable_quantity, your_price')
          .eq('snapshot_date', snap)
          .gt('afn_unsellable_quantity', 0)
        unsellable = (us || []).map((f: any) => ({
          sku: f.sku, traction_code: f.traction_code,
          product_name: f.product_name,
          qty: Number(f.afn_unsellable_quantity || 0),
          valeur: Number(f.afn_unsellable_quantity || 0) * Number(f.your_price || 0),
        }))
      }
    }
    const unsellable_total = unsellable.reduce((a, u) => a + u.valeur, 0)

    // Totaux finaux
    const total_ajustement_net = ajustements.reduce((a, r) => a + r.valeur_ecart, 0)
    const total_reimbursements = (reimbs || []).reduce((a, r: any) => a + Number(r.amount_total || 0), 0)

    return NextResponse.json({
      settlement: {
        settlement_id: s.settlement_id,
        settlement_start: s.settlement_start,
        settlement_end: s.settlement_end,
        deposit_date: s.deposit_date,
        total_amount: Number(s.total_amount || 0),
        lautopak_invoice_ref: s.lautopak_invoice_ref,
        lautopak_invoice_date: s.lautopak_invoice_date,
        closed_at: s.closed_at,
        closed_by: s.closed_by,
      },
      flux,
      reimbursements: reimbs || [],
      ajustements,
      ajustements_fba,
      unsellable,
      audit_stats,
      totaux: {
        total_depot_amazon: Number(s.total_amount || 0),
        total_reimbursements,
        total_ajustement_inventaire_net: total_ajustement_net,
        total_ajustement_inventaire_abs: audit_stats.valeur_ecart_abs,
        total_unsellable: unsellable_total,
      },
      genere_le: new Date().toISOString(),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
