import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { computeDimensionDiscrepancies } from '@/lib/sp-api/catalog-dimensions-sync';

/**
 * POST /api/amazon/dimensions/import-actual
 *
 * Uploads actual measured dimensions for one or more SKUs. Used by the
 * operator after weighing/measuring products in our warehouse OR by a
 * supplier feed pushing canonical specs.
 *
 * Body :
 *   {
 *     source: 'csv_import' | 'supplier_kimpex' | 'manual',
 *     rows: [{
 *       sku: 'FBA-260621',
 *       fnsku?: 'X0001AB',
 *       asin?: 'B01...',
 *       actual_length_cm: 25.5,
 *       actual_width_cm: 12.3,
 *       actual_height_cm: 8.0,
 *       actual_weight_kg: 0.450,
 *       notes?: 'measured with caliper 2026-05-28'
 *     }]
 *   }
 *
 * Recomputes discrepancies after the import so the UI immediately
 * flags the newly-imported rows that exceed the cubiscan threshold.
 */

export const maxDuration = 60;

interface InputRow {
  sku?: string;
  fnsku?: string;
  asin?: string;
  product_name?: string;
  actual_length_cm?: number | string;
  actual_width_cm?: number | string;
  actual_height_cm?: number | string;
  actual_weight_kg?: number | string;
  notes?: string;
}

interface Body {
  source?: string;
  rows?: InputRow[];
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const source = (body.source ?? 'manual').slice(0, 64);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'rows[] requis' }, { status: 400 });
  }

  const upserts: Record<string, unknown>[] = [];
  const skipped: Array<{ sku: string | null; reason: string }> = [];
  const now = new Date().toISOString();

  for (const r of rows) {
    const sku = typeof r.sku === 'string' ? r.sku.trim() : '';
    if (!sku) {
      skipped.push({ sku: null, reason: 'missing sku' });
      continue;
    }
    const length = num(r.actual_length_cm);
    const width = num(r.actual_width_cm);
    const height = num(r.actual_height_cm);
    const weight = num(r.actual_weight_kg);
    if (!length || !width || !height || !weight) {
      skipped.push({
        sku,
        reason: 'dimensions invalides (length/width/height/weight tous > 0 requis)',
      });
      continue;
    }
    upserts.push({
      sku,
      fnsku: r.fnsku?.trim() || null,
      asin: r.asin?.trim() || null,
      product_name: r.product_name?.slice(0, 500) ?? null,
      actual_length_cm: length,
      actual_width_cm: width,
      actual_height_cm: height,
      actual_weight_kg: weight,
      actual_source: source,
      actual_updated_at: now,
      notes: r.notes?.slice(0, 1000) ?? null,
      updated_at: now,
    });
  }

  if (upserts.length === 0) {
    return NextResponse.json({
      ok: false,
      imported: 0,
      skipped,
      error: 'aucune ligne valide',
    }, { status: 400 });
  }

  let imported = 0;
  const errors: string[] = [];
  for (let i = 0; i < upserts.length; i += 500) {
    const batch = upserts.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from('amazon_product_dimensions')
      .upsert(batch, { onConflict: 'sku' });
    if (error) {
      errors.push('batch ' + i + ': ' + error.message);
      continue;
    }
    imported += batch.length;
  }

  // Recompute discrepancies so the newly-imported rows immediately
  // show up in the at-risk list.
  const discrepancy = await computeDimensionDiscrepancies();

  return NextResponse.json({
    ok: errors.length === 0,
    source,
    imported,
    skipped,
    errors,
    discrepancy,
  });
}
