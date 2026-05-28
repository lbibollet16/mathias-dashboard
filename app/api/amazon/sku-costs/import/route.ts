import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * POST /api/amazon/sku-costs/import
 *
 * Upsert un lot de coûts SKU dans `amazon_sku_costs`. Deux usages :
 *
 *   1. Push depuis MPP via le bridge (à brancher dans
 *      mathias-power-parts/lib/amazon/dashboard-bridge.ts pour pousser
 *      les coûts produits associés aux SKU FBA/FBM).
 *   2. Import manuel CSV → JSON (script `_import-costs.mjs` côté
 *      desktop, ou Postman / curl).
 *
 * Body :
 *   {
 *     "source": "mpp_bridge" | "manual_csv" | string,
 *     "rows": [
 *       { "sku": "FBA-123", "fnsku": "X0001AB", "asin": "B0...",
 *         "cost_amount": 12.34, "cost_currency": "CAD" },
 *       ...
 *     ]
 *   }
 *
 * Protection : header `Authorization: Bearer <CRON_SECRET>` requis si
 * CRON_SECRET est défini (même clé que les autres jobs SP-API).
 *
 * Réponse :
 *   { ok, imported, skipped: [{ sku, reason }], errors }
 */

export const maxDuration = 60;

interface InputRow {
  sku?: string;
  fnsku?: string;
  asin?: string;
  cost_amount?: number | string;
  cost_currency?: string;
  notes?: string;
}

interface Body {
  source?: string;
  rows?: InputRow[];
}

export async function POST(request: NextRequest) {
  // Auth same scheme as other cron-callable jobs.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const source = (body.source ?? 'unknown').slice(0, 64);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no rows' }, { status: 400 });
  }

  const skipped: Array<{ sku: string | null; reason: string }> = [];
  const toUpsert: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();

  for (const r of rows) {
    const sku = typeof r.sku === 'string' ? r.sku.trim() : '';
    if (!sku) {
      skipped.push({ sku: null, reason: 'missing sku' });
      continue;
    }
    const cost = Number(r.cost_amount);
    if (!Number.isFinite(cost) || cost <= 0) {
      skipped.push({ sku, reason: `cost_amount invalide: ${r.cost_amount}` });
      continue;
    }
    const currency = (r.cost_currency ?? 'CAD').toUpperCase();
    if (currency !== 'CAD' && currency !== 'USD') {
      skipped.push({ sku, reason: `currency non supportée: ${currency}` });
      continue;
    }
    toUpsert.push({
      sku,
      fnsku: r.fnsku?.trim() || null,
      asin: r.asin?.trim() || null,
      cost_amount: Math.round(cost * 10_000) / 10_000,
      cost_currency: currency,
      source,
      notes: r.notes?.slice(0, 1000) ?? null,
      updated_at: now,
    });
  }

  if (toUpsert.length === 0) {
    return NextResponse.json({
      ok: false,
      imported: 0,
      skipped,
      error: 'aucune ligne valide',
    }, { status: 400 });
  }

  // Upsert par chunks de 500 pour rester sous le payload limit PostgREST.
  let imported = 0;
  const errors: string[] = [];
  for (let i = 0; i < toUpsert.length; i += 500) {
    const batch = toUpsert.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from('amazon_sku_costs')
      .upsert(batch, { onConflict: 'sku' });
    if (error) {
      errors.push(`batch ${i}: ${error.message}`);
      continue;
    }
    imported += batch.length;
  }

  return NextResponse.json({
    ok: errors.length === 0,
    source,
    imported,
    skipped,
    errors,
  });
}
