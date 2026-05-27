import { NextResponse } from 'next/server';
import { syncSettlementsFromSpApi } from '@/lib/sp-api/settlements-sync';

/**
 * GET /api/cron/sync-settlements
 *
 * Cron quotidien (à configurer dans vercel.json) qui :
 *   1. Liste les reports settlements DONE des 60 derniers jours
 *   2. Importe ceux pas encore en base
 *   3. Crée automatiquement audit + snapshot Traction par settlement importé
 *
 * Pas de notification ici — l'utilisateur voit un badge dans l'UI dashboard
 * (component <SettlementsPendingBadge />) qui compte les `closed_at IS NULL`.
 *
 * Protection : header Authorization Bearer = process.env.CRON_SECRET.
 * Vercel cron envoie automatiquement ce header s'il est configuré dans
 * les Environment Variables du projet.
 */

export const maxDuration = 300;

export async function GET(request: Request) {
  // Protection cron — Vercel injecte automatiquement Bearer CRON_SECRET
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await syncSettlementsFromSpApi({});
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
