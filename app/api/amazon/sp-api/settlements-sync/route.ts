import { NextRequest, NextResponse } from 'next/server';
import { syncSettlementsFromSpApi } from '@/lib/sp-api/settlements-sync';
import { spApiErrorResponse } from '@/lib/sp-api/client';

/**
 * POST /api/amazon/sp-api/settlements-sync
 *
 * Remplace l'upload manuel des TSV settlements. Liste les reports
 * settlements DONE depuis SP-API Reports et importe ceux qui ne sont pas
 * encore en base.
 *
 * Body (optionnel) :
 *   - created_since   ISO date — ne regarde que les reports créés depuis.
 *                     Default : 60 jours.
 *   - max_to_import   Cap par run. Default : 10.
 *
 * Réponse :
 *   {
 *     reports_seen, imported, skipped, errors,
 *     details: [{ reportId, settlement_id, status, rows_inserted?, error? }]
 *   }
 *
 * Idempotent : skip si settlement_id existe déjà.
 */

export const maxDuration = 300;

interface Body {
  created_since?: string;
  max_to_import?: number;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;

  try {
    const result = await syncSettlementsFromSpApi({
      createdSince: body.created_since,
      maxToImport: body.max_to_import,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}

/** GET also supported for cron triggers (no body needed). */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const createdSince = url.searchParams.get('created_since') ?? undefined;
  const maxToImport = url.searchParams.get('max_to_import')
    ? Number(url.searchParams.get('max_to_import'))
    : undefined;

  try {
    const result = await syncSettlementsFromSpApi({
      createdSince,
      maxToImport,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const { body: errBody, status } = spApiErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
}
