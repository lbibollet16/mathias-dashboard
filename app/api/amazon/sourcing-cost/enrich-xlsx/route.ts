import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * POST /api/amazon/sourcing-cost/enrich-xlsx
 *
 * Accepts the Amazon "Bulk Manage Your Sourcing Cost" XLSX template
 * (downloaded from Seller Central > Inventory > Inventory Defect and
 * Reimbursement > Manage Sourcing Cost > Bulk Update). Fills in the
 * "Seller New Cost" column for every row where we have a higher cost
 * in `amazon_sku_costs` (sourced from MPP). Returns the same XLSX with
 * the new column populated, ready to upload back to Amazon.
 *
 * Amazon expected sheet structure (verified 2026-05-28) :
 *   Sheet name : Part_1
 *   Headers (row 0) :
 *     [0] Asin
 *     [1] Fnsku
 *     [2] Amazon Estimated Cost
 *     [3] Latest Approved Cost
 *     [4] Source of Latest Approved Cost  ('SELLER' | 'AMAZON')
 *     [5] Currency                         ('CAD')
 *     [6] Date of Last Updated Cost
 *     [7] Seller New Cost                  ← we fill this
 *
 * Matching logic :
 *   - Primary  : amazon_sku_costs.asin = Amazon row Asin
 *   - Fallback : amazon_sku_costs.fnsku = Amazon row Fnsku
 *
 * Rule for filling Seller New Cost :
 *   - We only write a value if our cost is GREATER than the row's
 *     Latest Approved Cost. Writing a lower cost would request a
 *     reduction — never makes sense from a reimbursement perspective.
 *   - When Latest Approved Cost is empty/zero (row never approved),
 *     we write regardless.
 *
 * Returns the new XLSX as a binary attachment.
 */

export const maxDuration = 60;
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'file requis (multipart/form-data, field "file")' }, { status: 400 });
  }

  // Parse XLSX in memory.
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

  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    return NextResponse.json({ error: 'aucune feuille trouvée dans le XLSX' }, { status: 400 });
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) as unknown[][];
  if (rows.length < 2) {
    return NextResponse.json({ error: 'XLSX trop court (pas de data rows)' }, { status: 400 });
  }

  const header = rows[0] as string[];
  const asinIdx = header.findIndex((h) => /^Asin$/i.test(String(h)));
  const fnskuIdx = header.findIndex((h) => /^Fnsku$/i.test(String(h)));
  const approvedIdx = header.findIndex((h) => /^Latest Approved Cost$/i.test(String(h)));
  const newCostIdx = header.findIndex((h) => /^Seller New Cost$/i.test(String(h)));
  if (asinIdx < 0 || newCostIdx < 0) {
    return NextResponse.json(
      {
        error:
          "Colonnes attendues introuvables (Asin, Seller New Cost). Header reçu : " +
          JSON.stringify(header),
      },
      { status: 400 },
    );
  }

  // Pull our cost reference in one pass.
  const asins = rows
    .slice(1)
    .map((r) => (r[asinIdx] ? String(r[asinIdx]).trim() : null))
    .filter((s): s is string => !!s);
  const uniqueAsins = [...new Set(asins)];
  const costByAsin = new Map<string, number>();
  const costByFnsku = new Map<string, number>();
  for (let i = 0; i < uniqueAsins.length; i += 500) {
    const batch = uniqueAsins.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from('amazon_sku_costs')
      .select('asin, fnsku, cost_amount, cost_currency')
      .in('asin', batch);
    for (const r of (data ?? []) as Array<{
      asin: string | null;
      fnsku: string | null;
      cost_amount: number | string | null;
      cost_currency: string | null;
    }>) {
      const c = Number(r.cost_amount);
      if (!Number.isFinite(c) || c <= 0) continue;
      // Skip non-CAD silently — Amazon's bulk template is mono-currency
      // per file (CAD here), pas de conversion implicite.
      if (r.cost_currency && r.cost_currency !== 'CAD') continue;
      if (r.asin) costByAsin.set(r.asin, c);
      if (r.fnsku) costByFnsku.set(r.fnsku, c);
    }
  }

  // Enrich every row : fill Seller New Cost only when our cost is
  // strictly greater than what's already approved. Track stats for the
  // operator so they know how much of the file was actually touched.
  let filled = 0;
  let skippedNoCostKnown = 0;
  let skippedLowerOrEqual = 0;
  const sampleFilled: Array<{ asin: string; approved: number; ourCost: number }> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const asin = row[asinIdx] ? String(row[asinIdx]).trim() : '';
    const fnsku = fnskuIdx >= 0 && row[fnskuIdx] ? String(row[fnskuIdx]).trim() : '';
    const approvedRaw = approvedIdx >= 0 ? row[approvedIdx] : null;
    const approved = Number(approvedRaw);
    const approvedSafe = Number.isFinite(approved) ? approved : 0;

    const ourCost = costByAsin.get(asin) ?? costByFnsku.get(fnsku);
    if (ourCost == null) {
      skippedNoCostKnown++;
      continue;
    }
    if (ourCost <= approvedSafe) {
      skippedLowerOrEqual++;
      continue;
    }
    // Round to 2 decimals per Amazon's instruction.
    row[newCostIdx] = Math.round(ourCost * 100) / 100;
    filled++;
    if (sampleFilled.length < 10) {
      sampleFilled.push({ asin, approved: approvedSafe, ourCost });
    }
  }

  // Rebuild the sheet from the mutated AoA so cells keep their position.
  const newSheet = XLSX.utils.aoa_to_sheet(rows);
  wb.Sheets[sheetName] = newSheet;
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const summary = {
    filled,
    skipped_no_cost_known: skippedNoCostKnown,
    skipped_lower_or_equal: skippedLowerOrEqual,
    total_rows: rows.length - 1,
    sample_filled: sampleFilled,
  };
  // Encode summary in a custom response header so the operator can
  // see it via the download dialog console (helps debug). The actual
  // file download is the body.
  return new NextResponse(new Uint8Array(out), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="sourcing-cost-enriched-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      'X-Enrich-Summary': JSON.stringify(summary),
      'Cache-Control': 'no-store',
    },
  });
}
