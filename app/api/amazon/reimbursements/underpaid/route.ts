import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/reimbursements/underpaid
 *
 * Croise amazon_reimbursements × amazon_sku_costs pour identifier les
 * remboursements où Amazon a payé MOINS que ce que notre cost actuel
 * indiquerait. Ces cas sont les candidats à une "Submit a reimbursement
 * claim dispute" dans Seller Central, où on cite le Reimbursement ID
 * et on demande l'ajustement différentiel sous la politique cost
 * basis de mars 2025.
 *
 * Query params (tous optionnels) :
 *   - min_uplift     : float, default 1 CAD (filtre les rounding-noise)
 *   - within_days    : int, default 540 (18 mois max). 90 = window
 *                      dispute fraîche, taux succès ~60%.
 *   - status         : 'pending' | 'sent' | 'paid' | 'all'  default
 *                      'pending'. Stockage local du workflow.
 *   - limit          : 1..500 default 200.
 *
 * Returns { ok, total_count, total_uplift_cad, candidates }
 */

export const dynamic = 'force-dynamic';

interface ReimbursementRow {
  id: number;
  reimbursement_id: string | null;
  approval_date: string | null;
  case_id: string | null;
  amazon_order_id: string | null;
  reason: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  currency: string | null;
  amount_per_unit: number | null;
  amount_total: number | null;
  quantity_reimbursed_total: number | null;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const minUplift = Math.max(0, Number(url.searchParams.get('min_uplift') ?? 1));
  const withinDays = Math.max(1, Math.min(720, Number(url.searchParams.get('within_days') ?? 540)));
  const status = url.searchParams.get('status') ?? 'pending';
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200)));

  const cutoff = new Date(Date.now() - withinDays * 86_400_000).toISOString();

  // Page through reimbursements — table peut grandir > 1000.
  const reimbursements: ReimbursementRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select(
        'id, reimbursement_id, approval_date, case_id, amazon_order_id, reason, sku, fnsku, asin, product_name, currency, amount_per_unit, amount_total, quantity_reimbursed_total',
      )
      .gte('approval_date', cutoff)
      .not('amount_total', 'is', null)
      .range(from, from + 999);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    reimbursements.push(...(data as ReimbursementRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }

  // Récup cost lookup en 1 pass.
  const { data: costs } = await supabaseAdmin
    .from('amazon_sku_costs')
    .select('asin, fnsku, sku, cost_amount, cost_currency, source');
  const byAsin = new Map<string, number>();
  const byFnsku = new Map<string, number>();
  const bySku = new Map<string, number>();
  for (const c of (costs ?? []) as Array<{
    asin: string | null;
    fnsku: string | null;
    sku: string | null;
    cost_amount: number | string | null;
    cost_currency: string | null;
  }>) {
    const v = Number(c.cost_amount);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (c.cost_currency && c.cost_currency !== 'CAD') continue;
    if (c.asin) byAsin.set(c.asin, v);
    if (c.fnsku) byFnsku.set(c.fnsku, v);
    if (c.sku) bySku.set(c.sku, v);
  }

  // Compute uplift per row.
  const candidates: Array<Record<string, unknown>> = [];
  let totalUplift = 0;
  const now = new Date();
  for (const r of reimbursements) {
    const cost =
      (r.asin && byAsin.get(r.asin)) ??
      (r.fnsku && byFnsku.get(r.fnsku)) ??
      (r.sku && bySku.get(r.sku));
    if (!cost) continue;
    const qty = Number(r.quantity_reimbursed_total) || 0;
    const paid = Number(r.amount_total) || 0;
    if (qty <= 0) continue;
    const expected = cost * qty;
    const uplift = expected - paid;
    if (uplift < minUplift) continue;
    const ageDays = r.approval_date
      ? Math.floor((now.getTime() - new Date(r.approval_date).getTime()) / 86_400_000)
      : null;
    candidates.push({
      id: r.id,
      reimbursement_id: r.reimbursement_id,
      approval_date: r.approval_date,
      age_days: ageDays,
      asin: r.asin,
      fnsku: r.fnsku,
      sku: r.sku,
      product_name: r.product_name,
      amazon_order_id: r.amazon_order_id,
      reason: r.reason,
      quantity: qty,
      amount_paid: Math.round(paid * 100) / 100,
      unit_cost_new: Math.round(cost * 100) / 100,
      expected_amount: Math.round(expected * 100) / 100,
      uplift_cad: Math.round(uplift * 100) / 100,
      within_90d: ageDays != null && ageDays <= 90,
    });
    totalUplift += uplift;
  }

  // Sort by uplift DESC (biggest recovery opportunity first).
  candidates.sort((a, b) => Number(b.uplift_cad) - Number(a.uplift_cad));

  // TODO when we add per-row workflow status : filter by status.
  // For now status is just a passthrough since we don't persist sent
  // state for disputes yet.
  void status;

  return NextResponse.json({
    ok: true,
    total_count: candidates.length,
    total_uplift_cad: Math.round(totalUplift * 100) / 100,
    within_90d_count: candidates.filter((c) => c.within_90d).length,
    within_90d_uplift_cad: Math.round(
      candidates.filter((c) => c.within_90d).reduce((s, c) => s + Number(c.uplift_cad), 0) * 100,
    ) / 100,
    candidates: candidates.slice(0, limit),
  });
}
