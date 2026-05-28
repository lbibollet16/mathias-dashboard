import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/aging/at-risk?bucket=180|270|365&order=qty_desc
 *
 * Returns SKUs at risk of Aged Inventory Surcharge (181+ days). Default
 * shows ALL three risk buckets summed (181-270, 271-365, 365+), but
 * you can filter to a specific bucket.
 *
 * Each row includes the action urgency badge :
 *   - 🟡 'monitor'  → only 181-270 units (surcharge active mais basse)
 *   - 🟠 'discount' → 271-365 units (surcharge progressive, vente urgente)
 *   - 🔴 'remove'   → 365+ units (surcharge max, removal/disposal direct)
 *
 * Snapshot le plus récent uniquement.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const bucket = url.searchParams.get('bucket');

  // Trouve la date du snapshot le plus récent
  const { data: latest } = await supabaseAdmin
    .from('amazon_inventory_aging')
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1);

  if (!latest || latest.length === 0) {
    return NextResponse.json({
      ok: true,
      snapshot_date: null,
      total_at_risk_skus: 0,
      total_units_at_risk: 0,
      total_estimated_30d_cost: 0,
      rows: [],
      message: 'Aucun snapshot — lance d\'abord /api/amazon/sp-api/aging-sync',
    });
  }
  const snapshot = latest[0].snapshot_date;

  let q = supabaseAdmin
    .from('amazon_inventory_aging')
    .select(
      'sku, fnsku, asin, product_name, qty_181_to_270_days, qty_271_to_365_days, qty_365_plus_days, qty_total, recommended_action, recommended_sales_price, estimated_holding_cost_next_30_days',
    )
    .eq('snapshot_date', snapshot);

  // Filtre par bucket ou par défaut prend tout ce qui a au moins une unité
  // dans un des 3 buckets à risque.
  if (bucket === '180') {
    q = q.gt('qty_181_to_270_days', 0);
  } else if (bucket === '270') {
    q = q.gt('qty_271_to_365_days', 0);
  } else if (bucket === '365') {
    q = q.gt('qty_365_plus_days', 0);
  } else {
    // ANY of the 3 risk buckets
    q = q.or('qty_181_to_270_days.gt.0,qty_271_to_365_days.gt.0,qty_365_plus_days.gt.0');
  }

  const { data, error } = await q.limit(500);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  let totalUnits = 0;
  let totalCost = 0;
  const rows = (data ?? []).map((r) => {
    const q180 = r.qty_181_to_270_days ?? 0;
    const q270 = r.qty_271_to_365_days ?? 0;
    const q365 = r.qty_365_plus_days ?? 0;
    const atRiskQty = q180 + q270 + q365;
    totalUnits += atRiskQty;
    const cost = Number(r.estimated_holding_cost_next_30_days ?? 0);
    if (Number.isFinite(cost)) totalCost += cost;
    // Worst bucket dicte l'urgence
    const urgency = q365 > 0 ? 'remove' : q270 > 0 ? 'discount' : 'monitor';
    return {
      sku: r.sku,
      fnsku: r.fnsku,
      asin: r.asin,
      product_name: r.product_name,
      qty_total: r.qty_total,
      qty_181_to_270_days: q180,
      qty_271_to_365_days: q270,
      qty_365_plus_days: q365,
      qty_at_risk: atRiskQty,
      urgency,
      recommended_action: r.recommended_action,
      recommended_sales_price: r.recommended_sales_price,
      estimated_30d_cost: cost,
    };
  });

  // Tri : urgence > qty à risque
  const urgencyRank = { remove: 3, discount: 2, monitor: 1 };
  rows.sort((a, b) => {
    const u = (urgencyRank[b.urgency as keyof typeof urgencyRank] ?? 0) -
              (urgencyRank[a.urgency as keyof typeof urgencyRank] ?? 0);
    if (u !== 0) return u;
    return b.qty_at_risk - a.qty_at_risk;
  });

  // Jour du mois → on rappelle la deadline du 14 (avant l'évaluation du 15)
  const today = new Date();
  const day = today.getUTCDate();
  const daysUntilDeadline = day <= 14 ? 14 - day : 14 + (30 - day);
  const deadlineNote =
    day <= 14
      ? `J-${14 - day} avant l'évaluation Amazon du 15 — agir avant minuit UTC du 14 pour stopper la surcharge ce mois.`
      : `Évaluation Amazon du mois déjà passée. Prochaine fenêtre dans ${daysUntilDeadline} jours (le 14 du mois prochain).`;

  return NextResponse.json({
    ok: true,
    snapshot_date: snapshot,
    days_until_deadline: daysUntilDeadline,
    deadline_note: deadlineNote,
    total_at_risk_skus: rows.length,
    total_units_at_risk: totalUnits,
    total_estimated_30d_cost: Math.round(totalCost * 100) / 100,
    rows,
  });
}
