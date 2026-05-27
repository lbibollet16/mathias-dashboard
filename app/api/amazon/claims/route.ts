import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/claims?status=pending&limit=100
 *
 * Liste les claim candidates pour le dashboard.
 * Retourne aussi un summary global (total à réclamer, montant en attente, etc.)
 *
 * PATCH /api/amazon/claims?id=N body={ status, sent_by?, amazon_case_id?, resolved_amount?, notes? }
 *
 * Met à jour le statut d'un claim après que l'admin l'ait envoyé /
 * qu'Amazon ait répondu.
 */

const ALLOWED_STATUSES = [
  'pending',
  'ignored',
  'sent',
  'accepted',
  'paid',
  'rejected',
  'expired',
];

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const status = url.searchParams.get('status');
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '100')));
  const sort = url.searchParams.get('sort') ?? 'estimated_amount_desc';
  const eligibleOnly = url.searchParams.get('eligible_only') === 'true';

  let q = supabaseAdmin
    .from('amazon_claim_candidates')
    .select('*', { count: 'exact' })
    .limit(limit);
  if (status && ALLOWED_STATUSES.includes(status)) q = q.eq('status', status);
  if (eligibleOnly) q = q.eq('eligible_to_claim', true);

  if (sort === 'estimated_amount_desc') {
    q = q.order('estimated_amount', { ascending: false, nullsFirst: false });
  } else if (sort === 'event_date_desc') {
    q = q.order('event_date', { ascending: false });
  } else if (sort === 'event_date_asc') {
    q = q.order('event_date', { ascending: true });
  }

  const { data, count, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Summary global pour le dashboard
  const summary = await loadSummary();

  return NextResponse.json({
    ok: true,
    total: count ?? data?.length ?? 0,
    summary,
    candidates: data ?? [],
  });
}

interface ClaimSummary {
  total_candidates: number;
  pending_eligible: { count: number; estimated_amount: number };
  pending_not_yet_eligible: { count: number; estimated_amount: number };
  sent: { count: number; estimated_amount: number };
  paid: { count: number; estimated_amount: number; recovered: number };
  rejected: { count: number; estimated_amount: number };
  expired: { count: number; estimated_amount: number };
  by_event_type: Record<string, { count: number; estimated_amount: number }>;
}

async function loadSummary(): Promise<ClaimSummary> {
  const { data } = await supabaseAdmin
    .from('amazon_claim_candidates')
    .select('status, event_type, quantity, estimated_amount, eligible_to_claim, resolved_amount')
    .limit(10000);

  const sum: ClaimSummary = {
    total_candidates: 0,
    pending_eligible: { count: 0, estimated_amount: 0 },
    pending_not_yet_eligible: { count: 0, estimated_amount: 0 },
    sent: { count: 0, estimated_amount: 0 },
    paid: { count: 0, estimated_amount: 0, recovered: 0 },
    rejected: { count: 0, estimated_amount: 0 },
    expired: { count: 0, estimated_amount: 0 },
    by_event_type: {},
  };

  for (const r of (data ?? []) as Array<{
    status: string;
    event_type: string;
    quantity: number;
    estimated_amount: number | null;
    eligible_to_claim: boolean;
    resolved_amount: number | null;
  }>) {
    sum.total_candidates++;
    const est = Number(r.estimated_amount) || 0;

    if (r.status === 'pending') {
      if (r.eligible_to_claim) {
        sum.pending_eligible.count++;
        sum.pending_eligible.estimated_amount += est;
      } else {
        sum.pending_not_yet_eligible.count++;
        sum.pending_not_yet_eligible.estimated_amount += est;
      }
    } else if (r.status === 'sent' || r.status === 'accepted') {
      sum.sent.count++;
      sum.sent.estimated_amount += est;
    } else if (r.status === 'paid') {
      sum.paid.count++;
      sum.paid.estimated_amount += est;
      sum.paid.recovered += Number(r.resolved_amount) || 0;
    } else if (r.status === 'rejected') {
      sum.rejected.count++;
      sum.rejected.estimated_amount += est;
    } else if (r.status === 'expired') {
      sum.expired.count++;
      sum.expired.estimated_amount += est;
    }

    const bucket = sum.by_event_type[r.event_type] || { count: 0, estimated_amount: 0 };
    bucket.count += r.quantity;
    bucket.estimated_amount += est;
    sum.by_event_type[r.event_type] = bucket;
  }

  // Round all to 2 decimal
  for (const k of ['pending_eligible', 'pending_not_yet_eligible', 'sent', 'rejected', 'expired'] as const) {
    sum[k].estimated_amount = Math.round(sum[k].estimated_amount * 100) / 100;
  }
  sum.paid.estimated_amount = Math.round(sum.paid.estimated_amount * 100) / 100;
  sum.paid.recovered = Math.round(sum.paid.recovered * 100) / 100;
  for (const k of Object.keys(sum.by_event_type)) {
    sum.by_event_type[k].estimated_amount =
      Math.round(sum.by_event_type[k].estimated_amount * 100) / 100;
  }

  return sum;
}

export async function PATCH(request: NextRequest) {
  const url = request.nextUrl;
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id requis' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.status) {
    if (!ALLOWED_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: 'status invalide' }, { status: 400 });
    }
    patch.status = body.status;
    if (body.status === 'sent') patch.sent_at = new Date().toISOString();
    if (body.status === 'paid' || body.status === 'rejected') {
      patch.resolved_at = new Date().toISOString();
    }
  }
  if (typeof body.sent_by === 'string') patch.sent_by = body.sent_by;
  if (typeof body.amazon_case_id === 'string') patch.amazon_case_id = body.amazon_case_id;
  if (typeof body.resolved_amount === 'number') patch.resolved_amount = body.resolved_amount;
  if (typeof body.notes === 'string') patch.notes = body.notes;

  const { data, error } = await supabaseAdmin
    .from('amazon_claim_candidates')
    .update(patch)
    .eq('id', Number(id))
    .select('*')
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, candidate: data });
}
