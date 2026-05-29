import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/amazon/settlements/bundle?id=<settlement_id>
 *
 * Génère un fichier XLSX 8 onglets pour un settlement clôturé, prêt pour
 * la compta + le suivi inventaire. Tout vient de Supabase (pas de hit
 * SP-API) — donc OK même si le settlement n'a pas encore été ré-synchronisé.
 *
 * Onglets — mêmes 5 fichiers que l'import manuel + 3 vues compta :
 *   1. Résumé              — totaux dépôt + dates Amazon + breakdown
 *   2. P&L par catégorie   — agrégé par catégorie (compta-ready)
 *   3. Dropship Kimpex     — SKUs DSK- à reverser au fournisseur ($)
 *   4. Remboursements FBA  — amazon_reimbursements de la période [manuel]
 *   5. Customer Returns    — amazon_customer_returns de la période [manuel]
 *   6. Removal Orders      — amazon_removal_orders de la période  [manuel]
 *   7. FBA Inventory       — snapshot fin de période              [manuel]
 *   8. Transactions brutes — toutes les amazon_transactions       [manuel]
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

interface CustomerReturnRow {
  license_plate_number: string | null;
  return_date: string | null;
  order_id: string | null;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  product_name: string | null;
  quantity: number | string | null;
  fulfillment_center_id: string | null;
  detailed_disposition: string | null;
  reason: string | null;
  status: string | null;
  customer_comments: string | null;
}

interface RemovalOrderRow {
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  request_date: string | null;
  last_updated_date: string | null;
  order_type: string | null;
  order_status: string | null;
  disposition: string | null;
  requested_quantity: number | string | null;
  shipped_quantity: number | string | null;
  disposed_quantity: number | string | null;
  cancelled_quantity: number | string | null;
  removal_fee: number | string | null;
  currency: string | null;
}

interface FbaInventoryRow {
  snapshot_date: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  condition: string | null;
  your_price: number | string | null;
  afn_warehouse_quantity: number | string | null;
  afn_fulfillable_quantity: number | string | null;
  afn_unsellable_quantity: number | string | null;
  afn_reserved_quantity: number | string | null;
  afn_total_quantity: number | string | null;
  afn_inbound_working_quantity: number | string | null;
  afn_inbound_shipped_quantity: number | string | null;
  afn_inbound_receiving_quantity: number | string | null;
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

  // 3-6. Tous les autres fichiers, filtrés strictement sur les dates
  // Amazon du settlement pour que la compta balance pile.
  //
  // Convention : le filtre utilise la colonne "date d'événement Amazon"
  // de chaque fichier — celle qui détermine si l'événement appartient à
  // ce cycle de règlement. Documenté dans l'en-tête de chaque onglet
  // pour audit.
  let reimbs: ReimbRow[] = [];
  let returns: CustomerReturnRow[] = [];
  let removals: RemovalOrderRow[] = [];
  let inventorySnapshot: FbaInventoryRow[] = [];
  let inventorySnapshotDate: string | null = null;

