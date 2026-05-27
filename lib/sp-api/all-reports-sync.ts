/**
 * Sync auto des 4 reports manuels restants:
 *   - Reimbursements        (FBA Lost/Damaged remboursements)
 *   - FBA Inventory         (snapshot stock par SKU)
 *   - Customer Returns      (retours clients)
 *   - Removal Orders        (removal orders Amazon)
 *
 * Chaque fonction suit le meme pattern:
 *   1. createReport via fetchReportAsObjects()
 *   2. wait DONE, download, parse en objets
 *   3. mapper specifique au schema de chaque table
 *   4. upsert avec onConflict approprie
 *
 * Server-only.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';
import { SkuResolver } from '@/lib/amazon-sku';
import { fetchReportAsObjects, num, parseDate } from './report-downloader';

const MARKETPLACE_CA = 'A2EUQ1WTGCTBG2';

// ──────────────────────────────────────────────────────────────────────
// 1. Reimbursements
// ──────────────────────────────────────────────────────────────────────

const REIMBURSEMENTS_REPORT_TYPE = 'GET_FBA_REIMBURSEMENTS_DATA';

export interface ReimbursementsSyncResult {
  reportId?: string;
  status: 'ok' | 'error' | 'empty';
  rows_seen?: number;
  rows_upserted?: number;
  unresolved_skus?: number;
  duplicates_deduped?: number;
  error?: string;
}

export async function syncReimbursements(opts: {
  fromDate?: string;
  toDate?: string;
} = {}): Promise<ReimbursementsSyncResult> {
  try {
    const fromDate = opts.fromDate ?? new Date(Date.now() - 90 * 86_400_000).toISOString();
    const toDate = opts.toDate ?? new Date().toISOString();

    const fetch = await fetchReportAsObjects({
      reportType: REIMBURSEMENTS_REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_CA],
      dataStartTime: fromDate,
      dataEndTime: toDate,
    });
    if (fetch.status === 'EMPTY') {
      return { reportId: fetch.reportId, status: 'empty', rows_seen: 0 };
    }
    if (fetch.status !== 'DONE') {
      return { reportId: fetch.reportId, status: 'error', error: fetch.error };
    }

    const resolver = new SkuResolver();
    await resolver.init();

    const rowsById = new Map<string, Record<string, unknown>>();
    let unresolved = 0;
    let duplicates = 0;
    for (const o of fetch.rows) {
      const reimbursement_id = o['reimbursement-id'];
      if (!reimbursement_id) continue;
      const sku = o['sku'] || null;
      let traction_code: string | null = null;
      let resolution_source: string | null = null;
      if (sku) {
        const r = resolver.resolve(sku);
        traction_code = r.traction_code;
        resolution_source = r.source;
        if (!traction_code) unresolved++;
      }
      const row = {
        reimbursement_id,
        approval_date: parseDate(o['approval-date']),
        case_id: o['case-id'] || null,
        amazon_order_id: o['amazon-order-id'] || null,
        reason: o['reason'] || null,
        sku,
        fnsku: o['fnsku'] || null,
        asin: o['asin'] || null,
        product_name: o['product-name'] || null,
        currency: o['currency-unit'] || null,
        amount_per_unit: num(o['amount-per-unit']),
        amount_total: num(o['amount-total']),
        quantity_reimbursed_cash: num(o['quantity-reimbursed-cash']),
        quantity_reimbursed_inventory: num(o['quantity-reimbursed-inventory']),
        quantity_reimbursed_total: num(o['quantity-reimbursed-total']),
        original_reimbursement_id: o['original-reimbursement-id'] || null,
        original_reimbursement_type: o['original-reimbursement-type'] || null,
        traction_code,
        resolution_source,
      };
      if (rowsById.has(reimbursement_id)) duplicates++;
      rowsById.set(reimbursement_id, row);
    }
    const rows = Array.from(rowsById.values());

    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('amazon_reimbursements')
        .upsert(batch, { onConflict: 'reimbursement_id' });
      if (error) {
        return {
          reportId: fetch.reportId,
          status: 'error',
          rows_seen: fetch.rows.length,
          rows_upserted: upserted,
          error: `upsert batch ${i}: ${error.message}`,
        };
      }
      upserted += batch.length;
    }

    return {
      reportId: fetch.reportId,
      status: 'ok',
      rows_seen: fetch.rows.length,
      rows_upserted: upserted,
      unresolved_skus: unresolved,
      duplicates_deduped: duplicates,
    };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────────────────────
// 2. FBA Inventory snapshot
// ──────────────────────────────────────────────────────────────────────

const FBA_INVENTORY_REPORT_TYPE = 'GET_FBA_MYI_ALL_INVENTORY_DATA';

export interface FbaInventorySyncResult {
  reportId?: string;
  status: 'ok' | 'error' | 'empty';
  snapshot_date?: string;
  rows_inserted?: number;
  unresolved_skus?: number;
  error?: string;
}

export async function syncFbaInventory(): Promise<FbaInventorySyncResult> {
  try {
    const fetch = await fetchReportAsObjects({
      reportType: FBA_INVENTORY_REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_CA],
    });
    if (fetch.status === 'EMPTY') {
      return { reportId: fetch.reportId, status: 'empty' };
    }
    if (fetch.status !== 'DONE') {
      return { reportId: fetch.reportId, status: 'error', error: fetch.error };
    }

    const today = new Date().toISOString().split('T')[0];
    // Purge le snapshot du jour (re-run idempotent dans la meme journee)
    await supabaseAdmin.from('amazon_fba_inventory').delete().eq('snapshot_date', today);

    const resolver = new SkuResolver();
    await resolver.init();

    const rows: Array<Record<string, unknown>> = [];
    let unresolved = 0;
    for (const o of fetch.rows) {
      const sku = o['sku'];
      if (!sku) continue;
      const r = resolver.resolve(sku);
      if (!r.traction_code) unresolved++;
      rows.push({
        snapshot_date: today,
        sku,
        fnsku: o['fnsku'] || null,
        asin: o['asin'] || null,
        product_name: o['product-name'] || null,
        condition: o['condition'] || null,
        your_price: num(o['your-price']),
        afn_warehouse_quantity: num(o['afn-warehouse-quantity']),
        afn_fulfillable_quantity: num(o['afn-fulfillable-quantity']),
        afn_unsellable_quantity: num(o['afn-unsellable-quantity']),
        afn_reserved_quantity: num(o['afn-reserved-quantity']),
        afn_total_quantity: num(o['afn-total-quantity']),
        afn_inbound_working_quantity: num(o['afn-inbound-working-quantity']),
        afn_inbound_shipped_quantity: num(o['afn-inbound-shipped-quantity']),
        afn_inbound_receiving_quantity: num(o['afn-inbound-receiving-quantity']),
        traction_code: r.traction_code,
        resolution_source: r.source,
      });
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin.from('amazon_fba_inventory').insert(batch);
      if (error) {
        return {
          reportId: fetch.reportId,
          status: 'error',
          snapshot_date: today,
          rows_inserted: inserted,
          error: `insert batch ${i}: ${error.message}`,
        };
      }
      inserted += batch.length;
    }

    return {
      reportId: fetch.reportId,
      status: 'ok',
      snapshot_date: today,
      rows_inserted: inserted,
      unresolved_skus: unresolved,
    };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────────────────────
// 3. Customer Returns
// ──────────────────────────────────────────────────────────────────────

const CUSTOMER_RETURNS_REPORT_TYPE = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';

export interface CustomerReturnsSyncResult {
  reportId?: string;
  status: 'ok' | 'error' | 'empty';
  rows_seen?: number;
  rows_upserted?: number;
  skipped_no_lpn?: number;
  error?: string;
}

export async function syncCustomerReturns(opts: {
  fromDate?: string;
  toDate?: string;
} = {}): Promise<CustomerReturnsSyncResult> {
  try {
    const fromDate = opts.fromDate ?? new Date(Date.now() - 60 * 86_400_000).toISOString();
    const toDate = opts.toDate ?? new Date().toISOString();

    const fetch = await fetchReportAsObjects({
      reportType: CUSTOMER_RETURNS_REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_CA],
      dataStartTime: fromDate,
      dataEndTime: toDate,
    });
    if (fetch.status === 'EMPTY') {
      return { reportId: fetch.reportId, status: 'empty', rows_seen: 0 };
    }
    if (fetch.status !== 'DONE') {
      return { reportId: fetch.reportId, status: 'error', error: fetch.error };
    }

    const rowsByLpn = new Map<string, Record<string, unknown>>();
    let skipped_no_lpn = 0;
    for (const o of fetch.rows) {
      const lpn = (o['license-plate-number'] || '').trim();
      if (!lpn) {
        skipped_no_lpn++;
        continue;
      }
      rowsByLpn.set(lpn, {
        license_plate_number: lpn,
        return_date: parseDate(o['return-date']),
        order_id: o['order-id'] || null,
        sku: o['sku'] || null,
        asin: o['asin'] || null,
        fnsku: o['fnsku'] || null,
        product_name: o['product-name'] || null,
        quantity: num(o['quantity']) || 1,
        fulfillment_center_id: o['fulfillment-center-id'] || null,
        detailed_disposition: o['detailed-disposition'] || null,
        reason: o['reason'] || null,
        status: o['status'] || null,
        customer_comments: o['customer-comments'] || null,
        source_file: 'sp-api://reports/' + fetch.reportId,
      });
    }
    const rows = Array.from(rowsByLpn.values());

    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('amazon_customer_returns')
        .upsert(batch, { onConflict: 'license_plate_number' });
      if (error) {
        return {
          reportId: fetch.reportId,
          status: 'error',
          rows_seen: fetch.rows.length,
          rows_upserted: upserted,
          error: `upsert batch ${i}: ${error.message}`,
        };
      }
      upserted += batch.length;
    }

    return {
      reportId: fetch.reportId,
      status: 'ok',
      rows_seen: fetch.rows.length,
      rows_upserted: upserted,
      skipped_no_lpn,
    };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────────────────────
// 4. Removal Orders
// ──────────────────────────────────────────────────────────────────────

const REMOVAL_ORDERS_REPORT_TYPE = 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA';

export interface RemovalOrdersSyncResult {
  reportId?: string;
  status: 'ok' | 'error' | 'empty';
  rows_seen?: number;
  rows_upserted?: number;
  error?: string;
}

export async function syncRemovalOrders(opts: {
  fromDate?: string;
  toDate?: string;
} = {}): Promise<RemovalOrdersSyncResult> {
  try {
    const fromDate = opts.fromDate ?? new Date(Date.now() - 90 * 86_400_000).toISOString();
    const toDate = opts.toDate ?? new Date().toISOString();

    const fetch = await fetchReportAsObjects({
      reportType: REMOVAL_ORDERS_REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_CA],
      dataStartTime: fromDate,
      dataEndTime: toDate,
    });
    if (fetch.status === 'EMPTY') {
      return { reportId: fetch.reportId, status: 'empty', rows_seen: 0 };
    }
    if (fetch.status !== 'DONE') {
      return { reportId: fetch.reportId, status: 'error', error: fetch.error };
    }

    const rowsByKey = new Map<string, Record<string, unknown>>();
    for (const o of fetch.rows) {
      const order_id = o['order-id'];
      const sku = o['sku'];
      if (!order_id || !sku) continue;
      rowsByKey.set(`${order_id}|${sku}`, {
        order_id,
        sku,
        fnsku: o['fnsku'] || null,
        request_date: parseDate(o['request-date']),
        last_updated_date: parseDate(o['last-updated-date']),
        order_source: o['order-source'] || null,
        order_type: o['order-type'] || null,
        order_status: o['order-status'] || null,
        disposition: o['disposition'] || null,
        requested_quantity: num(o['requested-quantity']),
        cancelled_quantity: num(o['cancelled-quantity']),
        disposed_quantity: num(o['disposed-quantity']),
        shipped_quantity: num(o['shipped-quantity']),
        in_process_quantity: num(o['in-process-quantity']),
        removal_fee: num(o['removal-fee']),
        currency: o['currency'] || null,
      });
    }
    const rows = Array.from(rowsByKey.values());

    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('amazon_removal_orders')
        .upsert(batch, { onConflict: 'order_id,sku' });
      if (error) {
        return {
          reportId: fetch.reportId,
          status: 'error',
          rows_seen: fetch.rows.length,
          rows_upserted: upserted,
          error: `upsert batch ${i}: ${error.message}`,
        };
      }
      upserted += batch.length;
    }

    return {
      reportId: fetch.reportId,
      status: 'ok',
      rows_seen: fetch.rows.length,
      rows_upserted: upserted,
    };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Orchestrator : run all 4 + ledger + claims detection
// ──────────────────────────────────────────────────────────────────────

export interface SyncAllResult {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  reimbursements: ReimbursementsSyncResult;
  fba_inventory: FbaInventorySyncResult;
  customer_returns: CustomerReturnsSyncResult;
  removal_orders: RemovalOrdersSyncResult;
}

/**
 * Run les 4 syncs en sequence (pas en parallele pour respecter les
 * rate limits SP-API Reports).
 */
export async function syncAllAmazonReports(): Promise<SyncAllResult> {
  const startedAt = new Date();
  const reimbursements = await syncReimbursements();
  const fba_inventory = await syncFbaInventory();
  const customer_returns = await syncCustomerReturns();
  const removal_orders = await syncRemovalOrders();
  const finishedAt = new Date();
  return {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    reimbursements,
    fba_inventory,
    customer_returns,
    removal_orders,
  };
}
