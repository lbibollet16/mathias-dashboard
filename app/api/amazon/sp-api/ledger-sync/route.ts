import { NextRequest, NextResponse } from 'next/server';
import {
  syncLedgerRange,
  syncLedgerRecent,
  backfillLedger8Months,
} from '@/lib/sp-api/inventory-ledger-sync';
import { spApiErrorResponse } from '@/lib/sp-api/client';

/**
 * POST /api/amazon/sp-api/ledger-sync
 *
 * Sync Inventory Ledger via SP-API GET_LEDGER_DETAIL_VIEW_DATA.
 *
 * Modes :
 *   - Body { mode: 'recent', days_back?: 7 }  → re-fetch derniers 7j (cron daily)
 *   - Body { mode: 'backfill_8m' }            → backfill 8 mois (run 1×, 10-20min)
 *   - Body { from: ISO, to: ISO, chunk_days?: 30 } → plage custom
 *
 * Default: mode 'recent' (7 jours).
 *
 * Idempotent : UNIQUE constraint sur le ledger empêche les doublons.
 * Peut être re-run sans risque.
 */

export const maxDuration = 800;

interface Body {
  mode?: 'recent' | 'backfill_8m';
  days_back?: number;
  from?: string;
  to?: string;
  chunk_days?: number;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;

  try {
    let result;
    if (body.from && body.to) {
      result = await syncLedgerRange(body.from, body.to, body.chunk_days ?? 30);
    } else if (body.mode === 'backfill_8m') {
      result = await backfillLedger8Months();
    } else {
      result = await syncLedgerRecent(body.days_back ?? 7);
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}

/** GET pour cron — invoke recent (7j). */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  try {
    const result = await syncLedgerRecent(7);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
