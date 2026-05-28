import { NextResponse } from 'next/server';
import { getAccessToken, spApiCall } from '@/lib/sp-api/client';

/**
 * GET /api/amazon/sp-api/ping
 *
 * Diagnostic SP-API rapide (~3-5s):
 *   1. Vérifie présence des env vars
 *   2. Exchange LWA refresh_token → access_token
 *   3. Appelle GET /sellers/v1/marketplaceParticipations (endpoint le plus
 *      léger qui prouve l'auth fonctionne)
 *
 * Si ping OK → env vars + auth + SP-API joignables. Tout problème dans
 * le backfill ledger est forcément ailleurs (parsing, timeout report, …).
 *
 * Si ping plante → fix les env vars en premier.
 */

export const maxDuration = 30;

export async function GET() {
  const checks: Array<{ step: string; ok: boolean; detail?: string; durationMs?: number }> = [];

  // Étape 1 — env vars
  const requiredVars = [
    'LWA_CLIENT_ID',
    'LWA_CLIENT_SECRET',
    'SP_API_REFRESH_TOKEN',
    'SP_API_ENDPOINT',
    'LWA_TOKEN_ENDPOINT',
    'SP_API_SELLER_ID',
  ];
  const missing: string[] = [];
  for (const v of requiredVars) if (!process.env[v]) missing.push(v);
  checks.push({
    step: 'env_vars',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${requiredVars.length}/${requiredVars.length} present`
        : `missing: ${missing.join(', ')}`,
  });

  if (missing.length > 0) {
    return NextResponse.json({ ok: false, checks });
  }

  // Étape 2 — LWA token exchange
  const lwaStart = Date.now();
  try {
    const token = await getAccessToken();
    checks.push({
      step: 'lwa_token',
      ok: !!token,
      detail: token ? `got token (${token.slice(0, 16)}…)` : 'empty token',
      durationMs: Date.now() - lwaStart,
    });
  } catch (e) {
    checks.push({
      step: 'lwa_token',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - lwaStart,
    });
    return NextResponse.json({ ok: false, checks });
  }

  // Étape 3 — SP-API call (sellers/marketplaceParticipations = très léger)
  const apiStart = Date.now();
  try {
    const resp = await spApiCall<{ payload?: Array<{ marketplace?: { id?: string; name?: string } }> }>({
      path: '/sellers/v1/marketplaceParticipations',
    });
    const markets = (resp.payload ?? []).map(
      (p) => `${p.marketplace?.name ?? '?'} (${p.marketplace?.id ?? '?'})`,
    );
    checks.push({
      step: 'spapi_marketplaces',
      ok: true,
      detail: `connected to ${markets.length} marketplaces: ${markets.join(', ')}`,
      durationMs: Date.now() - apiStart,
    });
  } catch (e) {
    checks.push({
      step: 'spapi_marketplaces',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - apiStart,
    });
    return NextResponse.json({ ok: false, checks });
  }

  return NextResponse.json({
    ok: true,
    message: '✅ SP-API ping OK — env vars, LWA et appel test tous fonctionnent',
    checks,
  });
}
