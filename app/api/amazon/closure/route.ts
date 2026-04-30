import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant } from '@/lib/amazon-inventory'
import { loadManualMappings } from '@/lib/amazon-mapping'

// GET /api/amazon/closure
//   Retourne la liste de tous les settlements avec leur statut des 6 étapes.
// GET /api/amazon/closure?id=XXX
//   Retourne le détail complet d'un settlement pour sa page de fermeture :
//   - les 6 étapes avec état calculé + items à traiter par étape
//   - la balance d'inventaire (par base product) + flag bloquant si écart > 1
//
// POST /api/amazon/closure
//   Body: { settlement_id, step: 3|4|6, employe: string, action: 'validate' | 'unvalidate' }
//   Valide/dévalide une étape manuelle. Les étapes 1,2,5 sont auto-calculées.
//
// POST /api/amazon/closure avec step='close'
//   Ferme le settlement (tous les checkpoints doivent passer).

const TOLERANCE = 1

interface StepStatus {
  key: '1_lautopak' | '2_reimbursements' | '3_unsellable' | '4_ajustements' | '5_audit' | '6_rapport'
  label: string
  status: 'done' | 'action' | 'locked'
  detail: string
  items?: any[]
  validated_at?: string | null
  validated_by?: string | null
  blocking_count?: number
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  try {
    if (!id) {
      // Liste tous les settlements avec résumé
      const { data: settlements, error } = await supabaseAdmin
        .from('amazon_settlements')
        .select('*')
        .order('settlement_end', { ascending: false })
        .limit(50)
      if (error) throw error
      const result = (settlements || []).map((s: any) => ({
        settlement_id: s.settlement_id,
        settlement_start: s.settlement_start,
        settlement_end: s.settlement_end,
        deposit_date: s.deposit_date,
        total_amount: Number(s.total_amount || 0),
        lautopak_invoice_ref: s.lautopak_invoice_ref,
        lautopak_status: s.lautopak_status,
        closed_at: s.closed_at,
        closed_by: s.closed_by,
      }))
      return NextResponse.json({ settlements: result })
    }

    // Détail complet d'un settlement
    const { data: s, error: sErr } = await supabaseAdmin
      .from('amazon_settlements')
      .select('*')
      .eq('settlement_id', id)
      .maybeSingle()
    if (sErr) throw sErr
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    // ── Étape 1 : LAUTOPAK ─────────────────────────────────────────────
    // ── Check des 3 fichiers requis pour ce settlement ───────────────
    // 1. Payments TSV (implicite : le settlement existe)
    // 2. FBA Inventory (snapshot dont la date est dans la période OU la plus proche)
    // 3. Reimbursements CSV (toutes les lignes liées à ce settlement_id)
    const startDate = s.settlement_start ? String(s.settlement_start).split('T')[0] : null
    const endDate = s.settlement_end ? String(s.settlement_end).split('T')[0] : null
    // Compter transactions payments
    const { count: paymentsCount } = await supabaseAdmin
      .from('amazon_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('settlement_id', s.settlement_id)
    // Snapshot FBA dans la période (ou le plus proche avant end)
    let fbaSnapshotDate: string | null = null
    let fbaSnapshotRows = 0
    if (endDate) {
      const { data: snaps } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('snapshot_date')
        .lte('snapshot_date', endDate)
        .order('snapshot_date', { ascending: false })
        .limit(1)
      fbaSnapshotDate = snaps && snaps[0]?.snapshot_date || null
      if (fbaSnapshotDate) {
        const { count: fbaCount } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('id', { count: 'exact', head: true })
          .eq('snapshot_date', fbaSnapshotDate)
        fbaSnapshotRows = fbaCount || 0
      }
    }
    // Reimbursements liés
    const { count: reimbsCountTotal } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select('id', { count: 'exact', head: true })
      .eq('settlement_id', s.settlement_id)

    // Customer Returns dans la période 60j glissants finissant à settlement_end
    let customerReturnsCount = 0
    if (endDate) {
      const dt60 = new Date(endDate)
      dt60.setDate(dt60.getDate() - 60)
      const dt60Iso = dt60.toISOString()
      const { count: crCount } = await supabaseAdmin
        .from('amazon_customer_returns')
        .select('id', { count: 'exact', head: true })
        .gte('return_date', dt60Iso)
        .lte('return_date', endDate + 'T23:59:59Z')
      customerReturnsCount = crCount || 0
    }

    const fichiers_importes = {
      payments: {
        imported: (paymentsCount || 0) > 0,
        count: paymentsCount || 0,
        file_name: s.file_name,
        label: 'Payments (settlement TSV)',
      },
      fba_inventory: {
        imported: !!fbaSnapshotDate,
        snapshot_date: fbaSnapshotDate,
        count: fbaSnapshotRows,
        dans_periode: !!(fbaSnapshotDate && startDate && fbaSnapshotDate >= startDate && fbaSnapshotDate <= endDate!),
        label: 'FBA Inventory',
      },
      reimbursements: {
        imported: (reimbsCountTotal || 0) > 0,
        count: reimbsCountTotal || 0,
        label: 'Reimbursements CSV',
      },
    }

    // ── Étape 1 : LAUTOPAK ─────────────────────────────────────────────
    const step1_done = !!s.lautopak_invoice_ref && !!s.lautopak_invoice_date
    const step1: StepStatus = {
      key: '1_lautopak',
      label: 'Facturation LAUTOPAK',
      status: step1_done ? 'done' : 'action',
      detail: step1_done
        ? `Facture ${s.lautopak_invoice_ref} du ${String(s.lautopak_invoice_date).split('T')[0]}`
        : `Créer une facture LAUTOPAK de ${Number(s.total_amount || 0).toFixed(2)} $ et inscrire son n° ici`,
    }

    // ── Étape 2 : Reimbursements matchés + ajustements Traction ──────
    const { data: reimbs } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select('id, reimbursement_id, sku, fnsku, traction_code, amount_total, amount_per_unit, quantity_reimbursed_cash, quantity_reimbursed_inventory, reason, product_name, settlement_id, case_id, inventaire_ajuste_le, inventaire_ajuste_par, inventaire_pk_code')
      .eq('settlement_id', s.settlement_id)

    // Matching automatique case_id ↔ actions unsellable précédentes
    const caseIds = Array.from(new Set((reimbs || []).map((r: any) => r.case_id).filter(Boolean)))
    const caseMatches = new Map<string, any>()  // case_id -> unsellable_action info
    if (caseIds.length > 0) {
      const { data: unsAct } = await supabaseAdmin
        .from('amazon_unsellable_actions')
        .select('settlement_id, sku, amazon_ref, action_type, action_le, action_par, notes')
        .in('amazon_ref', caseIds)
        .eq('action_type', 'case')
      for (const u of unsAct || []) caseMatches.set(u.amazon_ref, u)
    }
    const reimbsCount = (reimbs || []).length
    const { data: reimbTx } = await supabaseAdmin
      .from('amazon_transactions')
      .select('sku, amount, amount_type')
      .eq('settlement_id', s.settlement_id)
      .ilike('amount_type', '%Reimbursement%')
    const txCount = (reimbTx || []).length
    const matchOk = reimbsCount > 0 ? reimbsCount === txCount : txCount === 0
    const hasCashReimb = (reimbs || []).some((r: any) => Number(r.quantity_reimbursed_cash || 0) > 0)
    const hasReimbInvoice = !!s.lautopak_reimb_invoice_ref && !!s.lautopak_reimb_invoice_date
    // Étape 2 validée quand :
    //   - s'il y a des cash reimbs : n° facture LAUTOPAK reimb rempli ET TOUS
    //     les reimbursements cash sont marqués comme "ajustés" (checkbox cochée)
    //   - s'il n'y a pas de cash reimbs : juste le match CSV↔payments suffit
    const cashReimbs = (reimbs || []).filter((r: any) => Number(r.quantity_reimbursed_cash || 0) > 0)
    const allAjuste = cashReimbs.length === 0 || cashReimbs.every((r: any) => !!r.inventaire_ajuste_le)
    const step2_done = hasCashReimb
      ? (hasReimbInvoice && allAjuste)
      : matchOk   // sans cash → match CSV suffit

    // Pour chaque reimbursement CASH : calculer la ligne Traction à décrémenter.
    // Priorité au multi-mapping manuel (amazon_sku_pkcodes) sinon auto-strip.
    const reimbCashItems = (reimbs || []).filter((r: any) => Number(r.quantity_reimbursed_cash || 0) > 0)
    const ajustementsFba: any[] = []
    if (reimbCashItems.length > 0) {
      const manualMappings = await loadManualMappings()
      const resolvePk = (sku: string, tc: string | null): { pk: string | null; mult: number; manual: boolean } => {
        const manual = manualMappings.get(sku)
        if (manual && manual.length > 0) return { pk: manual[0].pk_code, mult: manual[0].multiplier, manual: true }
        const code = tc || ''
        const stripped = code.replace(/^[A]/, '').replace(/^(HUB|FBA|FBM)-/i, '').replace(/-(HUB|FBA|FBM)\d*$/i, '')
        return { pk: stripped ? `FBA-${stripped}` : null, mult: 1, manual: false }
      }
      const pkCodesToLookup = Array.from(new Set(
        reimbCashItems.map((r: any) => resolvePk(r.sku, r.traction_code).pk).filter(Boolean) as string[]
      ))
      const { data: fbaLines } = pkCodesToLookup.length
        ? await supabaseAdmin
            .from('traction_amazon_lignes')
            .select('pk_code, qty, qty_minus_reserved, code_ligne')
            .in('pk_code', pkCodesToLookup)
        : { data: [] }
      const fbaByPk = new Map<string, any>()
      for (const f of fbaLines || []) fbaByPk.set(f.pk_code, f)

      for (const r of reimbCashItems) {
        const { pk, mult, manual } = resolvePk(r.sku, r.traction_code)
        const fbaLine = pk ? fbaByPk.get(pk) : null
        const qtyCash = Number(r.quantity_reimbursed_cash || 0)
        const caseMatch = r.case_id ? caseMatches.get(r.case_id) : null
        ajustementsFba.push({
          reimbursement_id: r.reimbursement_id,
          sku: r.sku,
          case_id: r.case_id,
          case_matched_action: caseMatch || null,
          product_name: r.product_name,
          traction_code: r.traction_code,
          reason: r.reason,
          qty_cash: qtyCash,
          qty_cash_lautopak: qtyCash * mult,   // qté à décrémenter avec multiplier
          qty_inventory: Number(r.quantity_reimbursed_inventory || 0),
          amount: Number(r.amount_total || 0),
          pk_code_to_adjust: pk,
          multiplier: mult,
          manual_mapping: manual,
          current_traction_qty: fbaLine ? Number(fbaLine.qty_minus_reserved || 0) : null,
          found_in_traction: !!fbaLine,
          inventaire_ajuste_le: r.inventaire_ajuste_le,
          inventaire_ajuste_par: r.inventaire_ajuste_par,
          inventaire_pk_code: r.inventaire_pk_code,
        })
      }
    }

    let step2_detail: string
    const nbAjuste = cashReimbs.filter((r: any) => !!r.inventaire_ajuste_le).length
    const nbCash = cashReimbs.length
    if (reimbsCount === 0 && txCount === 0) {
      step2_detail = 'Aucun remboursement dans cette période (OK)'
    } else if (!hasCashReimb) {
      step2_detail = matchOk ? `${reimbsCount} reimbursements matchés (aucun cash)` : `${reimbsCount} ↔ ${txCount} — vérifier l'import CSV reimbursements`
    } else if (!hasReimbInvoice) {
      step2_detail = `⚠️ ${nbCash} reimbursements cash → créer une facture LAUTOPAK pour pièces perdues et inscrire son n° + date ici`
    } else if (nbAjuste < nbCash) {
      step2_detail = `Facture LAUTOPAK ${s.lautopak_reimb_invoice_ref} OK — reste ${nbCash - nbAjuste}/${nbCash} cases à cocher après ajustement LAUTOPAK`
    } else {
      step2_detail = `✅ Facture LAUTOPAK ${s.lautopak_reimb_invoice_ref} + ${nbCash}/${nbCash} reimbursements cochés`
    }

    const step2: StepStatus = {
      key: '2_reimbursements',
      label: 'Remboursements matchés + Facture LAUTOPAK pièces perdues',
      status: step1_done ? (step2_done ? 'done' : 'action') : 'locked',
      detail: step2_detail,
      items: ajustementsFba,
      blocking_count: Math.max(0, txCount - reimbsCount),
    }

    // ── Étape 3 : Unsellable à réclamer ────────────────────────────────
    // On regarde le DERNIER snapshot FBA précédant settlement_end et on liste
    // les SKU avec afn_unsellable > 0. C'est un signal, pas un blocage auto.
    const settlementEndDate = s.settlement_end ? String(s.settlement_end).split('T')[0] : new Date().toISOString().slice(0, 10)
    const { data: snapBefore } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .lte('snapshot_date', settlementEndDate)
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const snapDate = snapBefore && snapBefore[0]?.snapshot_date
    let unsellableItems: any[] = []
    if (snapDate) {
      const { data: fbaSnap } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('sku, traction_code, product_name, afn_unsellable_quantity, your_price')
        .eq('snapshot_date', snapDate)
        .gt('afn_unsellable_quantity', 0)
      // Charger les actions déjà prises sur ces SKU pour ce settlement
      const { data: actions } = await supabaseAdmin
        .from('amazon_unsellable_actions')
        .select('sku, action_type, amazon_ref, notes, action_le, action_par, traite_le, traite_par')
        .eq('settlement_id', s.settlement_id)
      const actionsMap = new Map<string, any>()
      for (const a of actions || []) actionsMap.set(a.sku, a)

      // Charger les removal orders Amazon (auto-removals déjà déclenchés).
      // Pour chaque SKU unsellable, on cherche un removal récent (≤90j avant
      // settlement_end) pour pré-remplir l'action automatiquement.
      const skuList = (fbaSnap || []).map((f: any) => f.sku).filter(Boolean)
      const removalsBySku = new Map<string, any[]>()
      if (skuList.length > 0) {
        const { data: removals } = await supabaseAdmin
          .from('amazon_removal_orders')
          .select('order_id, sku, order_status, order_type, disposition, requested_quantity, shipped_quantity, cancelled_quantity, removal_fee, last_updated_date')
          .in('sku', skuList)
          .order('last_updated_date', { ascending: false })
        for (const r of removals || []) {
          const list = removalsBySku.get(r.sku) || []
          list.push(r)
          removalsBySku.set(r.sku, list)
        }
      }

      unsellableItems = (fbaSnap || [])
        .map((f: any) => {
          const removals = removalsBySku.get(f.sku) || []
          const hasCompleted = removals.some((r: any) => r.order_status === 'Completed')
          const latestRemoval = removals[0] || null
          return {
            sku: f.sku, traction_code: f.traction_code,
            product_name: f.product_name,
            qty: Number(f.afn_unsellable_quantity || 0),
            unit_price: Number(f.your_price || 0),
            valeur: Number(f.afn_unsellable_quantity || 0) * Number(f.your_price || 0),
            action: actionsMap.get(f.sku) || null,
            removal_orders: removals,
            has_removal_completed: hasCompleted,
            latest_removal_order_id: latestRemoval?.order_id || null,
          }
        })
        // Filtrer les items déjà "sortis de la liste" (traite_le défini)
        .filter((u: any) => !u.action?.traite_le)
    }
    const step3_done = !!s.step3_unsellable_handled_at
    const step3: StepStatus = {
      key: '3_unsellable',
      label: 'Unsellable / réclamations',
      status: step2_done && step1_done ? (step3_done ? 'done' : 'action') : 'locked',
      detail: unsellableItems.length === 0
        ? 'Aucun unsellable détecté'
        : `${unsellableItems.length} SKU unsellable — total ${unsellableItems.reduce((a, u) => a + u.valeur, 0).toFixed(2)} $`,
      items: unsellableItems,
      validated_at: s.step3_unsellable_handled_at,
      validated_by: s.step3_unsellable_handled_by,
    }

    // ── Étape 4 : Ajustements Traction ────────────────────────────────
    // Manuelle : l'employé confirme avoir passé toutes les corrections
    const step4_done = !!s.step4_ajustements_fait_at
    const step4: StepStatus = {
      key: '4_ajustements',
      label: 'Ajustements passés dans Traction',
      status: step3_done ? (step4_done ? 'done' : 'action') : 'locked',
      detail: step4_done
        ? `Confirmé le ${String(s.step4_ajustements_fait_at).split('T')[0]} par ${s.step4_ajustements_fait_by}`
        : "Ouvrir Traction, appliquer les ajustements listés (voir Rapport) puis valider",
      validated_at: s.step4_ajustements_fait_at,
      validated_by: s.step4_ajustements_fait_by,
    }

    // ── Étape 5 : Audit physique 100% + balance ───────────────────────
    const { data: audits } = await supabaseAdmin
      .from('amazon_audits')
      .select('*')
      .eq('settlement_id', s.settlement_id)
      .limit(1)
    const audit = audits && audits[0]
    let step5_done = false
    let step5_detail = 'Audit non créé pour ce settlement'
    const balanceIssues: any[] = []
    let nb_counted = 0, nb_total = 0
    if (audit) {
      const { data: counts } = await supabaseAdmin
        .from('amazon_audit_counts')
        .select('*')
        .eq('audit_id', audit.id)
      const rows = counts || []
      nb_total = rows.length
      nb_counted = rows.filter((c: any) => c.hub_compte != null || c.sans_prefix_compte != null || c.fbm_compte != null).length

      // Calcul de la balance par base product :
      //   Traction_total = hub + fbm + sans_prefix + fba_traction
      //   Physique_total = warehouse_compte + fbm_compte + fba_amazon
      //   ABS(Traction - Physique) doit être ≤ 1
      for (const c of rows) {
        const hub = Number(c.hub_theorique || 0)
        const fbm = Number(c.fbm_theorique || 0)
        const sp = Number(c.sans_prefix_theorique || 0)
        const fbaT = Number(c.fba_traction_theorique || 0)
        const traction_total = hub + fbm + sp + fbaT

        const whseCompte = c.hub_compte != null || c.sans_prefix_compte != null
          ? Number(c.hub_compte || 0) + Number(c.sans_prefix_compte || 0)
          : null
        const fbmCompte = c.fbm_compte != null ? Number(c.fbm_compte) : null
        const fbaAmz = Number(c.fba_amazon_theorique || 0)

        if (whseCompte == null && fbmCompte == null) continue // pas encore compté
        const physique_total = (whseCompte || 0) + (fbmCompte || 0) + fbaAmz
        const ecart = traction_total - physique_total
        if (Math.abs(ecart) > TOLERANCE) {
          balanceIssues.push({
            base_code: c.base_code,
            description: c.description,
            traction_total,
            physique_total,
            ecart,
            breakdown: { hub, fbm, sp, fba_traction: fbaT, whse_compte: whseCompte, fbm_compte: fbmCompte, fba_amazon: fbaAmz },
          })
        }
      }
      balanceIssues.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart))

      const audit_finalise = audit.statut === 'termine'
      const tout_compte = nb_total > 0 && nb_counted === nb_total
      const balanced = balanceIssues.length === 0
      step5_done = audit_finalise && tout_compte && balanced
      step5_detail = audit_finalise && balanced
        ? `✓ Audit finalisé, 100% compté, balance OK`
        : !audit_finalise
          ? `Audit "${audit.label}" : ${nb_counted}/${nb_total} comptés. Finalise l'audit après comptage.`
          : !tout_compte
            ? `${nb_counted}/${nb_total} comptés — reste ${nb_total - nb_counted} à compter`
            : `${balanceIssues.length} produit${balanceIssues.length>1?'s':''} avec écart > 1 unité (bloquant)`
    }
    const step5: StepStatus = {
      key: '5_audit',
      label: 'Audit physique + balance inventaire',
      status: step4_done ? (step5_done ? 'done' : 'action') : 'locked',
      detail: step5_detail,
      items: balanceIssues,
      blocking_count: balanceIssues.length,
    }

