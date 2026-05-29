import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * POST /api/amazon/sourcing-cost/import-from-xlsx
 *
 * Imports back into amazon_sku_costs the costs we've ALREADY submitted
 * to Amazon historically — they live in the XLSX template's
 * `Latest Approved Cost` column when `Source of Latest Approved Cost`
 * is 'SELLER'. These are typically FBA ASINs that exist in Amazon's
 * catalog but never made it into our MPP amazon_listings table, so
 * the bridge never pushed them.
 *
 * Logic :
 *   - For every row where Source = SELLER and Latest Approved Cost > 0
 *   - Upsert into amazon_sku_costs with source='amazon_seller_history'
 *   - **Preserve** existing rows : do NOT overwrite the MPP-sourced
 *     entries (amazon_sku_costs rows where source='mpp_bridge' carry
 *     the canonical dealer_cost — trumps the historical Amazon-side
 *     value because MPP gets refreshed from Kimpex/Motovan whereas the
 *     Amazon-side value is whatever we pushed manually some months ago).
 *
 * Returns counts so the operator can see how much was bridged.
 */

export const maxDuration = 60;
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'file requis' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    return NextResponse.json(
      { error: 'XLSX illisible : ' + (e instanceof Error ? e.message : String(e)) },
      { status: 400 },
    );
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return NextResponse.json({ error: 'pas de feuille' }, { status: 400 });
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
  if (rows.length < 2) {
    return NextResponse.json({ error: 'XLSX vide' }, { status: 400 });
  }
  const header = rows[0] as string[];
  const asinIdx = header.findIndex((h) => /^Asin$/i.test(String(h)));
  const fnskuIdx = header.findIndex((h) => /^Fnsku$/i.test(String(h)));
  const approvedIdx = header.findIndex((h) => /^Latest Approved Cost$/i.test(String(h)));
  const sourceIdx = header.findIndex((h) => /^Source of Latest Approved Cost$/i.test(String(h)));
  const currencyIdx = header.findIndex((h) => /^Currency$/i.test(String(h)));

  if (asinIdx < 0 || approvedIdx < 0 || sourceIdx < 0) {
    return NextResponse.json(
      { error: 'Colonnes attendues introuvables : Asin, Latest Approved Cost, Source.' },
      { status: 400 },
    );
  }

  // Pull existing ASINs once so we know which to skip (preserve MPP).
  const candidateAsins = rows
    .slice(1)
    .map((r) => (r[asinIdx] ? String(r[asinIdx]).trim() : null))
    .filter((s): s is string => !!s);
  const existing = new Set<string>();
  for (let i = 0; i < candidateAsins.length; i += 500) {
    const batch = candidateAsins.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from('amazon_sku_costs')
      .select('sku, asin, source')
      .in('asin', batch);
    for (const r of (data ?? []) as Array<{ asin: string | null; source: string | null }>) {
      if (r.asin) existing.add(r.asin);
    }
  }

  // /!\ Le XLSX Amazon contient parfois plusieurs rows pour le même
  // ASIN (variants, FNSKU différents pour la même ASIN principale).
  // Postgres refuse "ON CONFLICT DO UPDATE command cannot affect row a
  // second time" si on upsert 2 fois la même PK dans un seul batch.
  // On dédoublonne au moment du push en gardant la 1re occurrence
  // valide rencontrée par ASIN — c'est OK car les variants partagent
  // le même cost approved par Amazon dans 99% des cas.
  const seenSkus = new Set<string>();

  const toUpsert: Array<Record<string, unknown>> = [];
  let skippedNotSeller = 0;
  let skippedZero = 0;
  let skippedExisting = 0;
  let skippedNonCAD = 0;
  let skippedDuplicateInFile = 0;
  const now = new Date().toISOString();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const asin = row[asinIdx] ? String(row[asinIdx]).trim() : '';
    if (!asin) continue;
    if (existing.has(asin)) {
      skippedExisting++;
      continue;
    }
    const source = sourceIdx >= 0 ? String(row[sourceIdx] ?? '').trim().toUpperCase() : '';
    if (source !== 'SELLER') {
      skippedNotSeller++;
      continue;
    }
    const cost = Number(row[approvedIdx]);
    if (!Number.isFinite(cost) || cost <= 0) {
      skippedZero++;
      continue;
    }
    const currency =
      currencyIdx >= 0
        ? String(row[currencyIdx] ?? 'CAD')
            .trim()
            .toUpperCase()
        : 'CAD';
    if (currency !== 'CAD') {
      skippedNonCAD++;
      continue;
    }
    // Dédup par sku (= asin). Si on a déjà collecté cette ASIN dans
    // le batch, on skip — l'upsert plante sinon.
    if (seenSkus.has(asin)) {
      skippedDuplicateInFile++;
      continue;
    }
    seenSkus.add(asin);

    const fnsku = fnskuIdx >= 0 && row[fnskuIdx] ? String(row[fnskuIdx]).trim() : null;
    // sku PK : on n'a pas de seller_sku ici, donc on utilise l'ASIN
    // comme primary key (cohérent avec le format des autres rows où
    // FNSKU == ASIN dans le bulk file Amazon).
    toUpsert.push({
      sku: asin,
      fnsku,
      asin,
      cost_amount: Math.round(cost * 100) / 100,
      cost_currency: 'CAD',
      source: 'amazon_seller_history',
      notes: `imported from Amazon Bulk Sourcing Cost XLSX (Latest Approved Cost, src=SELLER) on ${now.slice(0, 10)}`,
      updated_at: now,
    });
  }

  let inserted = 0;
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
    inserted += batch.length;
  }

  return NextResponse.json({
    ok: errors.length === 0,
    // `error` (singulier) pour que l'UI affiche le 1er message au lieu
    // d'un générique "HTTP 200" quand errors[] est rempli.
    error: errors[0] ?? undefined,
    inserted,
    skipped_existing_in_db: skippedExisting,
    skipped_not_seller_source: skippedNotSeller,
    skipped_zero_or_invalid: skippedZero,
    skipped_non_cad: skippedNonCAD,
    skipped_duplicate_in_file: skippedDuplicateInFile,
    total_rows: rows.length - 1,
    errors,
  });
}
