/**
 * Inventory aging sync — fetches Amazon's GET_FBA_INVENTORY_PLANNING_DATA
 * report and snapshots the age buckets per SKU into amazon_inventory_aging.
 *
 * Why : Amazon's Aged Inventory Surcharge kicks in at 181 days. Knowing
 * which SKUs are 90+, 180+, 270+, 365+ before the 15th of each month
 * lets the operator decide remove / discount / liquidate ahead of the
 * surcharge tick. Source: refunzo + amzprep, see Sprint 2 plan.
 *
 * Server-only.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';
import { fetchReportAsObjects } from './report-downloader';

const MARKETPLACE_CA = 'A2EUQ1WTGCTBG2';
const AGING_REPORT_TYPE = 'GET_FBA_INVENTORY_PLANNING_DATA';

export interface AgingSyncResult {
  reportId?: string;
  status: 'ok' | 'error' | 'empty';
  snapshot_date?: string;
  rows_inserted?: number;
  // Aggregates pour le résultat affiché côté UI
  at_risk_skus?: number;          // total SKUs avec qty>0 dans buckets 181+
  units_181_to_270?: number;
  units_271_to_365?: number;
  units_365_plus?: number;
  estimated_next_30d_cost?: number;
  error?: string;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function syncInventoryAging(): Promise<AgingSyncResult> {
  try {
    const fetch = await fetchReportAsObjects({
      reportType: AGING_REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_CA],
    });
    if (fetch.status === 'EMPTY') {
      return { reportId: fetch.reportId, status: 'empty' };
    }
    if (fetch.status !== 'DONE') {
      return { reportId: fetch.reportId, status: 'error', error: fetch.error };
    }

    const today = new Date().toISOString().slice(0, 10);
    // Re-run idempotent dans la journée — on purge le snapshot du jour
    // avant de réécrire.
    await supabaseAdmin.from('amazon_inventory_aging').delete().eq('snapshot_date', today);

    const rows: Array<Record<string, unknown>> = [];
    let atRisk = 0;
    let u181 = 0;
    let u271 = 0;
    let u365 = 0;
    let estCost30 = 0;

    for (const o of fetch.rows) {
      const sku = o['sku'];
      if (!sku) continue;

      // Les noms de colonnes Amazon varient légèrement entre rapports.
      // On essaye plusieurs candidats par bucket avec fallback à 0.
      const q90 = num(o['inv-age-0-to-90-days']) ?? num(o['inventory-age-0-to-90-days']) ?? 0;
      const q180 = num(o['inv-age-91-to-180-days']) ?? num(o['inventory-age-91-to-180-days']) ?? 0;
      const q270 = num(o['inv-age-181-to-270-days']) ?? num(o['inventory-age-181-to-270-days']) ?? 0;
      const q365 = num(o['inv-age-271-to-365-days']) ?? num(o['inventory-age-271-to-365-days']) ?? 0;
      const qPlus = num(o['inv-age-365-plus-days']) ?? num(o['inventory-age-365-plus-days']) ?? 0;
      const qTotal = num(o['afn-total-quantity']) ?? (q90 + q180 + q270 + q365 + qPlus);

      if ((q270 ?? 0) + (q365 ?? 0) + (qPlus ?? 0) > 0) atRisk++;
      u181 += q270 ?? 0;
      u271 += q365 ?? 0;
      u365 += qPlus ?? 0;
      const cost30 = num(o['estimated-storage-cost-next-month']) ??
                     num(o['estimated_storage_cost_next_month']) ??
                     0;
      estCost30 += cost30 ?? 0;

      rows.push({
        snapshot_date: today,
        sku,
        fnsku: o['fnsku'] || null,
        asin: o['asin'] || null,
        product_name: o['product-name'] || null,
        condition: o['condition-type'] || o['condition'] || null,
        qty_total: qTotal,
        qty_0_to_90_days: q90,
        qty_91_to_180_days: q180,
        qty_181_to_270_days: q270,
        qty_271_to_365_days: q365,
        qty_365_plus_days: qPlus,
        qty_inbound: num(o['afn-inbound-shipped-quantity']),
        qty_inbound_working: num(o['afn-inbound-working-quantity']),
        qty_inbound_shipped: num(o['afn-inbound-shipped-quantity']),
        qty_inbound_received: num(o['afn-inbound-receiving-quantity']),
        estimated_excess_quantity: num(o['estimated-excess-quantity']),
        recommended_action: o['recommended-action'] || o['sales-shipped-last-7-days'] || null,
        recommended_sales_price: num(o['recommended-sales-price']),
        recommended_sale_duration_days: num(o['recommended-sale-duration-days']),
        estimated_holding_cost_next_30_days: num(o['estimated-storage-cost-next-month']),
        raw: o,
      });
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('amazon_inventory_aging')
        .upsert(batch, { onConflict: 'snapshot_date,sku,fnsku' });
      if (!error) inserted += batch.length;
    }

    return {
      reportId: fetch.reportId,
      status: 'ok',
      snapshot_date: today,
      rows_inserted: inserted,
      at_risk_skus: atRisk,
      units_181_to_270: u181,
      units_271_to_365: u271,
      units_365_plus: u365,
      estimated_next_30d_cost: Math.round(estCost30 * 100) / 100,
    };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