    // ── Étape 6 : Rapport final validé ─────────────────────────────────
    const step6_done = !!s.step6_rapport_valide_at
    const step6: StepStatus = {
      key: '6_rapport',
      label: 'Rapport comptabilité validé',
      status: step5_done ? (step6_done ? 'done' : 'action') : 'locked',
      detail: step6_done
        ? `Validé le ${String(s.step6_rapport_valide_at).split('T')[0]} par ${s.step6_rapport_valide_by}`
        : "Ouvrir le rapport, vérifier les totaux, puis valider",
      validated_at: s.step6_rapport_valide_at,
      validated_by: s.step6_rapport_valide_by,
    }

    const allDone = step1_done && step2_done && step3_done && step4_done && step5_done && step6_done
    const isClosed = !!s.closed_at

    return NextResponse.json({
      settlement: {
        settlement_id: s.settlement_id,
        settlement_start: s.settlement_start,
        settlement_end: s.settlement_end,
        deposit_date: s.deposit_date,
        total_amount: Number(s.total_amount || 0),
        lautopak_invoice_ref: s.lautopak_invoice_ref,
        lautopak_invoice_date: s.lautopak_invoice_date,
        lautopak_reimb_invoice_ref: s.lautopak_reimb_invoice_ref,
        lautopak_reimb_invoice_date: s.lautopak_reimb_invoice_date,
        closed_at: s.closed_at,
        closed_by: s.closed_by,
        audit_id: audit?.id || null,
        audit_nb_counted: nb_counted,
        audit_nb_total: nb_total,
      },
      steps: [step1, step2, step3, step4, step5, step6],
      fichiers_importes,
      customer_returns_count: customerReturnsCount,
      can_close: allDone && !isClosed,
      is_closed: isClosed,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE /api/amazon/closure?id=XXX — supprime un settlement complet.
// Casse:
//   - amazon_transactions (lignes payments)        → DELETE
//   - amazon_audits (+ audit_counts via cascade)    → DELETE
//   - amazon_reimbursements                         → UPDATE settlement_id=null
//     (on garde l'import CSV, on le dé-lie simplement — il pourra se re-matcher
//      à une future ré-import du settlement)
//   - amazon_settlements                            → DELETE
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

    const { error: e1 } = await supabaseAdmin.from('amazon_transactions').delete().eq('settlement_id', id)
    if (e1) throw e1
    const { error: e2 } = await supabaseAdmin.from('amazon_audits').delete().eq('settlement_id', id)
    if (e2) throw e2
    const { error: e3 } = await supabaseAdmin.from('amazon_reimbursements').update({ settlement_id: null }).eq('settlement_id', id)
    if (e3) throw e3
    const { error: e4 } = await supabaseAdmin.from('amazon_settlements').delete().eq('settlement_id', id)
    if (e4) throw e4
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { settlement_id, step, action, employe } = body
    if (!settlement_id) return NextResponse.json({ erreur: 'settlement_id requis' }, { status: 400 })

    const now = new Date().toISOString()
    const clearDate = action === 'unvalidate' ? null : now
    const clearBy = action === 'unvalidate' ? null : (employe || 'Inconnu')
    const update: any = {}

    if (step === 3) {
      update.step3_unsellable_handled_at = clearDate
      update.step3_unsellable_handled_by = clearBy
    } else if (step === 4) {
      update.step4_ajustements_fait_at = clearDate
      update.step4_ajustements_fait_by = clearBy
    } else if (step === 6) {
      update.step6_rapport_valide_at = clearDate
      update.step6_rapport_valide_by = clearBy
    } else if (step === 'close') {
      update.closed_at = now
      update.closed_by = employe || 'Inconnu'
    } else if (step === 'reopen') {
      update.closed_at = null
      update.closed_by = null
    } else {
      return NextResponse.json({ erreur: 'step invalide (3, 4, 6, close, reopen)' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('amazon_settlements')
      .update(update)
      .eq('settlement_id', settlement_id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
