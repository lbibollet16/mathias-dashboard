import { NextRequest, NextResponse } from 'next/server';
import { detectMissingClaims } from '@/lib/sp-api/claims-detection';

/**
 * POST /api/amazon/claims/detect
 *
 * Scan le ledger pour identifier les events Lost/Damaged sans
 * reimbursement matché. Calcule l'estimated_amount via prix de vente
 * moyen 90j. Upsert dans amazon_claim_candidates.
 *
 * Body optionnel :
 *   - from_date : ISO date (default: 18 mois ago)
 *   - lost_only : true pour skip Damaged (default false)
 *
 * Idempotent : UNIQUE sur ledger_event_id.
 */

export const maxDuration = 300;

interface Body {
  from_date?: string;
  lost_only?: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  try {
    const result = await detectMissingClaims({
      fromDate: body.from_date,
      lostOnly: body.lost_only,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** GET pour cron quotidien. */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  try {
    const result = await detectMissingClaims({});
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
