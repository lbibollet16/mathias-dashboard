import { NextResponse } from 'next/server';
import { syncInventoryAging } from '@/lib/sp-api/inventory-aging-sync';
import { spApiErrorResponse } from '@/lib/sp-api/client';

/**
 * POST /api/amazon/sp-api/aging-sync
 * GET  /api/amazon/sp-api/aging-sync  (cron, protected by CRON_SECRET)
 *
 * Fetches GET_FBA_INVENTORY_PLANNING_DATA from SP-API and snapshots the
 * age buckets per SKU into amazon_inventory_aging. One snapshot per day
 * (idempotent — re-runs overwrite the day's row).
 *
 * À chainer dans le sync quotidien après les autres reports : c'est le
 * signal qui alimente la page d'alertes "à liquider avant le 14 du mois".
 */

export const maxDuration = 300;

export async function POST() {
  try {
    const result = await syncInventoryAging();
    return NextResponse.json({ ok: result.status === 'ok' || result.status === 'empty', ...result });
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
    const result = await syncInventoryAging();
    return NextResponse.json({ ok: result.status === 'ok' || result.status === 'empty', ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
