/**
 * Détection des claims manqués — Phase 2.2.
 *
 * Pour chaque event Lost/Damaged dans amazon_inventory_ledger :
 *   1. Cherche un reimbursement matché par (sku, date proche, quantité)
 *   2. Si pas de match → c'est un claim candidate
 *   3. Calcule l'estimated_amount via le prix de vente moyen 90j du SKU
 *   4. Détermine si éligible (30j min, 540j max = 18 mois)
 *   5. Upsert dans amazon_claim_candidates
 *
 * Lance en cron quotidien après le ledger sync.
 *
 * Server-only.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';

// Délais Amazon pour réclamer (source: Seller Central Help)
const MIN_DAYS_TO_CLAIM = 30; // doit attendre 30j après l'event
const MAX_DAYS_TO_CLAIM = 18 * 30; // 18 mois après l'event = expiré

// Tolérance temporelle pour matcher un event ledger avec un reimbursement
const REIMBURSEMENT_MATCH_WINDOW_DAYS = 90;

interface LedgerEvent {
  id: number;
  event_date: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  event_type: string;
  quantity: number;
  fulfillment_center: string | null;
  reference_id: string | null;
}

interface ReimbursementRecord {
  reimbursement_id: string;
  approval_date: string | null;
  sku: string | null;
  fnsku: string | null;
  amount_per_unit: number | null;
  amount_total: number | null;
  quantity_reimbursed_cash: number | null;
  quantity_reimbursed_inventory: number | null;
  quantity_reimbursed_total: number | null;
  reason: string | null;
}

// ─── Etape 1 : matching ledger ↔ reimbursements ─────────────────────────

/**
 * Tente de matcher un event ledger Lost/Damaged avec un reimbursement.
 * Heuristique :
 *   - même SKU (ou FNSKU si dispo)
 *   - reimbursement approved après l'event (mais dans 90j)
 *   - quantity ledger >= quantity reimbursed (Amazon peut payer partiel)
 */
function matchLedgerToReimbursement(
  event: LedgerEvent,
  reimbursements: ReimbursementRecord[],
): ReimbursementRecord | null {
  const eventDate = new Date(event.event_date);
  const eventQty = Math.abs(event.quantity);

  const candidates = reimbursements.filter((r) => {
    // Match SKU (ou FNSKU si SKU absent d'un côté)
    const skuMatch =
      (event.sku && r.sku && event.sku === r.sku) ||
      (event.fnsku && r.fnsku && event.fnsku === r.fnsku);
    if (!skuMatch) return false;

    // Date après event, dans la fenêtre
    if (!r.approval_date) return false;
    const reimbDate = new Date(r.approval_date);
    if (reimbDate < eventDate) return false;
    const daysDiff = (reimbDate.getTime() - eventDate.getTime()) / 86_400_000;
    if (daysDiff > REIMBURSEMENT_MATCH_WINDOW_DAYS) return false;

    // Quantité couvre l'event
    const reimbQty = r.quantity_reimbursed_total || r.quantity_reimbursed_cash || 0;
    if (reimbQty < eventQty) {
      // Amazon a remboursé moins que ce qu'on a perdu — match partiel,
      // on accepte mais on flag la différence
      return reimbQty > 0;
    }
    return true;
  });

  if (candidates.length === 0) return null;
  // Prend le plus proche temporellement
  candidates.sort((a, b) => {
    const dA = new Date(a.approval_date!).getTime();
    const dB = new Date(b.approval_date!).getTime();
    return dA - dB;
  });
  return candidates[0];
}

// ─── Etape 2 : estimation du prix de vente moyen 90j ────────────────────

interface PriceCache {
  bySku: Map<string, number>;
  byFnsku: Map<string, number>;
}

