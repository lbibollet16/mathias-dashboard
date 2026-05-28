import { NextRequest, NextResponse } from 'next/server';
import {
  createReport,
  waitForReport,
  getReportDocument,
  downloadReportContent,
} from '@/lib/sp-api/reports';

/**
 * GET /api/amazon/sp-api/ledger-debug?from=2026-04-01&to=2026-04-08
 *
 * Lance le report ledger comme le sync normal MAIS :
 *   - Ne fait PAS d'upsert (read-only)
 *   - Retourne :
 *       - les VRAIES colonnes Amazon (headers du TSV)
 *       - les 5 premières lignes brutes
 *       - le total de lignes
 *       - les premiers 500 caractères du fichier brut
 *
 * But : diagnostiquer pourquoi le sync ramène 0 rows_inserted. Si les
 * colonnes diffèrent de ce que mon code attend (`Date`, `Event Type`,
 * etc.), on saura quoi mapper.
 *
 * À utiliser sur une fenêtre COURTE (1 semaine max) pour aller vite.
 */

export const maxDuration = 300;

const MARKETPLACE_CA = 'A2EUQ1WTGCTBG2';

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) {
    // Defaults: derniers 7 jours
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return NextResponse.json(
      { ok: false, error: 'from + to requis (ISO YYYY-MM-DD)', example: `from=${start.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}` },
      { status: 400 },
    );
  }

  try {
    const trigStart = Date.now();
    const { reportId } = await createReport({
      reportType: 'GET_LEDGER_DETAIL_VIEW_DATA',
      marketplaceIds: [MARKETPLACE_CA],
      dataStartTime: new Date(from).toISOString(),
      dataEndTime: new Date(to).toISOString(),
      reportOptions: {
        aggregateByLocation: 'FC',
        aggregatedByTimePeriod: 'DAILY',
      },
    });
    const trigMs = Date.now() - trigStart;

    const waitStart = Date.now();
    const report = await waitForReport(reportId, {
      maxWaitMs: 4 * 60_000,
      pollIntervalMs: 5_000,
    });
    const waitMs = Date.now() - waitStart;

    if (report.processingStatus !== 'DONE' || !report.reportDocumentId) {
      return NextResponse.json({
        ok: false,
        reportId,
        status: report.processingStatus,
        timings: { trigger_ms: trigMs, wait_ms: waitMs },
        error: 'report not DONE or no document',
      });
    }

    const dlStart = Date.now();
    const doc = await getReportDocument(report.reportDocumentId);
    const content = await downloadReportContent(doc);
    const dlMs = Date.now() - dlStart;

    // Parse TSV avec strip quotes (Amazon wrappe chaque valeur de "...")
    const stripQ = (s: string): string => {
      if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        return s.slice(1, -1).replace(/""/g, '"');
      }
      return s;
    };
    const lines = content.split(/\r?\n/);
    const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
    const headers = (nonEmptyLines[0] ?? '').split('\t').map((h) => stripQ(h.trim()));
    const sampleRows: Array<Record<string, string>> = [];
    for (let i = 1; i < Math.min(nonEmptyLines.length, 6); i++) {
      const cells = nonEmptyLines[i].split('\t');
      const obj: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j] || `_col${j}`] = stripQ((cells[j] ?? '').trim());
      }
      sampleRows.push(obj);
    }

    return NextResponse.json({
      ok: true,
      reportId,
      from,
      to,
      timings: {
        trigger_ms: trigMs,
        wait_ms: waitMs,
        download_ms: dlMs,
        total_ms: trigMs + waitMs + dlMs,
      },
      document: {
        compression: doc.compressionAlgorithm || 'none',
        url_host: new URL(doc.url).hostname,
      },
      content: {
        total_lines: lines.length,
        non_empty_lines: nonEmptyLines.length,
        data_rows: Math.max(nonEmptyLines.length - 1, 0),
        first_500_chars: content.slice(0, 500),
      },
      headers,
      sample_rows: sampleRows,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
