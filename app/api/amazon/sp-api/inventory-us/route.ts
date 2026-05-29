import { NextResponse } from 'next/server';
import { fetchReportAsObjects, num } from '@/lib/sp-api/report-downloader';
import { spApiErrorResponse } from '@/lib/sp-api/client';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/sp-api/inventory-us
 *
 * Tire un snapshot LIVE du stock FBA US (marketplace ATVPDKIKX0DER).
 * Stocke dans `amazon_fba_inventory` avec `snapshot_date` = today
 * et un préfixe `US:` sur le SKU pour ne pas écraser le snapshot CA.
 *
 * Utilisé pour répondre à : « Amazon a-t-il perdu mon stock US ? ».
 * Si après ce snapshot tu vois 0 SKU avec qty > 0 alors qu'il devrait
 * y en avoir, on a une preuve qu'Amazon a déplacé/perdu le stock.
 *
 * Returns { ok, snapshot_date, marketplace, nb_skus_total, nb_skus_with_stock,
 *           total_units, total_value_usd, top_skus, rows_inserted, error? }
 */

export const dynamic = 'force-dynamic';
// 800s pour absorber jusqu'à 3 retries de 60s sur POST /reports + le
// polling du report + le téléchargement (Fluid Compute supporte 800s).
export const maxDuration = 800;

const MARKETPLACE_US = 'ATVPDKIKX0DER';
const FBA_INVENTORY_REPORT_TYPE = 'GET_FBA_MYI_ALL_INVENTORY_DATA';

interface InventoryRow {
  sku?: string;
  fnsku?: string;
  asin?: string;
  'product-name'?: string;
  condition?: string;
  'your-price'?: string;
  'afn-warehouse-quantity'?: string;
  'afn-fulfillable-quantity'?: string;
  'afn-unsellable-quantity'?: string;
  'afn-reserved-quantity'?: string;
  'afn-total-quantity'?: string;
  'afn-inbound-working-quantity'?: string;
  'afn-inbound-shipped-quantity'?: string;
  'afn-inbound-receiving-quantity'?: string;
}

export async function GET() {
  try {
    const fetch = await fetchReportAsObjects({
      reportType: FBA_INVENTORY_REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_US],
    });

    if (fetch.status === 'EMPTY') {
      return NextResponse.json({
        ok: true,
        marketplace: 'US',
        snapshot_date: new Date().toISOString().slice(0, 10),
        nb_skus_total: 0,
        nb_skus_with_stock: 0,
        total_units: 0,
        total_value_usd: 0,
        top_skus: [],
        rows_inserted: 0,
        message: 'Amazon a renvoyé un report VIDE pour le marketplace US. Soit ton compte US n\'a aucun SKU listé, soit ton stock US est nul.',
      });
    }

    if (fetch.status !== 'DONE') {
      return NextResponse.json(
        { ok: false, error: fetch.error ?? 'Report SP-API non DONE', report_id: fetch.reportId },
        { status: 502 },
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows: InventoryRow[] = fetch.rows;

    // Compute stats avant insert
    let totalUnits = 0;
    let totalValue = 0;
    let nbWithStock = 0;
    const topSkus: Array<{ sku: string; product_name: string; qty: number; price: number; value: number }> = [];
    for (const o of rows) {
      const qty = num(o['afn-total-quantity']);
      const price = num(o['your-price']);
      totalUnits += qty;
      totalValue += qty * price;
      if (qty > 0) {
        nbWithStock++;
        topSkus.push({
          sku: o.sku ?? '',
          product_name: o['product-name'] ?? '',
          qty,
          price,
          value: qty * price,
        });
      }
    }
    topSkus.sort((a, b) => b.value - a.value);

    // Insert en base sous un SKU préfixé "US:" pour cohabiter avec CA
    // sur la même clé (sku, snapshot_date). On purge d'abord les lignes
    // US du jour pour idempotence.
    const usSkuRows = rows.map((o) => ({
      snapshot_date: today,
      sku: `US:${o.sku ?? ''}`,
      fnsku: o.fnsku || null,
      asin: o.asin || null,
      product_name: o['product-name'] || null,
      condition: o.condition || null,
      your_price: num(o['your-price']),
      afn_warehouse_quantity: num(o['afn-warehouse-quantity']),
      afn_fulfillable_quantity: num(o['afn-fulfillable-quantity']),
      afn_unsellable_quantity: num(o['afn-unsellable-quantity']),
      afn_reserved_quantity: num(o['afn-reserved-quantity']),
      afn_total_quantity: num(o['afn-total-quantity']),
      afn_inbound_working_quantity: num(o['afn-inbound-working-quantity']),
      afn_inbound_shipped_quantity: num(o['afn-inbound-shipped-quantity']),
      afn_inbound_receiving_quantity: num(o['afn-inbound-receiving-quantity']),
      traction_code: null,
      resolution_source: 'sp-api-us',
    }));

    // Purge avant insert (re-runs idempotents)
    await supabaseAdmin
      .from('amazon_fba_inventory')
      .delete()
      .eq('snapshot_date', today)
      .like('sku', 'US:%');

    let inserted = 0;
    for (let i = 0; i < usSkuRows.length; i += 500) {
      const batch = usSkuRows.slice(i, i + 500);
      const { error } = await supabaseAdmin.from('amazon_fba_inventory').insert(batch);
      if (error) {
        return NextResponse.json({
          ok: false,
          error: `insert batch ${i}: ${error.message}`,
          report_id: fetch.reportId,
          rows_inserted: inserted,
          nb_skus_total: rows.length,
        }, { status: 500 });
      }
      inserted += batch.length;
    }

    return NextResponse.json({
      ok: true,
      marketplace: 'US (ATVPDKIKX0DER)',
      snapshot_date: today,
      report_id: fetch.reportId,
      nb_skus_total: rows.length,
      nb_skus_with_stock: nbWithStock,
      nb_skus_zero: rows.length - nbWithStock,
      total_units: totalUnits,
      total_value_usd: Math.round(totalValue * 100) / 100,
      top_skus: topSkus.slice(0, 20),
      rows_inserted: inserted,
    });
  } catch (err) {
    const { body, status } = spApiErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
