import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/settlements/bundle?id=<settlement_id>
 *
 * Génère un fichier XLSX 5 onglets pour un settlement clôturé, prêt pour
 * la compta. Tout vient de Supabase (pas de hit SP-API) — donc OK même
 * si le settlement n'a pas encore été ré-synchronisé.
 *
 * Onglets :
 *   1. Résumé             — totaux dépôt + dates Amazon + breakdown
 *   2. Transactions brutes — toutes les amazon_transactions
 *   3. Catégorisation P/L — agrégé par catégorie (compta-ready)
 *   4. Dropship Kimpex     — SKUs DSK- à reverser au fournisseur
 *   5. Remboursements FBA  — amazon_reimbursements de la période
 */

export const dynamic = 'force-dynamic';

interface SettlementRow {
  settlement_id: string;
  settlement_start: string | null;
  settlement_end: string | null;
  deposit_date: string | null;
  total_amount: number | string | null;
  currency: string | null;
  marketplace: string | null;
}

interface TxRow {
  amount: number | string | null;
  amount_type: string | null;
  amount_description: string | null;
  fulfillment_id: string | null;
  order_id: string | null;
  sku: string | null;
  quantity_purchased: number | string | null;
  posted_date: string | null;
  transaction_type: string | null;
  shipment_id: string | null;
  adjustment_id: string | null;
  traction_code: string | null;
}

interface ReimbRow {
  reimbursement_id: string | null;
  approval_date: string | null;
  case_id: string | null;
  amazon_order_id: string | null;
  reason: string | null;
  sku: string | null;
  asin: string | null;
  product_name: string | null;
  currency: string | null;
  amount_per_unit: number | string | null;
  amount_total: number | string | null;
  quantity_reimbursed_total: number | string | null;
}

