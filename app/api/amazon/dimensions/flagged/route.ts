import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { buildCubiscanRequest } from '@/lib/sp-api/catalog-dimensions-sync';

/**
 * GET /api/amazon/dimensions/flagged
 *
 * Returns the rows where Amazon's recorded dimensions exceed our actual
 * dimensions by more than the threshold (volume > +10% OR weight > +15%).
 * For each row, attaches a ready-to-paste cubiscan remeasure case
 * template.
 *
 * Query params :
 *   - min_volume_pct : override the volume threshold (default uses
 *                      the flag computed in DB)
 *   - include_missing : 'true' to also return rows missing actual_*
 *                       dimensions (so the operator knows what to fill)
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const includeMissing = url.searchParams.get('include_missing') === 'true';

  // Two queries : the flagged rows (with both dims) + (optionally) the
  // rows missing actual dimensions.
  const { data: flagged, error: e1 } = await supabaseAdmin
    .from('amazon_product_dimensions')
    .select(
      'sku, fnsku, asin, product_name, actual_length_cm, actual_width_cm, actual_height_cm, actual_weight_kg, amazon_length_cm, amazon_width_cm, amazon_height_cm, amazon_weight_kg, amazon_size_tier, discrepancy_volume_pct, discrepancy_weight_pct, cubiscan_requested_at, cubiscan_resolved_at',
    )
    .eq('needs_cubiscan_request', true)
    .order('discrepancy_volume_pct', { ascending: false, nullsFirst: false });
  if (e1) {
    return NextResponse.json({ ok: false, error: e1.message }, { status: 500 });
  }

  const enriched = (flagged ?? []).map((r) => ({
    ...r,
    request: buildCubiscanRequest(r),
  }));

  let missing: unknown[] = [];
  if (includeMissing) {
    const { data: m } = await supabaseAdmin
      .from('amazon_product_dimensions')
      .select('sku, fnsku, asin, product_name, amazon_length_cm, amazon_width_cm, amazon_height_cm, amazon_weight_kg, amazon_size_tier')
      .is('actual_length_cm', null);
    missing = m ?? [];
  }

  return NextResponse.json({
    ok: true,
    total_flagged: enriched.length,
    rows: enriched,
    missing_actual: missing,
  });
}
