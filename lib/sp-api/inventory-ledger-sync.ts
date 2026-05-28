/**
 * Sync Inventory Ledger depuis SP-API → amazon_inventory_ledger.
 *
 * Le report Amazon `GET_LEDGER_DETAIL_VIEW_DATA` liste TOUS les mouvements
 * de stock FBA (Receipts, Damaged, Lost, Found, Returns, Disposed,
 * Removals, Misplaced, Cycle Count, ...). C'est la source unique de
 * vérité pour comprendre ce qui se passe entre 2 snapshots d'inventaire.
 *
 * Stratégie de download :
 *   - On crée un report avec un dataStartTime/dataEndTime explicite
 *   - Amazon génère le report (typiquement 30-90s)
 *   - On poll jusqu'à DONE puis download
 *   - On parse le TSV et upsert dans amazon_inventory_ledger
 *
 * Plage max par report : ~60 jours selon obs Amazon. Pour le backfill de
 * 8 mois, on chunke en blocs de 30 jours pour rester safe.
 *
 * Idempotent : UNIQUE constraint sur (event_date, sku, event_type, qty,
 * fulfillment_center, reference_id). Re-run écrase pas.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';
import {
  createReport,
  waitForReport,
  getReportDocument,
  downloadReportContent,
} from './reports';

const LEDGER_REPORT_TYPE = 'GET_LEDGER_DETAIL_VIEW_DATA';

const MARKETPLACE_CA = 'A2EUQ1WTGCTBG2';
const MARKETPLACE_US = 'ATVPDKIKX0DER';

interface LedgerRow {
  event_date: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  product_name: string | null;
  event_type: string;
  disposition: string | null;
  quantity: number;
  reason: string | null;
  fulfillment_center: string | null;
  reference_id: string | null;
  country: string | null;
  reconciled_date: string | null;
  reconcile_reason: string | null;
  raw: Record<string, string>;
}

// ─── Parsing TSV (le report est tab-separated) ───────────────────────────

function parseTsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (cells[j] ?? '').trim();
    out.push(obj);
  }
  return out;
}

function parseDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Amazon ledger date format : "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Fallback ISO
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function num(v: unknown): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

/**
 * Lookup tolérant aux variantes de noms de colonnes Amazon (snake_case,
 * camelCase, Title Case, lowercase, avec ou sans espaces). Le ledger
 * change parfois de format selon la version du report.
 */
function pick(o: Record<string, string>, ...keys: string[]): string | null {
  // Match exact d'abord (rapide)
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== '') return v;
  }
  // Match case-insensitive + normalisé (espaces/underscores/dashes ignorés)
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const normTargets = keys.map(norm);
  for (const [actualKey, value] of Object.entries(o)) {
    if (value === undefined || value === '') continue;
    if (normTargets.includes(norm(actualKey))) return value;
  }
  return null;
}

function mapRow(o: Record<string, string>): LedgerRow | null {
  const event_date = parseDate(pick(o, 'Date', 'date', 'EventDate', 'event_date'));
  if (!event_date) return null;
  const event_type = (pick(o, 'Event Type', 'event_type', 'EventType') || '').trim();
  if (!event_type) return null;
  return {
    event_date,
    fnsku: pick(o, 'FNSKU', 'fnsku', 'Fnsku'),
    asin: pick(o, 'ASIN', 'asin', 'Asin'),
    sku: pick(o, 'MSKU', 'Merchant SKU', 'msku', 'sku', 'Sku', 'merchant_sku', 'SellerSKU'),
    product_name: pick(o, 'Title', 'title', 'product_name', 'ProductName', 'product-name'),
    event_type,
    disposition: pick(o, 'Disposition', 'disposition'),
    quantity: num(pick(o, 'Quantity', 'quantity', 'Qty', 'qty')),
    reason: pick(o, 'Reason', 'reason'),
    fulfillment_center: pick(o, 'Fulfillment Center', 'fulfillment_center', 'FulfillmentCenter', 'FC', 'fc'),
    reference_id: pick(o, 'Reference ID', 'reference_id', 'ReferenceID', 'reference-id'),
    country: pick(o, 'Country', 'country'),
    reconciled_date: parseDate(pick(o, 'Reconciled Date', 'reconciled_date', 'ReconciledDate')),
    reconcile_reason: pick(o, 'Reconcile Reason', 'reconcile_reason', 'ReconcileReason'),
    raw: o,
  };
}

// ─── Sync pour 1 chunk de dates ──────────────────────────────────────────

export interface LedgerChunkResult {
  dataStartTime: string;
  dataEndTime: string;
  reportId?: string;
  status: 'ok' | 'error' | 'empty';
  rows_seen?: number;          // total lignes parsées du TSV
  rows_mapped?: number;        // lignes mappées avec succès (event_date + event_type non null)
  rows_rejected?: number;      // lignes filtrées par mapRow (date ou type absent)
  rows_inserted?: number;      // effectivement upserts (= rows_mapped si pas d'erreur)
  headers_detected?: string[]; // colonnes du TSV (utile pour debug)
  sample_rejected?: Record<string, string>; // premier obj rejeté pour debug
  error?: string;
}

