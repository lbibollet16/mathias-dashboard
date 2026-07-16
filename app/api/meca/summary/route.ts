import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'
import { computeRythme } from '@/lib/meca-rythme'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/meca/summary?dept=powersport|marine
//
// KPI agrégés du département + détail financier "Mois à Date" ventilé par
// catégorie (Client|Pièce, Garantie|Main d'oeuvre, …), agrégé sur les aviseurs
// actifs du département. La structure des colonnes vient du rapport source.

const SEUIL_SIGNALEMENT = 2
const SEUIL_EN_RETARD_JOURS = 30

const AGE_BUCKETS = [
  { label: '0-7j',   min: 0,  max: 7 },
  { label: '8-14j',  min: 8,  max: 14 },
  { label: '15-30j', min: 15, max: 30 },
  { label: '31-60j', min: 31, max: 60 },
  { label: '60j+',   min: 61, max: Infinity },
]

// Lignes financières exposées, dans l'ordre d'affichage.
// Les clés correspondent au row_label produit par le parser du rapport aviseur.
const FINANCIAL_ROWS: { key: string, titre: string, isPercent: boolean }[] = [
  { key: 'ventes',              titre: 'Ventes',              isPercent: false },
  { key: 'couts',               titre: 'Coûts',               isPercent: false },
  { key: 'profits',             titre: 'Profits',             isPercent: false },
  { key: 'profit_pct',          titre: 'Profit %',            isPercent: true  },
  { key: 'moy_dollar_factures', titre: 'Moy $ / Factures',    isPercent: false },
  { key: 'nb_heures_facturees', titre: 'Nb heures facturées', isPercent: false },
  { key: 'taux_effectif',       titre: 'Taux effectif',       isPercent: true  },
]

const CATEGORY_ORDER = ['Client', 'Interne', 'Garantie', 'Gar.Prol.', 'Total', 'Autre']

