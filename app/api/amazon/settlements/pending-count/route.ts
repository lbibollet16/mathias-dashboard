import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/settlements/pending-count
 *
 * Retourne le nombre de settlements à fermer (closed_at IS NULL) +
 * un sample des 5 plus récents avec leur deposit_date pour le tooltip
 * du badge.
 *
 * Utilisé par <SettlementsPendingBadge /> dans la nav du dashboard,
 * visible seulement pour role='admin'.
 */
export async function GET() {
  try {
    const { count, error: cErr } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id', { count: 'exact', head: true })
      .is('closed_at', null);

    if (cErr) throw cErr;

    // Sample des 5 plus récents non-fermés pour tooltip
    const { data: sample } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_end, deposit_date, total_amount, currency')
      .is('closed_at', null)
      .order('settlement_end', { ascending: false })
      .limit(5);

    return NextResponse.json({
      ok: true,
      count: count ?? 0,
      sample: sample ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), count: 0, sample: [] },
      { status: 500 },
    );
  }
}
