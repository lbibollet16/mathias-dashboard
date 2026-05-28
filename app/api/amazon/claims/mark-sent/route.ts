import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * POST /api/amazon/claims/mark-sent
 *
 * Marks one or more claim candidates as 'sent' to Amazon Seller Central.
 * Called when the operator confirms via the claims UI that they pasted
 * the case body into Seller Central and clicked Submit.
 *
 * Body :
 *   {
 *     ids: number[]            // amazon_claim_candidates.id values
 *     sent_by?: string         // operator email/name (free text)
 *     amazon_case_id?: string  // optional case ID returned by Seller Central
 *     notes?: string           // optional note (e.g. "batch submit 2026-05-28")
 *   }
 *
 * Réponse : { ok, updated, errors }
 */

interface Body {
  ids?: number[];
  sent_by?: string;
  amazon_case_id?: string;
  notes?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const ids = Array.isArray(body.ids) ? body.ids.filter((n) => Number.isInteger(n)) : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids[] requis' }, { status: 400 });
  }

  const sentAt = new Date().toISOString();
  // Si le caller a fourni un amazon_case_id ET il y a plusieurs ids,
  // on partage le même case_id sur toutes les rows (cas où l'opérateur
  // a groupé plusieurs claims dans 1 seul case Seller Central). Sinon
  // case_id reste null par row.
  const patch: Record<string, unknown> = {
    status: 'sent',
    sent_at: sentAt,
    sent_by: body.sent_by?.slice(0, 200) || null,
    updated_at: sentAt,
  };
  if (body.amazon_case_id) patch.amazon_case_id = body.amazon_case_id.slice(0, 100);
  if (body.notes) patch.notes = body.notes.slice(0, 2000);

  const { error, count } = await supabaseAdmin
    .from('amazon_claim_candidates')
    .update(patch, { count: 'exact' })
    .in('id', ids)
    .eq('status', 'pending'); // only flip pending rows — refuse double-sends

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    requested: ids.length,
    updated: count ?? 0,
    skipped: ids.length - (count ?? 0),
    sent_at: sentAt,
  });
}
