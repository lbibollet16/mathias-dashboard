import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant } from '@/lib/amazon-inventory'

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
    const step1_done = !!s.lautopak_invoice_ref && !!s.lautopak_invoice_date
    const step1: StepStatus = {
      key: '1_lautopak',
      label: 'Facturation LAUTOPAK',
      status: step1_done ? 'done' : 'action',
      detail: step1_done
        ? `Facture ${s.lautopak_invoice_ref} du ${String(s.lautopak_invoice_date).split('T')[0]}`
        : `Créer une facture LAUTOPAK de ${Number(s.total_amount || 0).toFixed(2)} $ et inscrire son n° ici`,
    }

    // ── Étape 2 : Reimbursements matchés ──────────────────────────────
    const { data: reimbs } = await supabaseAdmin
      .from('amazon_reimbursements')
      .select('id, reimbursement_id, sku, amount_total, reason, settlement_id')
      .eq('settlement_id', s.settlement_id)
    const reimbsCount = (reimbs || []).length
    // Croiser avec amazon_transactions qui ont amount_type='FBA Inventory Reimbursement'
    const { data: reimbTx } = await supabaseAdmin
      .from('amazon_transactions')
      .select('sku, amount, amount_type')
      .eq('settlement_id', s.settlement_id)
      .ilike('amount_type', '%Reimbursement%')
    const txCount = (reimbTx || []).length
    const step2_done = reimbsCount > 0 ? reimbsCount === txCount : txCount === 0
    const step2: StepStatus = {
      key: '2_reimbursements',
      label: 'Remboursements matchés',
      status: step1_done ? (step2_done ? 'done' : 'action') : 'locked',
      detail: reimbsCount === 0 && txCount === 0
        ? 'Aucun remboursement dans cette période (OK)'
        : `${reimbsCount} fichier CSV reimbursements ↔ ${txCount} lignes payments`,
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
      unsellableItems = (fbaSnap || []).map((f: any) => ({
        sku: f.sku, traction_code: f.traction_code,
        product_name: f.product_name,
        qty: Number(f.afn_unsellable_quantity || 0),
        unit_price: Number(f.your_price || 0),
        valeur: Number(f.afn_unsellable_quantity || 0) * Number(f.your_price || 0),
      }))
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
        closed_at: s.closed_at,
        closed_by: s.closed_by,
        audit_id: audit?.id || null,
        audit_nb_counted: nb_counted,
        audit_nb_total: nb_total,
      },
      steps: [step1, step2, step3, step4, step5, step6],
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
