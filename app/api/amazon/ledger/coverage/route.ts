import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/ledger/coverage?months=12
 *
 * Returns per-month event counts for the last N months. Lets the smart
 * backfill detect which months already have data and skip them — every
 * skipped month saves a precious rate-limit token on Amazon's
 * `POST /reports/2021-06-30/reports` endpoint (1 token/minute refill).
 *
 * The dumb chunked backfill kept re-fetching Oct + Nov 2025 on every
 * run (they were already complete), burning the bucket before reaching
 * the actual missing months (Dec 2025 → Apr 2026).
 *
 * Returns { ok, months: [{ year_month, event_count, status }] }
 *   status :
 *     - 'covered'      : >= 100 events  → can be skipped
 *     - 'sparse'       :   1-99 events  → consider a refresh
 *     - 'missing'      :   0 events     → must be fetched
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const monthsBack = Math.max(1, Math.min(24, Number(url.searchParams.get('months') ?? 12)));
  const sparseThreshold = Math.max(
    0,
    Number(url.searchParams.get('sparse_threshold') ?? 100),
  );
  // Optionnel : filtre par pays (CA / US). Indispensable pour que le
  // smart backfill US ne considère pas comme « couvert » un mois où on
  // a 65k events CA mais 0 event US.
  const country = url.searchParams.get('country');

  const results: Array<{
    year_month: string;
    start_date: string;
    end_date: string;
    event_count: number;
    status: 'covered' | 'sparse' | 'missing';
  }> = [];

  for (let i = monthsBack - 1; i >= 0; i--) {
    const start = new Date();
    start.setUTCMonth(start.getUTCMonth() - i);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    let q = supabaseAdmin
      .from('amazon_inventory_ledger')
      .select('*', { count: 'exact', head: true })
      .gte('event_date', startStr)
      .lt('event_date', endStr);
    if (country) q = q.eq('country', country);
    const { count, error } = await q;

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const n = count ?? 0;
    const status: 'covered' | 'sparse' | 'missing' =
      n === 0 ? 'missing' : n < sparseThreshold ? 'sparse' : 'covered';

    results.push({
      year_month: start.toISOString().slice(0, 7),
      start_date: startStr,
      end_date: endStr,
      event_count: n,
      status,
    });
  }

  const summary = {
    months_total: results.length,
    months_covered: results.filter((r) => r.status === 'covered').length,
    months_sparse: results.filter((r) => r.status === 'sparse').length,
    months_missing: results.filter((r) => r.status === 'missing').length,
    total_events: results.reduce((s, r) => s + r.event_count, 0),
  };

  return NextResponse.json({ ok: true, country: country ?? null, summary, months: results });
}
