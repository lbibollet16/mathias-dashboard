import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * GET /api/amazon/data
 *
 * Résumé global pour l'UI Amazon (phase 1: fondations).
 *
 * Filtre par défaut (depuis PR #23 + #25) : on masque les
 * mini-ajustements settlement Amazon (< 500 $ OU période ≠ 12-16 jours).
 * Ces ajustements sont de vrais dépôts mais ne représentent pas un
 * cycle bi-hebdomadaire normal — ils polluent la vue Fermeture.
 *
 * Pour les inclure : `?adjustments=included`.
 */

export const dynamic = 'force-dynamic'

function isAdjustment(s: { settlement_start: string | null; settlement_end: string | null; total_amount: number | string | null }): boolean {
  const startMs = s.settlement_start ? new Date(s.settlement_start).getTime() : null
  const endMs = s.settlement_end ? new Date(s.settlement_end).getTime() : null
  const periodDays = startMs && endMs ? Math.round((endMs - startMs) / 86_400_000) : null
  return Number(s.total_amount || 0) < 500 || (periodDays !== null && (periodDays < 12 || periodDays > 16))
}

export async function GET(req: NextRequest) {
  try {
    const includeAdjustments = req.nextUrl.searchParams.get('adjustments') === 'included'

    const [settlements, txCount, fbaCount, rbCount, unresolvedTx, mappingsCount, tractionCount] = await Promise.all([
      supabaseAdmin.from('amazon_settlements').select('*').order('deposit_date', { ascending: false }),
      supabaseAdmin.from('amazon_transactions').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('amazon_fba_inventory').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('amazon_reimbursements').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('amazon_transactions').select('id', { count: 'exact', head: true }).is('traction_code', null),
      supabaseAdmin.from('amazon_sku_mapping').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('traction_amazon_lignes').select('id', { count: 'exact', head: true }),
    ])

    const allSettlements = (settlements.data || []).map((s: any) => ({ ...s, is_adjustment: isAdjustment(s) }))
    const filtered = includeAdjustments ? allSettlements : allSettlements.filter((s: any) => !s.is_adjustment)

    return NextResponse.json({
      settlements: filtered,
      adjustments_hidden: allSettlements.length - filtered.length,
      counts: {
        transactions: txCount.count || 0,
        fba_inventory: fbaCount.count || 0,
        reimbursements: rbCount.count || 0,
        unresolved_transactions: unresolvedTx.count || 0,
        mappings: mappingsCount.count || 0,
        traction_amazon_lignes: tractionCount.count || 0,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
