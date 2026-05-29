import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/claims/list?status=pending&eligible=true&min_amount=10
 *
 * Returns the list of `amazon_claim_candidates` rows for the claims
 * workflow on /amazon-sp-api/claims. Default filtering : status='pending'
 * AND eligible_to_claim=true (= ready to send to Amazon today).
 *
 * Query params (all optional) :
 *   - status     : 'pending'|'sent'|'paid'|'rejected'|'expired'|'ignored'|'all'
 *                  default 'pending'
 *   - eligible   : 'true'|'false'|'all'  default 'true'
 *   - min_amount : float ; skip rows under that estimated_amount
 *   - has_cost   : 'true' to require estimated_amount IS NOT NULL
 *   - order      : 'amount_desc'|'date_asc'|'days_asc'  default amount_desc
 *   - limit      : 1..500 default 200
 *
 * Returns { ok, total, filtered_count, total_estimated_amount, candidates }
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const status = url.searchParams.get('status') ?? 'pending';
  const eligible = url.searchParams.get('eligible') ?? 'true';
  const minAmountRaw = url.searchParams.get('min_amount');
  const minAmount = minAmountRaw != null ? Number(minAmountRaw) : null;
  const hasCost = url.searchParams.get('has_cost') === 'true';
  // Confidence : 'high' | 'medium' | 'low' | 'high+medium' | 'all'
  // Default 'high+medium' parce que les VendorReturns Low Confidence
  // peuvent flooder la liste (500+ vs 192 Adjustments).
  const confidence = url.searchParams.get('confidence') ?? 'high+medium';
  const order = url.searchParams.get('order') ?? 'amount_desc';
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200)));

  let q = supabaseAdmin
    .from('amazon_claim_candidates')
    .select(
      'id, ledger_event_id, sku, fnsku, asin, event_date, event_type, quantity, fulfillment_center, reference_id, estimated_unit_price, estimated_amount, days_since_event, eligible_to_claim, status, claim_payload, sent_at, sent_by, amazon_case_id, resolved_at, resolved_amount, notes',
    );

  if (status !== 'all') q = q.eq('status', status);
  if (eligible !== 'all') q = q.eq('eligible_to_claim', eligible === 'true');
  if (minAmount != null && Number.isFinite(minAmount)) {
    q = q.gte('estimated_amount', minAmount);
  }
  if (hasCost) q = q.not('estimated_amount', 'is', null);

  // Confidence filter — utilise le champ claim_payload->confidence
  // (JSONB) au lieu d'une colonne dédiée pour éviter une migration.
  // Postgres : claim_payload->>'confidence' renvoie le texte.
  if (confidence === 'high') {
    q = q.eq('claim_payload->>confidence', 'high');
  } else if (confidence === 'medium') {
    q = q.eq('claim_payload->>confidence', 'medium');
  } else if (confidence === 'low') {
    q = q.eq('claim_payload->>confidence', 'low');
  } else if (confidence === 'high+medium') {
    q = q.in('claim_payload->>confidence', ['high', 'medium']);
  }
  // 'all' = pas de filtre confidence

  switch (order) {
    case 'date_asc':
      q = q.order('event_date', { ascending: true });
      break;
    case 'days_asc':
      q = q.order('days_since_event', { ascending: false });
      break;
    case 'amount_desc':
    default:
      q = q.order('estimated_amount', { ascending: false, nullsFirst: false });
  }

  const { data, error } = await q.limit(limit);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Stats : on aggregate sur le résultat filtré pour pouvoir afficher
  // un \"x cas sélectionnés totalisant Y CAD\" en haut de la page.
  const candidates = data ?? [];
  const total_estimated_amount = candidates.reduce(
    (s, c) => s + (typeof c.estimated_amount === 'number' ? c.estimated_amount : 0),
    0,
  );

  return NextResponse.json({
    ok: true,
    total: candidates.length,
    filtered_count: candidates.length,
    total_estimated_amount: Math.round(total_estimated_amount * 100) / 100,
    candidates,
  });
}
