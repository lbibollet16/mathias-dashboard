import { NextResponse } from 'next/server';
import { syncAllAmazonReports } from '@/lib/sp-api/all-reports-sync';
import { spApiErrorResponse } from '@/lib/sp-api/client';

/**
 * POST /api/amazon/sp-api/sync-all
 * GET  /api/amazon/sp-api/sync-all  (cron, protected by CRON_SECRET)
 *
 * Run les 4 syncs en sequence:
 *   - Reimbursements        (90j lookback, idempotent par reimbursement_id)
 *   - FBA Inventory         (snapshot today, purge then insert)
 *   - Customer Returns      (60j lookback, idempotent par license_plate_number)
 *   - Removal Orders        (90j lookback, idempotent par order_id,sku)
 *
 * Total runtime typique: 4-8 minutes (chaque report Amazon prend 30-90s).
 */

export const maxDuration = 800;

export async function POST() {
  try {
    const result = await syncAllAmazonReports();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  try {
    const result = await syncAllAmazonReports();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
