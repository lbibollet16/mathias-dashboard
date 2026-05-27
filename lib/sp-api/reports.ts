/**
 * Reports API v2021-06-30 — wrapper minimal pour Mathias Dashboard.
 *
 * Settlements arrivent automatiquement comme reports schedulés par Amazon
 * (toutes les 2 semaines en général). On les LIST plutôt que de les
 * créer — ils existent déjà côté Amazon.
 *
 * Types de reports utiles ici :
 *   - GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 : TSV des settlements
 *   - GET_FBA_INVENTORY_PLANNING_DATA            : snapshot FBA stock
 *   - GET_FBA_REIMBURSEMENTS_DATA                : reimbursements (lost/damaged)
 *   - GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA  : retours clients
 *   - GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA : removal orders
 *
 * Docs : https://developer-docs.amazon.com/sp-api/reference/reports-api-v2021-06-30-reference
 */

import 'server-only';
import { spApiCall } from './client';

export type ReportProcessingStatus =
  | 'IN_QUEUE'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'CANCELLED'
  | 'FATAL';

export interface Report {
  reportId: string;
  reportType: string;
  dataStartTime?: string;
  dataEndTime?: string;
  createdTime: string;
  processingStartTime?: string;
  processingEndTime?: string;
  processingStatus: ReportProcessingStatus;
  marketplaceIds?: string[];
  reportDocumentId?: string;
}

export interface GetReportsParams {
  reportTypes?: string[];
  processingStatuses?: ReportProcessingStatus[];
  marketplaceIds?: string[];
  /** ISO date. */
  createdSince?: string;
  /** ISO date. */
  createdUntil?: string;
  pageSize?: number;
  nextToken?: string;
}

export interface GetReportsResponse {
  reports: Report[];
  nextToken?: string;
}

export function getReports(params: GetReportsParams = {}): Promise<GetReportsResponse> {
  return spApiCall<GetReportsResponse>({
    path: '/reports/2021-06-30/reports',
    query: {
      reportTypes: params.reportTypes,
      processingStatuses: params.processingStatuses,
      marketplaceIds: params.marketplaceIds,
      createdSince: params.createdSince,
      createdUntil: params.createdUntil,
      pageSize: params.pageSize,
      nextToken: params.nextToken,
    },
  });
}

export interface CreateReportParams {
  reportType: string;
  marketplaceIds?: string[];
  dataStartTime?: string;
  dataEndTime?: string;
  reportOptions?: Record<string, string>;
}

export function createReport(params: CreateReportParams): Promise<{ reportId: string }> {
  return spApiCall<{ reportId: string }>({
    method: 'POST',
    path: '/reports/2021-06-30/reports',
    body: {
      reportType: params.reportType,
      marketplaceIds: params.marketplaceIds,
      dataStartTime: params.dataStartTime,
      dataEndTime: params.dataEndTime,
      reportOptions: params.reportOptions,
    },
  });
}

export function getReport(reportId: string): Promise<Report> {
  return spApiCall<Report>({
    path: `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
  });
}

export interface ReportDocument {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm?: 'GZIP';
}

export function getReportDocument(reportDocumentId: string): Promise<ReportDocument> {
  return spApiCall<ReportDocument>({
    path: `/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`,
  });
}

/**
 * Télécharge le contenu d'un report (TSV/CSV/JSON) depuis l'URL signée
 * fournie par getReportDocument. Décompresse GZIP au passage si besoin.
 *
 * Returns the raw text content.
 */
export async function downloadReportContent(doc: ReportDocument): Promise<string> {
  const res = await fetch(doc.url);
  if (!res.ok) {
    throw new Error(`[sp-api] download report ${doc.reportDocumentId}: HTTP ${res.status}`);
  }

  if (doc.compressionAlgorithm === 'GZIP') {
    const buf = Buffer.from(await res.arrayBuffer());
    const zlib = await import('node:zlib');
    return new Promise<string>((resolve, reject) => {
      zlib.gunzip(buf, (err, out) => {
        if (err) reject(err);
        else resolve(out.toString('utf8'));
      });
    });
  }

  return await res.text();
}

/**
 * Polls a report until it reaches a terminal state (DONE / CANCELLED / FATAL).
 * Useful when triggering a report via createReport() — settlements are
 * usually already DONE when listed, so polling is mostly for FBA reports
 * we create on-demand.
 */
export async function waitForReport(
  reportId: string,
  opts: { maxWaitMs?: number; pollIntervalMs?: number } = {},
): Promise<Report> {
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const startedAt = Date.now();
  while (true) {
    const r = await getReport(reportId);
    if (
      r.processingStatus === 'DONE' ||
      r.processingStatus === 'CANCELLED' ||
      r.processingStatus === 'FATAL'
    ) {
      return r;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(
        `[sp-api] report ${reportId} stuck in ${r.processingStatus} after ${maxWaitMs / 1000}s`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