export async function syncLedgerChunk(
  dataStartTime: string,
  dataEndTime: string,
  marketplaceId: string = MARKETPLACE_CA,
): Promise<LedgerChunkResult> {
  try {
    // 1. Trigger report
    const { reportId } = await createReport({
      reportType: LEDGER_REPORT_TYPE,
      marketplaceIds: [marketplaceId],
      dataStartTime,
      dataEndTime,
      reportOptions: {
        aggregateByLocation: 'FC',
        aggregatedByTimePeriod: 'DAILY',
      },
    });

    // 2. Wait DONE (up to 5 min)
    const report = await waitForReport(reportId, {
      maxWaitMs: 5 * 60_000,
      pollIntervalMs: 5_000,
    });

    if (report.processingStatus !== 'DONE') {
      return {
        dataStartTime,
        dataEndTime,
        reportId,
        status: 'error',
        error: `report finished with status ${report.processingStatus}`,
      };
    }

    if (!report.reportDocumentId) {
      return {
        dataStartTime,
        dataEndTime,
        reportId,
        status: 'empty',
      };
    }

    // 3. Download
    const doc = await getReportDocument(report.reportDocumentId);
    const tsv = await downloadReportContent(doc);
    const objs = parseTsv(tsv);

    // Extract headers for debug (toujours dans la réponse)
    const headers = objs.length > 0 ? Object.keys(objs[0]) : [];

    if (objs.length === 0) {
      return {
        dataStartTime,
        dataEndTime,
        reportId,
        status: 'empty',
        rows_seen: 0,
        rows_mapped: 0,
        rows_rejected: 0,
        headers_detected: headers,
      };
    }

    // 4. Map + upsert par batch
    const mapped: LedgerRow[] = [];
    let firstRejected: Record<string, string> | undefined;
    for (const o of objs) {
      const m = mapRow(o);
      if (m) mapped.push(m);
      else if (!firstRejected) firstRejected = o;
    }
    const rows = mapped;
    const rejected = objs.length - mapped.length;

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('amazon_inventory_ledger')
        .upsert(batch, {
          onConflict: 'event_date,sku,event_type,quantity,fulfillment_center,reference_id',
          ignoreDuplicates: true,
        });
      if (error) {
        return {
          dataStartTime,
          dataEndTime,
          reportId,
          status: 'error',
          rows_seen: objs.length,
          rows_mapped: rows.length,
          rows_rejected: rejected,
          rows_inserted: inserted,
          headers_detected: headers,
          sample_rejected: firstRejected,
          error: `upsert batch ${i}: ${error.message}`,
        };
      }
      inserted += batch.length;
    }

    return {
      dataStartTime,
      dataEndTime,
      reportId,
      status: 'ok',
      rows_seen: objs.length,
      rows_mapped: rows.length,
      rows_rejected: rejected,
      rows_inserted: inserted,
      headers_detected: headers,
      ...(rejected > 0 && firstRejected ? { sample_rejected: firstRejected } : {}),
    };
  } catch (e) {
    return {
      dataStartTime,
      dataEndTime,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Sync multi-chunks (backfill) ────────────────────────────────────────

export interface SyncLedgerResult {
  chunks: LedgerChunkResult[];
  total_rows_inserted: number;
  total_errors: number;
}

/**
 * Sync le ledger sur une plage donnée, chunkée en blocs de N jours.
 *
 * @param fromDate  ISO date (start, inclusive)
 * @param toDate    ISO date (end, inclusive)
 * @param chunkDays default 30 (limite Amazon ~60j max par report)
 */
export async function syncLedgerRange(
  fromDate: string,
  toDate: string,
  chunkDays = 30,
  marketplaceId: string = MARKETPLACE_CA,
): Promise<SyncLedgerResult> {
  const chunks: LedgerChunkResult[] = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);

  let cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const dataStartTime = cursor.toISOString();
    const dataEndTime = chunkEnd.toISOString();

    const r = await syncLedgerChunk(dataStartTime, dataEndTime, marketplaceId);
    chunks.push(r);

    cursor.setDate(chunkEnd.getDate() + 1);
  }

  return {
    chunks,
    total_rows_inserted: chunks.reduce((s, c) => s + (c.rows_inserted ?? 0), 0),
    total_errors: chunks.filter((c) => c.status === 'error').length,
  };
}

/**
 * Sync incrémental quotidien — re-fetche les derniers N jours pour
 * capter les reconciliations tardives d'Amazon.
 */
export async function syncLedgerRecent(daysBack = 7): Promise<SyncLedgerResult> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - daysBack);
  return syncLedgerRange(
    start.toISOString(),
    end.toISOString(),
    daysBack, // un seul chunk
  );
}

/**
 * Backfill historique — utilise les 8 derniers mois (~240 jours) en chunks
 * de 30j. Total ~8 reports Amazon à générer. Peut prendre 10-20 min.
 */
export async function backfillLedger8Months(): Promise<SyncLedgerResult> {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 8);
  return syncLedgerRange(start.toISOString(), end.toISOString(), 30);
}
