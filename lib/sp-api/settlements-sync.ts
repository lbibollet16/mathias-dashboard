/**
 * Sync auto des settlements depuis SP-API Reports → Supabase.
 *
 * Remplace l'upload manuel des TSV settlements depuis Seller Central.
 * Liste les reports DONE de type `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`,
 * télécharge ceux qui ne sont pas encore en base, parse, insert.
 *
 * Idempotent : skip si settlement_id existe déjà (on ne ré-écrase pas un
 * settlement déjà fermé). Pour forcer une réimportation, supprimer la
 * ligne dans `amazon_settlements` d'abord.
 *
 * Server-only.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';
import { SkuResolver } from '@/lib/amazon-sku';
import {
  getReports,
  getReportDocument,
  downloadReportContent,
} from './reports';

/** Report type Amazon pour les settlements V2 en flat file (TSV). */
export const SETTLEMENT_REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';

// ─── Parsers (copiés de l'import manuel pour rester décorrélé) ──────────

function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === delim) {
      cur.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      cur.push(field);
      field = '';
      if (cur.length > 1 || (cur.length === 1 && cur[0] !== '')) rows.push(cur);
      cur = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = (r[j] ?? '').trim();
    out.push(obj);
  }
  return out;
}

function num(v: unknown): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (m) {
    const [, d, mo, y, hh, mm, ss] = m;
    const iso = `${y}-${mo}-${d}T${hh || '00'}:${mm || '00'}:${ss || '00'}Z`;
    const d2 = new Date(iso);
    if (!isNaN(d2.getTime())) return d2.toISOString();
  }
  const d1 = new Date(s);
  if (!isNaN(d1.getTime())) return d1.toISOString();
  return null;
}

// ─── Insert settlement + transactions ───────────────────────────────────

export interface SettlementImportResult {
  reportId: string;
  settlement_id: string | null;
  status: 'imported' | 'skipped_existing' | 'error';
  rows_inserted?: number;
  unresolved_skus?: number;
  error?: string;
}

async function importSettlementFromTsv(
  reportId: string,
  tsv: string,
  resolver: SkuResolver,
): Promise<SettlementImportResult> {
  const rows = parseDelimited(tsv, '\t');
  const objs = rowsToObjects(rows);
  if (objs.length === 0) {
    return { reportId, settlement_id: null, status: 'error', error: 'TSV vide' };
  }

  const header = objs[0];
  const settlement_id = header['settlement-id'];
  if (!settlement_id) {
    return {
      reportId,
      settlement_id: null,
      status: 'error',
      error: 'settlement-id manquant dans le header',
    };
  }

  // Skip si déjà importé (idempotence)
  const { data: existing } = await supabaseAdmin
    .from('amazon_settlements')
    .select('settlement_id, closed_at')
    .eq('settlement_id', settlement_id)
    .maybeSingle();
  if (existing) {
    return { reportId, settlement_id, status: 'skipped_existing' };
  }

  const settlementRow = {
    settlement_id,
    settlement_start: parseDate(header['settlement-start-date']),
    settlement_end: parseDate(header['settlement-end-date']),
    deposit_date: parseDate(header['deposit-date']),
    total_amount: num(header['total-amount']),
    currency: header['currency'] || null,
    marketplace: header['marketplace-name'] || null,
    file_name: `sp-api://reports/${reportId}`,
  };

  const { error: sErr } = await supabaseAdmin
    .from('amazon_settlements')
    .upsert(settlementRow, { onConflict: 'settlement_id' });
  if (sErr) {
    return { reportId, settlement_id, status: 'error', error: 'upsert settlement: ' + sErr.message };
  }

  // Transactions
  const txRows: Array<Record<string, unknown>> = [];
  let unresolved = 0;
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i];
    if (!o['transaction-type'] && !o['amount-type'] && !o['amount']) continue;

    const sku = o['sku'] || null;
    let traction_code: string | null = null;
    let resolution_source: string | null = null;
    if (sku) {
      const r = resolver.resolve(sku);
      traction_code = r.traction_code;
      resolution_source = r.source;
      if (!traction_code) unresolved++;
    }

    txRows.push({
      settlement_id,
      transaction_type: o['transaction-type'] || null,
      order_id: o['order-id'] || null,
      merchant_order_id: o['merchant-order-id'] || null,
      adjustment_id: o['adjustment-id'] || null,
      shipment_id: o['shipment-id'] || null,
      marketplace: o['marketplace-name'] || null,
      amount_type: o['amount-type'] || null,
      amount_description: o['amount-description'] || null,
      amount: num(o['amount']),
      fulfillment_id: o['fulfillment-id'] || null,
      posted_date: parseDate(o['posted-date-time'] || o['posted-date']),
      order_item_code: o['order-item-code'] || null,
      sku,
      quantity_purchased: num(o['quantity-purchased']),
      promotion_id: o['promotion-id'] || null,
      traction_code,
      resolution_source,
    });
  }

  // Insert par lots de 500
  for (let i = 0; i < txRows.length; i += 500) {
    const batch = txRows.slice(i, i + 500);
    const { error } = await supabaseAdmin.from('amazon_transactions').insert(batch);
    if (error) {
      return {
        reportId,
        settlement_id,
        status: 'error',
        error: `insert transactions batch ${i}: ${error.message}`,
      };
    }
  }

  return {
    reportId,
    settlement_id,
    status: 'imported',
    rows_inserted: txRows.length,
    unresolved_skus: unresolved,
  };
}

