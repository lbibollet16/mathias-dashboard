/**
 * Détection des claims manqués — Phase 2.2.
 *
 * Pour chaque event Lost/Damaged dans amazon_inventory_ledger :
 *   1. Cherche un reimbursement matché par (sku, date proche, quantité)
 *   2. Si pas de match → c'est un claim candidate
 *   3. Calcule l'estimated_amount via le **coût de revient** du SKU
 *      (politique Amazon mars 2025 : ils remboursent au cost, plus au
 *      prix de vente — voir amazon-sku-costs.sql)
 *   4. Détermine si éligible (30j min, 540j max = 18 mois)
 *   5. Upsert dans amazon_claim_candidates
 *
 * Notes politique 2025 :
 *   - Avant mars 2025 : Amazon remboursait au prix de vente moyen.
 *   - Depuis mars 2025 : Amazon rembourse au coût de sourcing/fabrication.
 *   - Si le coût est inconnu pour un SKU, estimated_amount=null
 *     (préférer pas de chiffre à un chiffre faux qui survend ce qu'on
 *     va vraiment récupérer).
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

// ─── Etape 2 : récup des coûts de revient par SKU ──────────────────────
//
// Depuis la politique Amazon de mars 2025, les remboursements FBA pour
// inventaire perdu/endommagé sont calculés sur le **coût de sourcing**
// (achat fournisseur + shipping inbound), plus sur le prix de vente.
// Source canonique : amazon_sku_costs (alimentée depuis MPP via le bridge
// ou par import manuel). Si un SKU n'a pas de cost connu, on retourne
// undefined → estimated_amount=null côté caller, pour éviter de fournir
// un chiffre erroné qui survende ce qu'on va vraiment toucher.

interface CostCache {
  bySku: Map<string, number>;
  byFnsku: Map<string, number>;
  missingSkus: Set<string>;
}

async function loadSkuCosts(): Promise<CostCache> {
  const bySku = new Map<string, number>();
  const byFnsku = new Map<string, number>();

  // On lit en pages pour gérer >1000 rows si jamais le référentiel grandit.
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('amazon_sku_costs')
      .select('sku, fnsku, cost_amount, cost_currency')
      .range(from, from + 999);
    if (error) {
      // Si la table n'existe pas encore (migration pas appliquée), on
      // retourne un cache vide — claims-detection.ts traitera tout en
      // estimated_amount=null.
      if (/relation .* does not exist/i.test(error.message)) break;
      throw new Error('amazon_sku_costs fetch: ' + error.message);
    }
    if (!data || data.length === 0) break;
    for (const r of data as Array<{
      sku: string | null;
      fnsku: string | null;
      cost_amount: number | string | null;
      cost_currency: string | null;
    }>) {
      const cost = Number(r.cost_amount);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      // /!\ on stocke et on rembourse en CAD. Si un import a laissé un
      // SKU en USD, on ne le convertit pas tacitement — on le saute et
      // l'utilisateur devra le compléter en CAD. Mieux que multiplier
      // discrètement.
      if (r.cost_currency && r.cost_currency !== 'CAD') continue;
      if (r.sku) bySku.set(r.sku, cost);
      if (r.fnsku) byFnsku.set(r.fnsku, cost);
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  return { bySku, byFnsku, missingSkus: new Set() };
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

  // 3. Cache des coûts de revient (politique Amazon mars 2025 : remboursé
  //    au coût, pas au prix de vente).
  const costCache = await loadSkuCosts();

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

    // Pas matché → candidat à un claim.
    //
    // Si on connaît le coût de revient du SKU, on calcule l'estimation
    // au cost basis Amazon mars 2025. Sinon estimated_amount=null —
    // le user verra "coût inconnu" dans l'UI et saura qu'il faut
    // peupler amazon_sku_costs pour ce SKU avant de chiffrer le case.
    const unitCost =
      (ev.sku && costCache.bySku.get(ev.sku)) ??
      (ev.fnsku && costCache.byFnsku.get(ev.fnsku)) ??
      null;
    const estimatedAmount = unitCost != null ? unitCost * qty : null;

    const evDate = new Date(ev.event_date);
    const daysSince = Math.floor((now.getTime() - evDate.getTime()) / 86_400_000);
    const eligible = daysSince >= MIN_DAYS_TO_CLAIM && daysSince <= MAX_DAYS_TO_CLAIM;

    const payload = buildClaimPayload(ev, qty, estimatedAmount ?? 0);

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
      estimated_unit_price: unitCost != null ? Math.round(unitCost * 100) / 100 : null,
      estimated_amount: estimatedAmount != null ? Math.round(estimatedAmount * 100) / 100 : null,
      days_since_event: daysSince,
      eligible_to_claim: eligible,
      claim_payload: payload,
      updated_at: new Date().toISOString(),
    });

    if (estimatedAmount != null) {
      result.total_estimated_amount += estimatedAmount;
    }
    const bucket =
      result.by_event_type[ev.event_type] || { count: 0, estimated_amount: 0 };
    bucket.count += qty;
    if (estimatedAmount != null) bucket.estimated_amount += estimatedAmount;
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