  if (settlement.settlement_start && settlement.settlement_end) {
    // Remboursements FBA : filtre sur approval_date (= date où Amazon
    // a validé le remboursement et l'a posté sur le compte).
    const { data: rd } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select(
        'reimbursement_id, approval_date, case_id, amazon_order_id, reason, sku, asin, product_name, currency, amount_per_unit, amount_total, quantity_reimbursed_total',
      )
      .gte('approval_date', settlement.settlement_start)
      .lte('approval_date', settlement.settlement_end);
    if (rd) reimbs = rd as ReimbRow[];

    // Customer Returns : filtre sur return_date (= jour où Amazon a
    // physiquement reçu le retour client en warehouse).
    const { data: cr } = await supabaseAdmin
      .from('amazon_customer_returns')
      .select(
        'license_plate_number, return_date, order_id, sku, asin, fnsku, product_name, quantity, fulfillment_center_id, detailed_disposition, reason, status, customer_comments',
      )
      .gte('return_date', settlement.settlement_start)
      .lte('return_date', settlement.settlement_end);
    if (cr) returns = cr as CustomerReturnRow[];

    // Removal Orders : filtre sur last_updated_date (= dernier mvt de
    // statut Amazon, plus représentatif que request_date qui peut être
    // hors période).
    const { data: ro } = await supabaseAdmin
      .from('amazon_removal_orders')
      .select(
        'order_id, sku, fnsku, request_date, last_updated_date, order_type, order_status, disposition, requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity, removal_fee, currency',
      )
      .gte('last_updated_date', settlement.settlement_start)
      .lte('last_updated_date', settlement.settlement_end);
    if (ro) removals = ro as RemovalOrderRow[];

    // FBA Inventory : snapshot LE PLUS PROCHE de settlement_end (sans
    // dépasser). Donne l'état du stock à la clôture du cycle — utile
    // pour valoriser l'inventaire au bilan de période.
    const endDateOnly = settlement.settlement_end.slice(0, 10);
    const { data: snapDates } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .lte('snapshot_date', endDateOnly)
      .order('snapshot_date', { ascending: false })
      .limit(1);
    if (snapDates?.[0]?.snapshot_date) {
      inventorySnapshotDate = snapDates[0].snapshot_date;
      const invAll: FbaInventoryRow[] = [];
      let invFrom = 0;
      while (true) {
        const { data: inv } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select(
            'snapshot_date, sku, fnsku, asin, product_name, condition, your_price, afn_warehouse_quantity, afn_fulfillable_quantity, afn_unsellable_quantity, afn_reserved_quantity, afn_total_quantity, afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity',
          )
          .eq('snapshot_date', inventorySnapshotDate)
          .range(invFrom, invFrom + 999);
        if (!inv || inv.length === 0) break;
        invAll.push(...(inv as FbaInventoryRow[]));
        if (inv.length < 1000) break;
        invFrom += 1000;
      }
      inventorySnapshot = invAll;
    }
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
    [],
    ['Filtres de date appliqués aux autres onglets (compta exacte)'],
    ['Transactions brutes', `posted_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'} (déjà liées par settlement_id)`],
    ['Remboursements FBA', `approval_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'}`],
    ['Customer Returns', `return_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'}`],
    ['Removal Orders', `last_updated_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'}`],
    ['FBA Inventory snapshot', inventorySnapshotDate ? `Snapshot du ${inventorySnapshotDate} (le plus proche ≤ settlement_end)` : 'Aucun snapshot disponible avant settlement_end'],
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

  // ──── Onglet 6 : Customer Returns ─────────────────────────────────
  const returnsSheet: Array<Array<string | number>> = [
    [`Filtre : return_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'}`],
    [],
    [
      'license_plate_number',
      'return_date',
      'order_id',
      'sku',
      'asin',
      'fnsku',
      'product_name',
      'quantity',
      'fulfillment_center_id',
      'detailed_disposition',
      'reason',
      'status',
      'customer_comments',
    ],
    ...returns.map((r) => [
      r.license_plate_number ?? '',
      r.return_date ?? '',
      r.order_id ?? '',
      r.sku ?? '',
      r.asin ?? '',
      r.fnsku ?? '',
      r.product_name ?? '',
      num(r.quantity),
      r.fulfillment_center_id ?? '',
      r.detailed_disposition ?? '',
      r.reason ?? '',
      r.status ?? '',
      r.customer_comments ?? '',
    ]),
    ['', '', '', '', '', '', '', '', '', '', '', '', ''],
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      returns.reduce((s, r) => s + num(r.quantity), 0),
      '',
      '',
      '',
      '',
      '',
    ],
  ];