function num(v: unknown): number {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function isFba(f: string | null): boolean {
  return f === 'AFN';
}

function isFbm(f: string | null): boolean {
  return f === 'MFN';
}

function categorize(
  amount_type: string | null,
  amount_description: string | null,
): { category: string; order: number; sign: 'in' | 'out' } | null {
  const t = (amount_type || '').trim();
  const d = (amount_description || '').trim();
  if (t === 'ItemPrice') {
    if (d === 'Principal') return { category: 'Ventes (Principal)', order: 1, sign: 'in' };
    if (d === 'Shipping') return { category: 'Frais de livraison (client)', order: 2, sign: 'in' };
    if (d === 'Tax' || d === 'ShippingTax') return { category: 'Taxes perçues', order: 3, sign: 'in' };
    return { category: 'Ventes — Autre', order: 4, sign: 'in' };
  }
  if (t === 'ItemWithheldTax') return { category: 'Taxes retenues par Amazon', order: 5, sign: 'out' };
  if (t === 'ItemFees') {
    if (d === 'Commission') return { category: 'Commission Amazon', order: 10, sign: 'out' };
    if (d === 'FBAPerUnitFulfillmentFee') return { category: 'Frais FBA (pick & pack)', order: 11, sign: 'out' };
    if (d === 'RefundCommission') return { category: 'Commission sur remboursements', order: 12, sign: 'in' };
    if (d === 'ShippingChargeback' || d === 'ShippingHB') return { category: 'Frais expédition (rétrofact)', order: 13, sign: 'out' };
    return { category: 'Autres frais Amazon', order: 14, sign: 'out' };
  }
  if (t === 'Promotion') return { category: 'Promotions', order: 15, sign: 'out' };
  if (t === 'Cost of Advertising') return { category: 'Publicité Amazon', order: 20, sign: 'out' };
  if (t === 'FBA Inventory Reimbursement') return { category: 'Remboursements FBA (Lost/Damaged)', order: 25, sign: 'in' };
  if (t === 'other-transaction') {
    if (d === 'StorageRenewalBilling') return { category: 'Frais de stockage FBA', order: 30, sign: 'out' };
    if (d === 'Subscription Fee') return { category: 'Abonnement Amazon', order: 31, sign: 'out' };
    if (d === 'RemovalComplete') return { category: 'Retours d\'inventaire', order: 32, sign: 'in' };
    return { category: 'Autres transactions', order: 33, sign: 'in' };
  }
  return { category: 'Non catégorisé', order: 99, sign: 'in' };
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ ok: false, error: 'Paramètre `id` requis' }, { status: 400 });
  }

  // 1. Settlement
  const { data: settlement, error: sErr } = await supabaseAdmin
    .from('amazon_settlements')
    .select('*')
    .eq('settlement_id', id)
    .single<SettlementRow>();

  if (sErr || !settlement) {
    return NextResponse.json({ ok: false, error: 'Settlement introuvable' }, { status: 404 });
  }

  // 2. Toutes les transactions (paginées)
  const allTx: TxRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('amazon_transactions')
      .select(
        'amount, amount_type, amount_description, fulfillment_id, order_id, sku, quantity_purchased, posted_date, transaction_type, shipment_id, adjustment_id, traction_code',
      )
      .eq('settlement_id', id)
      .range(from, from + 999);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    allTx.push(...(data as TxRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }

  // 3. Reimbursements de la période (par approval_date)
  let reimbs: ReimbRow[] = [];
  if (settlement.settlement_start && settlement.settlement_end) {
    const { data, error } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select(
        'reimbursement_id, approval_date, case_id, amazon_order_id, reason, sku, asin, product_name, currency, amount_per_unit, amount_total, quantity_reimbursed_total',
      )
      .gte('approval_date', settlement.settlement_start)
      .lte('approval_date', settlement.settlement_end);
    if (!error && data) reimbs = data as ReimbRow[];
  }

  // ──── Onglet 1 : Résumé ────────────────────────────────────────────
  const breakdown = new Map<
    string,
    { category: string; order: number; sign: 'in' | 'out'; brut: number; fba: number; fbm: number; count: number }
  >();
  let total_brut = 0;
  let total_fba = 0;
  let total_fbm = 0;
  let total_ventes_principal = 0;
  let total_fees = 0;
  let total_taxes_in = 0;
  let total_taxes_out = 0;
  for (const t of allTx) {
    const cat = categorize(t.amount_type, t.amount_description);
    if (!cat) continue;
    const a = num(t.amount);
    total_brut += a;
    if (isFba(t.fulfillment_id)) total_fba += a;
    else if (isFbm(t.fulfillment_id)) total_fbm += a;
    if (cat.category === 'Ventes (Principal)') total_ventes_principal += a;
    if (t.amount_type === 'ItemFees') total_fees += a;
    if (t.amount_type === 'ItemPrice' && (t.amount_description === 'Tax' || t.amount_description === 'ShippingTax')) total_taxes_in += a;
    if (t.amount_type === 'ItemWithheldTax') total_taxes_out += a;
    const key = cat.category;
    if (!breakdown.has(key)) breakdown.set(key, { category: key, order: cat.order, sign: cat.sign, brut: 0, fba: 0, fbm: 0, count: 0 });
    const b = breakdown.get(key)!;
    b.brut += a;
    if (isFba(t.fulfillment_id)) b.fba += a;
    else if (isFbm(t.fulfillment_id)) b.fbm += a;
    b.count++;
  }

  const resumeSheet: Array<Array<string | number>> = [
    ['Settlement Mathias Power Parts'],
    [],
    ['Settlement ID', settlement.settlement_id],
    ['Date début (Amazon)', settlement.settlement_start ?? ''],
    ['Date fin (Amazon)', settlement.settlement_end ?? ''],
    ['Date dépôt bancaire', settlement.deposit_date ?? ''],
    ['Marketplace', settlement.marketplace ?? ''],
    ['Devise', settlement.currency ?? ''],
    ['Montant déposé (TSV header)', num(settlement.total_amount)],
    ['Net calculé (somme transactions)', Math.round(total_brut * 100) / 100],
    ['Écart header/calculé', Math.round((num(settlement.total_amount) - total_brut) * 100) / 100],
    [],
    ['Ventilation FBA vs FBM'],
    ['Net FBA', Math.round(total_fba * 100) / 100],
    ['Net FBM', Math.round(total_fbm * 100) / 100],
    [],
    ['Indicateurs clés compta'],
    ['Ventes Principal (HT)', Math.round(total_ventes_principal * 100) / 100],
    ['Total frais Amazon (ItemFees)', Math.round(total_fees * 100) / 100],
    ['Taxes perçues (client)', Math.round(total_taxes_in * 100) / 100],
    ['Taxes retenues par Amazon', Math.round(total_taxes_out * 100) / 100],
    [],
    ['Stats'],
    ['Nb transactions', allTx.length],
    ['Nb commandes uniques', new Set(allTx.map((t) => t.order_id).filter(Boolean)).size],
    ['Nb SKUs uniques', new Set(allTx.map((t) => t.sku).filter(Boolean)).size],
  ];

  // ──── Onglet 2 : Transactions brutes ──────────────────────────────
  const txSheet = [
    [
      'posted_date',
      'transaction_type',
      'order_id',
      'shipment_id',
      'adjustment_id',
      'sku',
      'traction_code',
      'fulfillment_id',
      'amount_type',
      'amount_description',
      'quantity_purchased',
      'amount',
    ],
    ...allTx.map((t) => [
      t.posted_date ?? '',
      t.transaction_type ?? '',
      t.order_id ?? '',
      t.shipment_id ?? '',
      t.adjustment_id ?? '',
      t.sku ?? '',
      t.traction_code ?? '',
      t.fulfillment_id ?? '',
      t.amount_type ?? '',
      t.amount_description ?? '',
      num(t.quantity_purchased),
      num(t.amount),
    ]),
  ];

  // ──── Onglet 3 : Catégorisation P/L ────────────────────────────────
  const breakdownArr = Array.from(breakdown.values()).sort((a, b) => a.order - b.order);
  const plSheet = [
    ['Catégorie', 'Sens', 'Net brut', 'Net FBA', 'Net FBM', 'Nb lignes'],
    ...breakdownArr.map((b) => [
      b.category,
      b.sign === 'in' ? 'Entrée' : 'Sortie',
      Math.round(b.brut * 100) / 100,
      Math.round(b.fba * 100) / 100,
      Math.round(b.fbm * 100) / 100,
      b.count,
    ]),
    ['', '', '', '', '', ''],
    ['TOTAL', '', Math.round(total_brut * 100) / 100, Math.round(total_fba * 100) / 100, Math.round(total_fbm * 100) / 100, allTx.length],
  ];

  // ──── Onglet 4 : Dropship Kimpex (DSK-) ───────────────────────────
  // Agrégé par SKU. On garde le montant net (Principal + Shipping - Fees).
  // PAS de quantité, juste les $ pour balancer comptabilité.
  const dskMap = new Map<
    string,
    { sku: string; orders: Set<string>; principal: number; shipping: number; tax: number; fees: number; net: number }
  >();
  for (const t of allTx) {
    if (!t.sku || !t.sku.startsWith('DSK-')) continue;
    if (!dskMap.has(t.sku)) {
      dskMap.set(t.sku, { sku: t.sku, orders: new Set(), principal: 0, shipping: 0, tax: 0, fees: 0, net: 0 });
    }
    const d = dskMap.get(t.sku)!;
    const a = num(t.amount);
    d.net += a;
    if (t.order_id) d.orders.add(t.order_id);
    if (t.amount_type === 'ItemPrice') {
      if (t.amount_description === 'Principal') d.principal += a;
      else if (t.amount_description === 'Shipping') d.shipping += a;
      else if (t.amount_description === 'Tax' || t.amount_description === 'ShippingTax') d.tax += a;
    } else if (t.amount_type === 'ItemFees') {
      d.fees += a;
    }
  }
  const dskArr = Array.from(dskMap.values()).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const dskTotal = dskArr.reduce((s, d) => s + d.net, 0);
  const dskSheet = [
    ['SKU Kimpex', 'Nb commandes', 'Principal', 'Shipping', 'Taxes perçues', 'Frais Amazon', 'Net à reverser'],
    ...dskArr.map((d) => [
      d.sku,
      d.orders.size,
      Math.round(d.principal * 100) / 100,
      Math.round(d.shipping * 100) / 100,
      Math.round(d.tax * 100) / 100,
      Math.round(d.fees * 100) / 100,
      Math.round(d.net * 100) / 100,
    ]),
    ['', '', '', '', '', '', ''],
    ['TOTAL DROPSHIP', dskArr.length, '', '', '', '', Math.round(dskTotal * 100) / 100],
  ];

  // ──── Onglet 5 : Remboursements FBA ───────────────────────────────
  const reimbSheet = [
    [
      'reimbursement_id',
      'approval_date',
      'case_id',
      'amazon_order_id',
      'reason',
      'sku',
      'asin',
      'product_name',
      'currency',
      'amount_per_unit',
      'quantity',
      'amount_total',
    ],
    ...reimbs.map((r) => [
      r.reimbursement_id ?? '',
      r.approval_date ?? '',
      r.case_id ?? '',
      r.amazon_order_id ?? '',
      r.reason ?? '',
      r.sku ?? '',
      r.asin ?? '',
      r.product_name ?? '',
      r.currency ?? '',
      num(r.amount_per_unit),
      num(r.quantity_reimbursed_total),
      num(r.amount_total),
    ]),
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      reimbs.reduce((s, r) => s + num(r.quantity_reimbursed_total), 0),
      Math.round(reimbs.reduce((s, r) => s + num(r.amount_total), 0) * 100) / 100,
    ],
  ];

  // ──── Build workbook ──────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumeSheet), 'Résumé');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(plSheet), 'P&L par catégorie');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dskSheet), 'Dropship Kimpex');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reimbSheet), 'Remboursements FBA');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txSheet), 'Transactions brutes');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const periodLabel = settlement.deposit_date
    ? settlement.deposit_date.slice(0, 10)
    : settlement.settlement_end?.slice(0, 10) ?? 'inconnu';
  const filename = `settlement-${periodLabel}-${id}.xlsx`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
