/**
 * Catalog Items dimensions sync — pulls Amazon's measured dimensions
 * for our FBA ASINs via the Catalog Items API.
 *
 * Pourquoi : c'est la seule façon programmatique de savoir QUELLES
 * dimensions Amazon utilise pour calculer ses fees. Si elles diffèrent
 * de nos mesures réelles, on a une candidate à Cubiscan remeasure
 * request — Amazon ré-évalue 2× par 30 jours par SKU, et si tu prouves
 * l'overcharge tu peux récupérer les fees gonflés des 90 derniers
 * jours (window de dispute).
 *
 * Endpoint utilisé : GET /catalog/2022-04-01/items/{asin}?
 *   marketplaceIds=A2EUQ1WTGCTBG2&includedData=dimensions,attributes
 *
 * Rate limit Amazon : 2 req/s steady, burst 2 → on respecte 500ms entre
 * deux calls. Pour 150 ASINs FBA = ~75 secondes. Vercel maxDuration=300
 * laisse marge.
 *
 * Server-only.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';
import { spApiCall } from './client';

const MARKETPLACE_CA = 'A2EUQ1WTGCTBG2';

interface CatalogItemResponse {
  asin?: string;
  attributes?: {
    item_package_dimensions?: Array<{
      length?: { value?: number; unit?: string };
      width?: { value?: number; unit?: string };
      height?: { value?: number; unit?: string };
    }>;
    item_package_weight?: Array<{
      value?: number;
      unit?: string;
    }>;
    item_dimensions?: Array<{
      length?: { value?: number; unit?: string };
      width?: { value?: number; unit?: string };
      height?: { value?: number; unit?: string };
    }>;
    item_weight?: Array<{
      value?: number;
      unit?: string;
    }>;
    size_classification?: Array<{ value?: string }>;
  };
  summaries?: Array<{
    itemClassification?: string;
    sizeClassification?: string;
    itemDimensions?: {
      length?: { value?: number; unit?: string };
      width?: { value?: number; unit?: string };
      height?: { value?: number; unit?: string };
      weight?: { value?: number; unit?: string };
    };
  }>;
}

// Convert any Amazon dimension to centimeters / kilograms.
function toCm(value: number | undefined, unit: string | undefined): number | null {
  if (value == null) return null;
  const u = (unit ?? 'centimeters').toLowerCase();
  if (u.startsWith('cent') || u === 'cm') return Math.round(value * 100) / 100;
  if (u.startsWith('millim') || u === 'mm') return Math.round((value / 10) * 100) / 100;
  if (u.startsWith('met') || u === 'm') return Math.round(value * 100 * 100) / 100;
  if (u.startsWith('inch') || u === 'in') return Math.round(value * 2.54 * 100) / 100;
  if (u.startsWith('foot') || u === 'ft') return Math.round(value * 30.48 * 100) / 100;
  return value; // fallback
}

function toKg(value: number | undefined, unit: string | undefined): number | null {
  if (value == null) return null;
  const u = (unit ?? 'kilograms').toLowerCase();
  if (u.startsWith('kilo') || u === 'kg') return Math.round(value * 1000) / 1000;
  if (u.startsWith('gram') || u === 'g') return Math.round((value / 1000) * 1000) / 1000;
  if (u.startsWith('pound') || u === 'lb' || u === 'lbs') return Math.round(value * 0.453592 * 1000) / 1000;
  if (u.startsWith('ounce') || u === 'oz') return Math.round(value * 0.0283495 * 1000) / 1000;
  return value;
}

function extractDimensions(payload: CatalogItemResponse): {
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  size_tier: string | null;
} {
  // Try summaries.itemDimensions first (newest Amazon format).
  const summary = payload.summaries?.[0];
  if (summary?.itemDimensions) {
    const d = summary.itemDimensions;
    return {
      length_cm: toCm(d.length?.value, d.length?.unit),
      width_cm: toCm(d.width?.value, d.width?.unit),
      height_cm: toCm(d.height?.value, d.height?.unit),
      weight_kg: toKg(d.weight?.value, d.weight?.unit),
      size_tier: summary.sizeClassification ?? null,
    };
  }
  // Fall back to attributes (legacy paths).
  const attrs = payload.attributes;
  const pkgDim = attrs?.item_package_dimensions?.[0] ?? attrs?.item_dimensions?.[0];
  const pkgWt = attrs?.item_package_weight?.[0] ?? attrs?.item_weight?.[0];
  const sizeTier = attrs?.size_classification?.[0]?.value ?? null;
  return {
    length_cm: pkgDim ? toCm(pkgDim.length?.value, pkgDim.length?.unit) : null,
    width_cm: pkgDim ? toCm(pkgDim.width?.value, pkgDim.width?.unit) : null,
    height_cm: pkgDim ? toCm(pkgDim.height?.value, pkgDim.height?.unit) : null,
    weight_kg: pkgWt ? toKg(pkgWt.value, pkgWt.unit) : null,
    size_tier: sizeTier,
  };
}

export interface CatalogSyncResult {
  asins_targeted: number;
  asins_fetched: number;
  rows_upserted: number;
  errors: Array<{ asin: string; error: string }>;
  rate_limited_at?: string;
}

/**
 * Iterate over every FBA ASIN we currently track in amazon_listings,
 * call Catalog Items API, parse dimensions, upsert into
 * amazon_product_dimensions. Respect 500ms pacing to stay under Amazon's
 * 2 req/s steady rate limit.
 */