async function loadAvgPricesLast90Days(): Promise<PriceCache> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();

  // Source primaire : amazon_transactions où amount_type='ItemPrice' et
  // amount_description='Principal'. amount/quantity_purchased = prix unitaire.
  const { data: tx } = await supabaseAdmin
    .from('amazon_transactions')
    .select('sku, amount, quantity_purchased, posted_date')
    .eq('amount_type', 'ItemPrice')
    .eq('amount_description', 'Principal')
    .gte('posted_date', cutoff)
    .gt('quantity_purchased', 0);

  const bySku = new Map<string, { sum: number; n: number }>();
  for (const r of (tx ?? []) as Array<{
    sku: string | null;
    amount: number | null;
    quantity_purchased: number | null;
  }>) {
    if (!r.sku || !r.amount || !r.quantity_purchased) continue;
    const unit = Number(r.amount) / Number(r.quantity_purchased);
    if (unit <= 0) continue;
    const ex = bySku.get(r.sku) || { sum: 0, n: 0 };
    ex.sum += unit;
    ex.n++;
    bySku.set(r.sku, ex);
  }
  const skuAvg = new Map<string, number>();
  for (const [sku, v] of bySku) skuAvg.set(sku, v.sum / v.n);

  // Source secondaire : amazon_fba_inventory `your_price` (snapshot le plus récent)
  // pour les SKUs sans historique de ventes.
  const { data: snap } = await supabaseAdmin
    .from('amazon_fba_inventory')
    .select('sku, fnsku, your_price, snapshot_date')
    .gt('your_price', 0)
    .order('snapshot_date', { ascending: false })
    .limit(2000);

  const fnskuAvg = new Map<string, number>();
  for (const r of (snap ?? []) as Array<{
    sku: string | null;
    fnsku: string | null;
    your_price: number | null;
  }>) {
    if (r.sku && !skuAvg.has(r.sku) && r.your_price) skuAvg.set(r.sku, Number(r.your_price));
    if (r.fnsku && r.your_price && !fnskuAvg.has(r.fnsku))
      fnskuAvg.set(r.fnsku, Number(r.your_price));
  }

  return { bySku: skuAvg, byFnsku: fnskuAvg };
}

// ─── Etape 3 : génération du template de claim ──────────────────────────

function buildClaimPayload(
  event: LedgerEvent,
  qty: number,
  estimatedAmount: number,
): Record<string, unknown> {
  const eventTypeLabel = event.event_type;
  const sellerCentralUrl =
    'https://sellercentral.amazon.ca/help/hub/reference/200213130'; // FBA Reimbursement page
  const caseSubject = `Reimbursement request - ${eventTypeLabel} - SKU ${event.sku} - ${qty} unit(s)`;
  const caseBody = `Hello Amazon Support,

I am requesting an inventory reimbursement for the following event recorded in my Inventory Ledger Detail report:

- Event Date: ${event.event_date}
- Event Type: ${eventTypeLabel}
- SKU: ${event.sku || '(unknown)'}
- FNSKU: ${event.fnsku || '(unknown)'}
- ASIN: ${event.asin || '(unknown)'}
- Quantity affected: ${qty}
- Fulfillment Center: ${event.fulfillment_center || '(unknown)'}
- Reference ID: ${event.reference_id || '(none)'}
- Estimated value: ${estimatedAmount.toFixed(2)} CAD (based on 90-day average selling price)

I do not see a corresponding reimbursement in my reimbursement history. Could you please investigate and process the reimbursement?

Thank you,
Mathias Power Parts`;

  return {
    case_subject: caseSubject,
    case_body: caseBody,
    seller_central_url: sellerCentralUrl,
    suggested_email_to: 'fba-claim@amazon.ca', // ou via Help → Contact Us in Seller Central
  };
}

// ─── Detection principale ───────────────────────────────────────────────

export interface DetectionResult {
  events_scanned: number;
  events_matched_to_reimbursement: number;
  candidates_inserted: number;
  candidates_updated: number;
  total_estimated_amount: number;
  by_event_type: Record<string, { count: number; estimated_amount: number }>;
  errors: number;
}

