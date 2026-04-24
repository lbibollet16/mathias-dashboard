import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste de TOUTES les actions unsellable à travers tous les settlements
// avec enrichissement : a-t-on reçu un reimbursement pour ce SKU après coup ?
// Permet le suivi historique des unsellable.

export async function GET(_req: NextRequest) {
  try {
    const { data: actions } = await supabaseAdmin
      .from('amazon_unsellable_actions')
      .select('*')
      .order('action_le', { ascending: false })

    // Enrichir avec : date du settlement, nom settlement, reimbursement ultérieur matchant
    const settlementIds = Array.from(new Set((actions || []).map((a: any) => a.settlement_id)))
    const settlementsMap = new Map<string, any>()
    if (settlementIds.length > 0) {
      const { data: sData } = await supabaseAdmin
        .from('amazon_settlements')
        .select('settlement_id, settlement_start, settlement_end, deposit_date, closed_at')
        .in('settlement_id', settlementIds)
      for (const s of sData || []) settlementsMap.set(s.settlement_id, s)
    }

    // Pour chaque SKU, chercher s'il y a eu un reimbursement dans les reimbursements (après la date de l'action)
    const skus = Array.from(new Set((actions || []).map((a: any) => a.sku)))
    const reimbBySku = new Map<string, any[]>()
    if (skus.length > 0) {
      const { data: rData } = await supabaseAdmin
        .from('amazon_reimbursements')
        .select('reimbursement_id, sku, approval_date, amount_total, quantity_reimbursed_cash, quantity_reimbursed_inventory, reason, settlement_id')
        .in('sku', skus)
      for (const r of rData || []) {
        const list = reimbBySku.get(r.sku) || []
        list.push(r)
        reimbBySku.set(r.sku, list)
      }
    }

    // Dernier snapshot FBA pour savoir si l'unsellable est TOUJOURS là
    const { data: lastSnap } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const lastSnapDate = lastSnap && lastSnap[0]?.snapshot_date
    const stillUnsellableMap = new Map<string, number>()
    if (lastSnapDate) {
      const { data: fba } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('sku, afn_unsellable_quantity')
        .eq('snapshot_date', lastSnapDate)
        .gt('afn_unsellable_quantity', 0)
      for (const f of fba || []) stillUnsellableMap.set(f.sku, Number(f.afn_unsellable_quantity || 0))
    }

    const enriched = (actions || []).map((a: any) => {
      const settlement = settlementsMap.get(a.settlement_id)
      const reimbs = reimbBySku.get(a.sku) || []
      // Filtrer reimbursements qui ont eu lieu APRÈS l'action (date)
      const relevantReimbs = a.action_le
        ? reimbs.filter((r: any) => r.approval_date && r.approval_date >= a.action_le)
        : reimbs
      const totalReimb = relevantReimbs.reduce((s: number, r: any) => s + Number(r.amount_total || 0), 0)
      const stillUnsellableQty = stillUnsellableMap.get(a.sku) || 0
      return {
        ...a,
        settlement_start: settlement?.settlement_start,
        settlement_end: settlement?.settlement_end,
        settlement_closed: !!settlement?.closed_at,
        reimbursements_ultérieurs: relevantReimbs,
        total_reimb_ulterieur: Number(totalReimb.toFixed(2)),
        still_unsellable_qty: stillUnsellableQty,
        statut: stillUnsellableQty === 0 && relevantReimbs.length > 0 ? 'resolu_reimb'
          : stillUnsellableQty === 0 ? 'resolu'
          : relevantReimbs.length > 0 ? 'partiel_reimb'
          : 'en_attente',
      }
    })

    // Stats
    const stats = {
      total: enriched.length,
      resolu: enriched.filter((a: any) => a.statut === 'resolu' || a.statut === 'resolu_reimb').length,
      en_attente: enriched.filter((a: any) => a.statut === 'en_attente').length,
      par_action: {
        removal: enriched.filter((a: any) => a.action_type === 'removal').length,
        case: enriched.filter((a: any) => a.action_type === 'case').length,
        skip: enriched.filter((a: any) => a.action_type === 'skip').length,
      },
      total_reimb_cumule: Number(enriched.reduce((s: number, a: any) => s + a.total_reimb_ulterieur, 0).toFixed(2)),
    }

    return NextResponse.json({ actions: enriched, stats, last_snapshot_date: lastSnapDate })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