  // ──── Onglet 7 : Removal Orders ───────────────────────────────────
  const removalSheet: Array<Array<string | number>> = [
    [`Filtre : last_updated_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'}`],
    [],
    [
      'order_id',
      'sku',
      'fnsku',
      'request_date',
      'last_updated_date',
      'order_type',
      'order_status',
      'disposition',
      'requested_qty',
      'shipped_qty',
      'disposed_qty',
      'cancelled_qty',
      'removal_fee',
      'currency',
    ],
    ...removals.map((r) => [
      r.order_id ?? '',
      r.sku ?? '',
      r.fnsku ?? '',
      r.request_date ?? '',
      r.last_updated_date ?? '',
      r.order_type ?? '',
      r.order_status ?? '',
      r.disposition ?? '',
      num(r.requested_quantity),
      num(r.shipped_quantity),
      num(r.disposed_quantity),
      num(r.cancelled_quantity),
      num(r.removal_fee),
      r.currency ?? '',
    ]),
    ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      removals.reduce((s, r) => s + num(r.requested_quantity), 0),
      removals.reduce((s, r) => s + num(r.shipped_quantity), 0),
      removals.reduce((s, r) => s + num(r.disposed_quantity), 0),
      removals.reduce((s, r) => s + num(r.cancelled_quantity), 0),
      Math.round(removals.reduce((s, r) => s + num(r.removal_fee), 0) * 100) / 100,
      '',
    ],
  ];

  // ──── Onglet 8 : FBA Inventory snapshot ───────────────────────────
  const inventorySheet: Array<Array<string | number>> = [
    [
      inventorySnapshotDate
        ? `Snapshot du ${inventorySnapshotDate} (le plus proche ≤ settlement_end ${settlement.settlement_end ?? '∅'})`
        : 'Aucun snapshot disponible avant settlement_end — la sync auto démarre tard, attends 24h.',
    ],
    [],
    [
      'sku',
      'fnsku',
      'asin',
      'product_name',
      'condition',
      'your_price',
      'afn_warehouse_qty',
      'afn_fulfillable_qty',
      'afn_unsellable_qty',
      'afn_reserved_qty',
      'afn_total_qty',
      'afn_inbound_working_qty',
      'afn_inbound_shipped_qty',
      'afn_inbound_receiving_qty',
    ],
    ...inventorySnapshot.map((i) => [
      i.sku ?? '',
      i.fnsku ?? '',
      i.asin ?? '',
      i.product_name ?? '',
      i.condition ?? '',
      num(i.your_price),
      num(i.afn_warehouse_quantity),
      num(i.afn_fulfillable_quantity),
      num(i.afn_unsellable_quantity),
      num(i.afn_reserved_quantity),
      num(i.afn_total_quantity),
      num(i.afn_inbound_working_quantity),
      num(i.afn_inbound_shipped_quantity),
      num(i.afn_inbound_receiving_quantity),
    ]),
    ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      inventorySnapshot.reduce((s, i) => s + num(i.afn_warehouse_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_fulfillable_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_unsellable_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_reserved_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_total_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_inbound_working_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_inbound_shipped_quantity), 0),
      inventorySnapshot.reduce((s, i) => s + num(i.afn_inbound_receiving_quantity), 0),
    ],
  ];

  // ──── Annotations dates en haut des onglets P&L / Dropship / Reimb ────
  reimbSheet.unshift([`Filtre : approval_date BETWEEN ${settlement.settlement_start ?? '∅'} AND ${settlement.settlement_end ?? '∅'}`], []);
  txSheet.unshift([`Toutes les transactions liées via settlement_id (= cycle ${settlement.settlement_start?.slice(0,10) ?? '?'} → ${settlement.settlement_end?.slice(0,10) ?? '?'})`], []);

  // ──── Build workbook ──────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumeSheet), 'Résumé');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(plSheet), 'P&L par catégorie');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dskSheet), 'Dropship Kimpex');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reimbSheet), 'Remboursements FBA');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(returnsSheet), 'Customer Returns');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(removalSheet), 'Removal Orders');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inventorySheet), 'FBA Inventory');
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