export async function detectMissingClaims(opts: {
  /** Si fourni, ne scan que les events depuis cette date (default: 18 mois). */
  fromDate?: string;
  /** Si true, ne traite QUE les events Lost (skip Damaged). Default false. */
  lostOnly?: boolean;
} = {}): Promise<DetectionResult> {
  const cutoff =
    opts.fromDate ??
    new Date(Date.now() - MAX_DAYS_TO_CLAIM * 86_400_000).toISOString().slice(0, 10);

  const eventTypes = opts.lostOnly ? ['Lost'] : ['Lost', 'Damaged'];

  // 1. Charge tous les events Lost/Damaged dans la fenêtre
  const ledgerEvents: LedgerEvent[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('amazon_inventory_ledger')
      .select('id, event_date, sku, fnsku, asin, event_type, quantity, fulfillment_center, reference_id')
      .in('event_type', eventTypes)
      .gte('event_date', cutoff)
      .range(from, from + 999);
    if (error) throw new Error('ledger fetch: ' + error.message);
    ledgerEvents.push(...((data ?? []) as LedgerEvent[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }

  // 2. Charge tous les reimbursements de la même fenêtre + 90j de marge
  const reimbCutoff = new Date(cutoff);
  reimbCutoff.setDate(reimbCutoff.getDate() - 30); // marge de sécurité
  const allReimbursements: ReimbursementRecord[] = [];
  from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select(
        'reimbursement_id, approval_date, sku, fnsku, amount_per_unit, amount_total, quantity_reimbursed_cash, quantity_reimbursed_inventory, quantity_reimbursed_total, reason',
      )
      .gte('approval_date', reimbCutoff.toISOString())
      .range(from, from + 999);
    if (error) throw new Error('reimbursements fetch: ' + error.message);
    allReimbursements.push(...((data ?? []) as ReimbursementRecord[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }

  // Index reimbursements par SKU pour matching plus rapide
  const reimbBySku = new Map<string, ReimbursementRecord[]>();
  for (const r of allReimbursements) {
    const key = r.sku || r.fnsku || '';
    if (!key) continue;
    const arr = reimbBySku.get(key) || [];
    arr.push(r);
    reimbBySku.set(key, arr);
  }

  // 3. Cache des prix
  const priceCache = await loadAvgPricesLast90Days();

  // 4. Pour chaque event : match ou candidate
  const result: DetectionResult = {
    events_scanned: ledgerEvents.length,
    events_matched_to_reimbursement: 0,
    candidates_inserted: 0,
    candidates_updated: 0,
    total_estimated_amount: 0,
    by_event_type: {},
    errors: 0,
  };

  const candidatesToUpsert: Array<Record<string, unknown>> = [];
  const ledgerMatchUpdates: Array<{ id: number; matched_reimbursement_id: string }> = [];

  const now = new Date();

  for (const ev of ledgerEvents) {
    const qty = Math.abs(ev.quantity);
    if (qty === 0) continue;

    const candidates =
      reimbBySku.get(ev.sku || '') ?? reimbBySku.get(ev.fnsku || '') ?? [];
    const match = matchLedgerToReimbursement(ev, candidates);

    if (match) {
      result.events_matched_to_reimbursement++;
      ledgerMatchUpdates.push({ id: ev.id, matched_reimbursement_id: match.reimbursement_id });
      continue;
    }

    // Pas matché → candidat à un claim
    const unitPrice =
      (ev.sku && priceCache.bySku.get(ev.sku)) ||
      (ev.fnsku && priceCache.byFnsku.get(ev.fnsku)) ||
      0;
    const estimatedAmount = unitPrice * qty;

    const evDate = new Date(ev.event_date);
    const daysSince = Math.floor((now.getTime() - evDate.getTime()) / 86_400_000);
    const eligible = daysSince >= MIN_DAYS_TO_CLAIM && daysSince <= MAX_DAYS_TO_CLAIM;

    const payload = buildClaimPayload(ev, qty, estimatedAmount);

    candidatesToUpsert.push({
      ledger_event_id: ev.id,
      sku: ev.sku,
      fnsku: ev.fnsku,
      asin: ev.asin,
      event_date: ev.event_date,
      event_type: ev.event_type,
      quantity: qty,
      fulfillment_center: ev.fulfillment_center,
      reference_id: ev.reference_id,
      estimated_unit_price: unitPrice > 0 ? Math.round(unitPrice * 100) / 100 : null,
      estimated_amount: estimatedAmount > 0 ? Math.round(estimatedAmount * 100) / 100 : null,
      days_since_event: daysSince,
      eligible_to_claim: eligible,
      claim_payload: payload,
      updated_at: new Date().toISOString(),
    });

    result.total_estimated_amount += estimatedAmount;
    const bucket =
      result.by_event_type[ev.event_type] || { count: 0, estimated_amount: 0 };
    bucket.count += qty;
    bucket.estimated_amount += estimatedAmount;
    result.by_event_type[ev.event_type] = bucket;
  }

  // 5. Bulk upsert des candidates (idempotent par ledger_event_id)
  for (let i = 0; i < candidatesToUpsert.length; i += 500) {
    const batch = candidatesToUpsert.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from('amazon_claim_candidates')
      .upsert(batch, { onConflict: 'ledger_event_id' });
    if (error) {
      result.errors++;
      // Note l'erreur mais continue
      continue;
    }
    result.candidates_inserted += batch.length;
  }

  // 6. Marque les events matched dans le ledger
  for (let i = 0; i < ledgerMatchUpdates.length; i += 500) {
    const batch = ledgerMatchUpdates.slice(i, i + 500);
    // Pas de bulk update simple via supabase-js — on fait des updates individuels
    // mais regroupés par reimbursement_id pour limiter les requêtes.
    const byReimb = new Map<string, number[]>();
    for (const u of batch) {
      const arr = byReimb.get(u.matched_reimbursement_id) || [];
      arr.push(u.id);
      byReimb.set(u.matched_reimbursement_id, arr);
    }
    for (const [reimbId, ids] of byReimb) {
      await supabaseAdmin
        .from('amazon_inventory_ledger')
        .update({ matched_reimbursement_id: reimbId })
        .in('id', ids);
    }
  }

  result.total_estimated_amount = Math.round(result.total_estimated_amount * 100) / 100;
  for (const k of Object.keys(result.by_event_type)) {
    result.by_event_type[k].estimated_amount =
      Math.round(result.by_event_type[k].estimated_amount * 100) / 100;
  }

  return result;
}
