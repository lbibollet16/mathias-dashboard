/**
 * Helper generique pour download/parse de reports SP-API.
 *
 * Utilise par toutes les phases (reimbursements, fba-inventory, customer
 * returns, removal orders) pour eviter de dupliquer la logique
 * createReport + waitForReport + getReportDocument + downloadReportContent
 * + parseTSV.
 *
 * Server-only.
 */

import 'server-only';
import {
  createReport,
  waitForReport,
  getReportDocument,
  downloadReportContent,
} from './reports';

export interface ReportFetchOptions {
  reportType: string;
  marketplaceIds: string[];
  dataStartTime?: string;
  dataEndTime?: string;
  reportOptions?: Record<string, string>;
  maxWaitMs?: number;
}

export interface ReportFetchResult {
  reportId: string;
  status: 'DONE' | 'CANCELLED' | 'FATAL' | 'EMPTY';
  rows: Array<Record<string, string>>;
  error?: string;
}

/**
 * Trigger un report, attend qu'il soit DONE, telecharge le contenu et
 * retourne les objets parses.
 *
 * Returns rows: [] si le report n'a pas de document (= aucune donnee).
 */
export async function fetchReportAsObjects(
  opts: ReportFetchOptions,
): Promise<ReportFetchResult> {
  const { reportId } = await createReport({
    reportType: opts.reportType,
    marketplaceIds: opts.marketplaceIds,
    dataStartTime: opts.dataStartTime,
    dataEndTime: opts.dataEndTime,
    reportOptions: opts.reportOptions,
  });

  const report = await waitForReport(reportId, {
    maxWaitMs: opts.maxWaitMs ?? 5 * 60_000,
    pollIntervalMs: 5_000,
  });

  if (report.processingStatus !== 'DONE') {
    return {
      reportId,
      status: report.processingStatus as 'CANCELLED' | 'FATAL',
      rows: [],
      error: `report finished with status ${report.processingStatus}`,
    };
  }

  if (!report.reportDocumentId) {
    return { reportId, status: 'EMPTY', rows: [] };
  }

  const doc = await getReportDocument(report.reportDocumentId);
  const content = await downloadReportContent(doc);
  if (!content || content.trim().length === 0) {
    return { reportId, status: 'EMPTY', rows: [] };
  }

  return {
    reportId,
    status: 'DONE',
    rows: parseDelimited(content),
  };
}

/**
 * Parse un fichier delimite (TSV ou CSV). Detecte le delimiter via la
 * premiere ligne : si elle contient un \t, c'est du TSV.
 */
export function parseDelimited(text: string): Array<Record<string, string>> {
  const firstLine = text.slice(0, Math.min(4096, text.length)).split(/\r?\n/)[0] || '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  return parseWithDelim(text, delim);
}

function parseWithDelim(text: string, delim: string): Array<Record<string, string>> {
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

  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (rows[r][j] ?? '').trim();
    out.push(obj);
  }
  return out;
}

export function num(v: unknown): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

export function parseDate(v: unknown): string | null {
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
