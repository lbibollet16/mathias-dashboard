import { NextRequest, NextResponse } from 'next/server';
import {
  syncCatalogDimensions,
  computeDimensionDiscrepancies,
} from '@/lib/sp-api/catalog-dimensions-sync';
import { spApiErrorResponse } from '@/lib/sp-api/client';

/**
 * POST /api/amazon/dimensions/sync-amazon
 *
 * Calls Catalog Items API for every FBA ASIN we track, fills in the
 * amazon_* dimension columns, then recomputes discrepancy %.
 *
 * Body (optional) :
 *   { limit?: number; only_missing?: boolean }
 *
 * Returns the sync stats plus the new discrepancy summary.
 */

export const maxDuration = 300;

interface Body {
  limit?: number;
  only_missing?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const result = await syncCatalogDimensions({
      limit: body.limit ?? 200,
      onlyMissingAmazonSync: body.only_missing ?? false,
    });
    const summary = await computeDimensionDiscrepancies();
    return NextResponse.json({ ok: true, sync: result, discrepancy: summary });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