export async function syncCatalogDimensions(opts: {
  limit?: number;
  onlyMissingAmazonSync?: boolean;
} = {}): Promise<CatalogSyncResult> {
  // Pull the FBA-relevant SKUs : we already have them via amazon_sku_costs
  // (the bridge from MPP only pushes FBA/FBM/A SKUs, not DSK).
  const { data: skus, error } = await supabaseAdmin
    .from('amazon_sku_costs')
    .select('sku, fnsku, asin')
    .not('asin', 'is', null)
    .limit(opts.limit ?? 200);
  if (error) {
    return {
      asins_targeted: 0,
      asins_fetched: 0,
      rows_upserted: 0,
      errors: [{ asin: '*', error: error.message }],
    };
  }

  // Optionally skip ASINs we've already synced recently (24h).
  let targets = skus ?? [];
  if (opts.onlyMissingAmazonSync) {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from('amazon_product_dimensions')
      .select('sku')
      .gte('amazon_synced_at', cutoff);
    const recentSet = new Set((recent ?? []).map((r) => r.sku));
    targets = targets.filter((s) => !recentSet.has(s.sku));
  }

  const result: CatalogSyncResult = {
    asins_targeted: targets.length,
    asins_fetched: 0,
    rows_upserted: 0,
    errors: [],
  };

  for (const target of targets) {
    const asin = target.asin as string;
    try {
      const payload = await spApiCall<CatalogItemResponse>({
        path: `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
        query: {
          marketplaceIds: [MARKETPLACE_CA],
          includedData: ['dimensions', 'attributes', 'summaries'],
        },
      });
      result.asins_fetched++;

      const dims = extractDimensions(payload);
      const upsertPayload: Record<string, unknown> = {
        sku: target.sku,
        fnsku: target.fnsku ?? null,
        asin,
        amazon_length_cm: dims.length_cm,
        amazon_width_cm: dims.width_cm,
        amazon_height_cm: dims.height_cm,
        amazon_weight_kg: dims.weight_kg,
        amazon_size_tier: dims.size_tier,
        amazon_item_dimensions_raw: payload as unknown,
        amazon_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { error: upErr } = await supabaseAdmin
        .from('amazon_product_dimensions')
        .upsert(upsertPayload, { onConflict: 'sku' });
      if (upErr) {
        result.errors.push({ asin, error: 'upsert: ' + upErr.message });
      } else {
        result.rows_upserted++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ asin, error: msg.slice(0, 200) });
      // 429 => stop pour pas s'enfoncer dans le rate limit.
      if (/\b429\b/.test(msg)) {
        result.rate_limited_at = new Date().toISOString();
        break;
      }
    }
    // 500ms pacing between calls (2 req/s budget).
    await new Promise((r) => setTimeout(r, 500));
  }

  return result;
}

// =============================================================================
// Discrepancy computation
// =============================================================================

export interface DiscrepancySummary {
  total_rows_with_both: number;
  flagged_for_cubiscan: number;
  total_volume_overcharge_pct: number;
}

/**
 * For every row that has BOTH actual_* and amazon_* dimensions, compute
 * the discrepancy %, flag it for a cubiscan request if the threshold is
 * crossed.
 *
 * Thresholds : volume > +10% OR weight > +15%. Positive = Amazon
 * measured larger / heavier than reality = we're overcharged.
 */
export async function computeDimensionDiscrepancies(): Promise<DiscrepancySummary> {
  const { data: rows } = await supabaseAdmin
    .from('amazon_product_dimensions')
    .select(
      'sku, actual_length_cm, actual_width_cm, actual_height_cm, actual_weight_kg, amazon_length_cm, amazon_width_cm, amazon_height_cm, amazon_weight_kg',
    );

  let total = 0;
  let flagged = 0;
  let cumulativeOvercharge = 0;
  const updates: Array<{
    sku: string;
    discrepancy_volume_pct: number | null;
    discrepancy_weight_pct: number | null;
    needs_cubiscan_request: boolean;
  }> = [];

  for (const r of rows ?? []) {
    const haveActual =
      r.actual_length_cm && r.actual_width_cm && r.actual_height_cm && r.actual_weight_kg;
    const haveAmazon =
      r.amazon_length_cm && r.amazon_width_cm && r.amazon_height_cm && r.amazon_weight_kg;
    if (!haveActual || !haveAmazon) continue;

    total++;
    const actualVol =
      Number(r.actual_length_cm) * Number(r.actual_width_cm) * Number(r.actual_height_cm);
    const amazonVol =
      Number(r.amazon_length_cm) * Number(r.amazon_width_cm) * Number(r.amazon_height_cm);
    const volPct = actualVol > 0 ? ((amazonVol - actualVol) / actualVol) * 100 : 0;
    const wtPct =
      Number(r.actual_weight_kg) > 0
        ? ((Number(r.amazon_weight_kg) - Number(r.actual_weight_kg)) /
            Number(r.actual_weight_kg)) *
          100
        : 0;
    const needsRequest = volPct > 10 || wtPct > 15;
    if (needsRequest) {
      flagged++;
      cumulativeOvercharge += Math.max(0, volPct);
    }
    updates.push({
      sku: r.sku,
      discrepancy_volume_pct: Math.round(volPct * 100) / 100,
      discrepancy_weight_pct: Math.round(wtPct * 100) / 100,
      needs_cubiscan_request: needsRequest,
    });
  }

  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200);
    await supabaseAdmin
      .from('amazon_product_dimensions')
      .upsert(batch, { onConflict: 'sku' });
  }

  return {
    total_rows_with_both: total,
    flagged_for_cubiscan: flagged,
    total_volume_overcharge_pct:
      total > 0 ? Math.round((cumulativeOvercharge / total) * 100) / 100 : 0,
  };
}

// =============================================================================
// Cubiscan request template
// =============================================================================

/**
 * Generate the Seller Central case template for a cubiscan remeasure
 * request. Amazon agents recognise this language and route to the FBA
 * Inbound team.
 */
export function buildCubiscanRequest(row: {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  product_name?: string | null;
  actual_length_cm: number | null;
  actual_width_cm: number | null;
  actual_height_cm: number | null;
  actual_weight_kg: number | null;
  amazon_length_cm: number | null;
  amazon_width_cm: number | null;
  amazon_height_cm: number | null;
  amazon_weight_kg: number | null;
  discrepancy_volume_pct: number | null;
}): { case_subject: string; case_body: string; seller_central_url: string } {
  const subject = `Cubiscan remeasure request - ASIN ${row.asin ?? row.sku} - dimensional discrepancy ${row.discrepancy_volume_pct?.toFixed(1) ?? '?'}%`;

  const body = `Hello Amazon Support,

I am requesting a Cubiscan remeasurement for the following FBA item. The current Amazon-recorded dimensions appear to overstate the actual product dimensions, which is generating inflated fulfillment and storage fees. Per Amazon's measurement policy, I am entitled to request a remeasurement (up to twice per 30-day period per SKU).

ITEM:
- SKU: ${row.sku}
- FNSKU: ${row.fnsku ?? '(unknown)'}
- ASIN: ${row.asin ?? '(unknown)'}
${row.product_name ? `- Product name: ${row.product_name}\n` : ''}

ACTUAL DIMENSIONS (measured at our warehouse):
- Length × Width × Height: ${row.actual_length_cm}cm × ${row.actual_width_cm}cm × ${row.actual_height_cm}cm
- Weight: ${row.actual_weight_kg}kg

AMAZON-RECORDED DIMENSIONS:
- Length × Width × Height: ${row.amazon_length_cm}cm × ${row.amazon_width_cm}cm × ${row.amazon_height_cm}cm
- Weight: ${row.amazon_weight_kg}kg

DISCREPANCY:
- Volumetric: ${row.discrepancy_volume_pct?.toFixed(1) ?? '?'}% larger than actual

Could you please :
1. Remeasure the item using Cubiscan (multi-unit scan if available, as a single-unit scan can yield variance)
2. Update the item's recorded dimensions in our catalog
3. Process a reimbursement for any FBA fee overcharges accrued in the past 90 days resulting from the inflated dimensions

Supporting documentation (photos with ruler scale, supplier specifications) available upon request.

Thank you,
Mathias Power Parts`;

  return {
    case_subject: subject,
    case_body: body,
    seller_central_url: 'https://sellercentral.amazon.ca/help/center/contactus',
  };
}
