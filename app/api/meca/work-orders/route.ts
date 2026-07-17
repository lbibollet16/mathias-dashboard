import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'
import { estStatutValide } from '@/lib/meca-suivi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET   ?dept=powersport|marine|tous&advisorId=NN&filtre=tous|retard|rush&q=texte
//       — bons de travail ouverts, avec âge calculé, flag « signalé » (stagnation)
//         et information de rush de fin de mois.
// PATCH { factureNo, advisorId }
//       — réassigne un bon à un autre aviseur. Marque advisor_assigned_manually
//         pour que les imports suivants ne réécrasent pas ce choix.

const SEUIL_EN_RETARD_JOURS = 30
const SEUIL_SIGNALEMENT = 2
// Jours avant la fin du mois à partir desquels on bascule en mode « rush »
// (vider la file avant la bascule comptable). Ajustable selon l'atelier.
const FENETRE_RUSH_JOURS = 5
// En rush, on élargit volontairement à tout bon ouvert depuis ce nombre de
// jours : le but est de vider la file, pas de cibler les pires cas.
const AGE_MIN_RUSH_JOURS = 3

function joursRestantsDansLeMois(date: Date): number {
  const dernierJour = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
  const diffMs = dernierJour.getTime() - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return Math.round(diffMs / 86400000)
}

export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams
    const dept = sp.get('dept')                    // 'powersport' | 'marine' | 'tous' | null
    const advisorId = sp.get('advisorId')
    const filtre = sp.get('filtre') ?? 'tous'      // 'tous' | 'retard' | 'rush'
    const q = (sp.get('q') ?? '').trim().toLowerCase()

    const { data: advisors, error: advErr } = await supabaseAdmin
      .from('meca_advisors').select('id, nom, departement, actif')
    if (advErr) throw advErr
    const advisorById = new Map((advisors ?? []).map(a => [a.id, a]))

    const raw = await chargerTout<any>(
      'meca_work_orders',
      qb => qb.select('*').eq('is_open', true),
      'facture_no'
    )

    const now = new Date()
    const joursRestants = joursRestantsDansLeMois(now)
    const modeRush = joursRestants <= FENETRE_RUSH_JOURS

    let workOrders = raw.map(w => {
      const ageJours = Math.floor((now.getTime() - new Date(w.date_ouverture).getTime()) / 86400000)
      const advisor = advisorById.get(w.advisor_id)
      const valeur = Object.values((w.montants ?? {}) as Record<string, number>).reduce((s, v) => s + (v || 0), 0)
      return {
        factureNo:     w.facture_no,
        advisorId:     w.advisor_id,
        advisorNom:    advisor?.nom ?? `Aviseur #${w.advisor_id}`,
        departement:   advisor?.departement ?? null,
        clientNo:      w.client_no,
        clientNom:     w.client_nom ?? '',
        statut:        w.statut,
        noSerie:       w.no_serie,
        noStock:       w.no_stock,
        dateOuverture: w.date_ouverture,
        ageJours,
        enRetard:      ageJours > SEUIL_EN_RETARD_JOURS,
        signale:       (w.imports_vus_ouvert ?? 0) >= SEUIL_SIGNALEMENT,
        assigneManuel: w.advisor_assigned_manually ?? false,
        valeur,
        montants:      w.montants ?? {},
        // Suivi renseigné par l'aviseur.
        suiviStatut:        w.suivi_statut ?? null,
        suiviDatePlanifiee: w.suivi_date_planifiee ?? null,
        suiviNote:          w.suivi_note ?? null,
        suiviPar:           w.suivi_par ?? null,
        suiviMajAt:         w.suivi_maj_at ?? null,
      }
    })

    if (dept && dept !== 'tous') workOrders = workOrders.filter(w => w.departement === dept)
    if (advisorId)               workOrders = workOrders.filter(w => w.advisorId === advisorId)
    if (filtre === 'retard')     workOrders = workOrders.filter(w => w.enRetard)
    else if (filtre === 'rush')  workOrders = workOrders.filter(w => w.ageJours >= AGE_MIN_RUSH_JOURS)
    if (q) {
      workOrders = workOrders.filter(w =>
        (w.factureNo || '').toLowerCase().includes(q) ||
        (w.clientNom || '').toLowerCase().includes(q) ||
        (w.advisorNom || '').toLowerCase().includes(q)
      )
    }

    // Les plus vieux d'abord, puis les plus gros montants.
    workOrders.sort((a, b) => b.ageJours - a.ageJours || b.valeur - a.valeur)

    return NextResponse.json({
      workOrders,
      kpi: {
        total:        workOrders.length,
        enRetard:     workOrders.filter(w => w.enRetard).length,
        signales:     workOrders.filter(w => w.signale).length,
        valeurTotale: Math.round(workOrders.reduce((s, w) => s + w.valeur, 0) * 100) / 100,
      },
      modeRush,
      joursRestantsDansLeMois: joursRestants,
      advisorsActifs: (advisors ?? []).filter(a => a.actif),
    })
  } catch (e: any) {
    console.error('[meca/work-orders] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}

// PATCH gère deux actions distinctes sur un bon (par facture_no) :
//   - réassignation d'aviseur : { factureNo, advisorId }
//   - suivi de l'aviseur       : { factureNo, suivi: { statut, datePlanifiee, note }, par }
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const factureNo = body?.factureNo
    if (!factureNo) return NextResponse.json({ erreur: "Champ 'factureNo' requis." }, { status: 400 })

    // ── Mise à jour du suivi
    if (body.suivi !== undefined) {
      const s = body.suivi ?? {}
      if (s.statut != null && s.statut !== '' && !estStatutValide(s.statut)) {
        return NextResponse.json({ erreur: `Statut de suivi inconnu : ${s.statut}` }, { status: 400 })
      }
      const datePlan = s.datePlanifiee && /^\d{4}-\d{2}-\d{2}$/.test(s.datePlanifiee) ? s.datePlanifiee : null
      const par = typeof body.par === 'string' && body.par.trim() ? body.par.trim() : null

      const { data, error } = await supabaseAdmin
        .from('meca_work_orders')
        .update({
          suivi_statut:         s.statut || null,
          suivi_date_planifiee: datePlan,
          suivi_note:           (typeof s.note === 'string' && s.note.trim()) ? s.note.trim() : null,
          suivi_par:            par,
          suivi_maj_at:         new Date().toISOString(),
        })
        .eq('facture_no', factureNo)
        .select()
        .single()
      if (error) throw error
      return NextResponse.json({ success: true, workOrder: data })
    }

    // ── Réassignation d'aviseur
    const advisorId = body?.advisorId
    if (!advisorId) return NextResponse.json({ erreur: "Champ 'advisorId' ou 'suivi' requis." }, { status: 400 })

    const { data: advisor } = await supabaseAdmin
      .from('meca_advisors').select('id').eq('id', advisorId).maybeSingle()
    if (!advisor) return NextResponse.json({ erreur: `Aucun aviseur avec l'id ${advisorId}.` }, { status: 400 })

    const { data, error } = await supabaseAdmin
      .from('meca_work_orders')
      .update({ advisor_id: advisorId, advisor_assigned_manually: true, updated_at: new Date().toISOString() })
      .eq('facture_no', factureNo)
      .select()
      .single()
    if (error) throw error

    return NextResponse.json({ success: true, workOrder: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