export async function GET(req: NextRequest) {
  try {
    const dept = new URL(req.url).searchParams.get('dept')
    if (dept !== 'powersport' && dept !== 'marine') {
      return NextResponse.json({ erreur: "Paramètre 'dept' doit être 'powersport' ou 'marine'." }, { status: 400 })
    }

    const { data: advisors, error: advErr } = await supabaseAdmin
      .from('meca_advisors')
      .select('id, nom')
      .eq('departement', dept)
      .eq('actif', true)
    if (advErr) throw advErr

    const advisorIds = (advisors ?? []).map(a => a.id)
    if (advisorIds.length === 0) {
      return NextResponse.json({
        dept,
        advisors: [],
        bonsOuverts: 0,
        ageMoyenJours: 0,
        ageParTranche: AGE_BUCKETS.map(b => ({ label: b.label, count: 0 })),
        valeurEnAttente: 0,
        bonsOuvertsPlus30j: 0,
        bonsSignales: 0,
        financier: { categories: [], rows: [] },
        classementAviseurs: [],
        rythme: {
          periodeJours: 30, ouverturesParJour: 0, fermeturesParJour: 0, soldeNetParJour: 0,
          totalOuvertures: 0, totalFermetures: 0,
          fiabiliteFermeture: 'insuffisante', premierImportDepuisJours: null,
        },
      })
    }

    // ── Bons de travail ouverts du département
    const workOrders = await chargerTout<any>(
      'meca_work_orders',
      q => q.select('advisor_id, date_ouverture, montants, imports_vus_ouvert')
            .eq('is_open', true).in('advisor_id', advisorIds),
      'facture_no'
    )

    const now = Date.now()
    const ageDe = (d: string) => Math.floor((now - new Date(d).getTime()) / 86400000)
    const valeurDe = (m: any) => Object.values((m ?? {}) as Record<string, number>).reduce((s, v) => s + (v || 0), 0)

    const ages = workOrders.map(w => ageDe(w.date_ouverture))
    const ageMoyenJours = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0
    const ageParTranche = AGE_BUCKETS.map(b => ({
      label: b.label,
      count: ages.filter(a => a >= b.min && a <= b.max).length,
    }))
    const bonsOuvertsPlus30j = ages.filter(a => a > SEUIL_EN_RETARD_JOURS).length
    const bonsSignales = workOrders.filter(w => (w.imports_vus_ouvert ?? 0) >= SEUIL_SIGNALEMENT).length

    const signalesParAviseur = new Map<string, number>()
    for (const w of workOrders) {
      if ((w.imports_vus_ouvert ?? 0) >= SEUIL_SIGNALEMENT) {
        signalesParAviseur.set(w.advisor_id, (signalesParAviseur.get(w.advisor_id) ?? 0) + 1)
      }
    }
    const advisorsAvecSignalement = (advisors ?? []).map(a => ({
      ...a, bonsSignales: signalesParAviseur.get(a.id) ?? 0,
    }))
    const valeurEnAttente = workOrders.reduce((sum, w) => sum + valeurDe(w.montants), 0)

    // ── Performance financière "Mois à Date"
    const perf = await chargerTout<any>(
      'meca_advisor_performance',
      q => q.select('advisor_id, row_label, valeurs, created_at')
            .in('advisor_id', advisorIds)
            .eq('periode_type', 'mtd')
            .in('row_label', FINANCIAL_ROWS.map(r => r.key)),
      'created_at'
    )

    // Ne garder que la ligne la plus récente par (advisor_id, row_label) : sinon
    // deux imports différents se mélangeraient dans la même agrégation.
    // chargerTout trie en ascendant, donc la dernière vue gagne.
    const latestByKey = new Map<string, any>()
    for (const p of perf) latestByKey.set(`${p.advisor_id}|${p.row_label}`, p)

    // categoryTotals[row_label][categorie] = { sum, count }
    const categoryTotals: Record<string, Record<string, { sum: number, count: number }>> = {}
    const categoriesSeen = new Set<string>()
    for (const p of latestByKey.values()) {
      const vals = (p.valeurs ?? {}) as Record<string, number>
      if (!categoryTotals[p.row_label]) categoryTotals[p.row_label] = {}
      for (const [cat, val] of Object.entries(vals)) {
        categoriesSeen.add(cat)
        const bucket = categoryTotals[p.row_label][cat] ?? { sum: 0, count: 0 }
        bucket.sum += val || 0
        bucket.count += 1
        categoryTotals[p.row_label][cat] = bucket
      }
    }

    const categories = Array.from(categoriesSeen).sort((a, b) => {
      const idxA = CATEGORY_ORDER.indexOf(a.split('|')[0])
      const idxB = CATEGORY_ORDER.indexOf(b.split('|')[0])
      if (idxA !== idxB) return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
      return a.localeCompare(b)
    })

    const financierRows = FINANCIAL_ROWS.map(r => {
      const perCategorie: Record<string, number | null> = {}
      for (const cat of categories) {
        const bucket = categoryTotals[r.key]?.[cat]
        // Les % sont moyennés entre aviseurs, les $ et heures sommés.
        perCategorie[cat] = !bucket ? null
          : r.isPercent ? Math.round((bucket.sum / bucket.count) * 100) / 100
                        : Math.round(bucket.sum * 100) / 100
      }
      return { key: r.key, titre: r.titre, isPercent: r.isPercent, valeurs: perCategorie }
    })

    // ── Classement par aviseur (tableau interactif du directeur)
    const woParAviseur = new Map<string, { count: number, enRetard: number, signales: number, valeur: number }>()
    for (const w of workOrders) {
      const b = woParAviseur.get(w.advisor_id) ?? { count: 0, enRetard: 0, signales: 0, valeur: 0 }
      b.count += 1
      if (ageDe(w.date_ouverture) > SEUIL_EN_RETARD_JOURS) b.enRetard += 1
      if ((w.imports_vus_ouvert ?? 0) >= SEUIL_SIGNALEMENT) b.signales += 1
      b.valeur += valeurDe(w.montants)
      woParAviseur.set(w.advisor_id, b)
    }

    const perfParAviseur = new Map<string, { ventes: number, profitPctSum: number, profitPctCount: number }>()
    for (const p of latestByKey.values()) {
      const b = perfParAviseur.get(p.advisor_id) ?? { ventes: 0, profitPctSum: 0, profitPctCount: 0 }
      const vals = Object.values((p.valeurs ?? {}) as Record<string, number>)
      if (p.row_label === 'ventes') b.ventes += vals.reduce((s, v) => s + (v || 0), 0)
      if (p.row_label === 'profit_pct' && vals.length > 0) {
        b.profitPctSum += vals.reduce((s, v) => s + (v || 0), 0) / vals.length
        b.profitPctCount += 1
      }
      perfParAviseur.set(p.advisor_id, b)
    }

    const classementAviseurs = (advisors ?? []).map(a => {
      const wo = woParAviseur.get(a.id) ?? { count: 0, enRetard: 0, signales: 0, valeur: 0 }
      const pf = perfParAviseur.get(a.id) ?? { ventes: 0, profitPctSum: 0, profitPctCount: 0 }
      return {
        id: a.id,
        nom: a.nom,
        revenuGenere: Math.round(pf.ventes * 100) / 100,
        profitPct: pf.profitPctCount > 0 ? Math.round((pf.profitPctSum / pf.profitPctCount) * 100) / 100 : null,
        bonsOuverts: wo.count,
        bonsEnRetard: wo.enRetard,
        bonsSignales: wo.signales,
        valeurEnAttente: Math.round(wo.valeur * 100) / 100,
      }
    })

    const rythme = await computeRythme(supabaseAdmin, advisorIds, 30)

    return NextResponse.json({
      dept,
      advisors: advisorsAvecSignalement,
      bonsOuverts: workOrders.length,
      ageMoyenJours,
      ageParTranche,
      valeurEnAttente: Math.round(valeurEnAttente * 100) / 100,
      bonsOuvertsPlus30j,
      bonsSignales,
      financier: { categories, rows: financierRows },
      classementAviseurs,
      rythme,
    })
  } catch (e: any) {
    console.error('[meca/summary] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