// ─── Sync orchestrator ──────────────────────────────────────────────────

export interface SyncSettlementsResult {
  reports_seen: number;
  imported: number;
  skipped: number;
  errors: number;
  details: SettlementImportResult[];
}

/**
 * Liste les reports settlements DONE depuis SP-API et importe ceux qui ne
 * sont pas encore en base. Renvoie un summary détaillé.
 *
 * @param opts.createdSince  ISO date — ne regarde que les reports créés
 *                            depuis cette date. Default : 60 jours.
 * @param opts.maxToImport   Cap sur le nombre de settlements à importer
 *                            par run (évite de saturer une page). Default 10.
 */
export async function syncSettlementsFromSpApi(
  opts: { createdSince?: string; maxToImport?: number } = {},
): Promise<SyncSettlementsResult> {
  const createdSince =
    opts.createdSince ?? new Date(Date.now() - 60 * 86_400_000).toISOString();
  const maxToImport = opts.maxToImport ?? 10;

  // 1. Liste tous les reports settlements DONE récents
  const allReports = [];
  let nextToken: string | undefined;
  let pages = 0;
  while (pages < 10) {
    const resp = await getReports({
      reportTypes: [SETTLEMENT_REPORT_TYPE],
      processingStatuses: ['DONE'],
      createdSince,
      pageSize: 100,
      nextToken,
    });
    allReports.push(...resp.reports);
    nextToken = resp.nextToken;
    pages++;
    if (!nextToken) break;
  }

  // 2. Charge les SKUs résolution en mémoire UNE FOIS
  const resolver = new SkuResolver();
  await resolver.init();

  const result: SyncSettlementsResult = {
    reports_seen: allReports.length,
    imported: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  // 3. Pour chacun (du plus récent au plus ancien), importer si pas déjà
  allReports.sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1));

  let importedCount = 0;
  for (const report of allReports) {
    if (importedCount >= maxToImport) break;
    if (!report.reportDocumentId) {
      result.details.push({
        reportId: report.reportId,
        settlement_id: null,
        status: 'error',
        error: 'reportDocumentId absent (report DONE mais sans document)',
      });
      result.errors++;
      continue;
    }

    try {
      const doc = await getReportDocument(report.reportDocumentId);
      const tsv = await downloadReportContent(doc);
      const r = await importSettlementFromTsv(report.reportId, tsv, resolver);
      result.details.push(r);
      if (r.status === 'imported') {
        result.imported++;
        importedCount++;
      } else if (r.status === 'skipped_existing') {
        result.skipped++;
      } else {
        result.errors++;
      }
    } catch (e) {
      result.errors++;
      result.details.push({
        reportId: report.reportId,
        settlement_id: null,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}
