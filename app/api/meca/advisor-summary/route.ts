import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'
import { computeRythme } from '@/lib/meca-rythme'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/meca/advisor-summary?id=622
//
// Version « un seul aviseur » de /api/meca/summary : même structure financière
// (Mois à Date, par catégorie) + KPI, plus la liste détaillée de ses bons de
// travail ouverts — c'est ce qui permet de cibler le bon précis qui traîne, et
// pas seulement de savoir qu'il y en a un quelque part.

const SEUIL_SIGNALEMENT = 2
const SEUIL_EN_RETARD_JOURS = 30

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
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: "Paramètre 'id' requis." }, { status: 400 })

    const { data: advisor, error: advErr } = await supabaseAdmin
      .from('meca_advisors').select('id, nom, departement, actif').eq('id', id).maybeSingle()
    if (advErr) throw advErr
    if (!advisor) return NextResponse.json({ erreur: `Aucun aviseur avec l'id ${id}.` }, { status: 404 })

    const now = Date.now()
    const valeurDe = (m: any) => Object.values((m ?? {}) as Record<string, number>).reduce((s, v) => s + (v || 0), 0)

    // ── Bons de travail ouverts, en détail (les plus vieux en premier)
    const workOrders = await chargerTout<any>(
      'meca_work_orders',
      q => q.select('facture_no, client_nom, statut, no_serie, no_stock, date_ouverture, montants, imports_vus_ouvert, suivi_statut, suivi_date_planifiee, suivi_note, suivi_par, suivi_maj_at')
            .eq('is_open', true).eq('advisor_id', id),
      'date_ouverture'
    )

    // Historique du suivi pour ces bons.
    const histParFacture = new Map<string, any[]>()
    const facturesIds = workOrders.map(w => w.facture_no)
    if (facturesIds.length) {
      const hist = await chargerTout<any>('suivi_historique',
        q => q.select('facture_no, statut, note, par, cree_le').eq('domaine', 'meca').in('facture_no', facturesIds), 'cree_le')
      for (const h of hist) {
        const l = histParFacture.get(h.facture_no) ?? []
        l.push({ statut: h.statut, note: h.note, par: h.par, creeLe: h.cree_le })
        histParFacture.set(h.facture_no, l)
      }
      // chargerTout trie ascendant : on inverse pour afficher le plus récent d'abord.
      for (const l of histParFacture.values()) l.reverse()
    }

    const workOrdersWithAge = workOrders.map(w => ({
      facture_no:   w.facture_no,
      client_nom:   w.client_nom,
      statut:       w.statut,
      no_serie:     w.no_serie,
      no_stock:     w.no_stock,
      date_ouverture: w.date_ouverture,
      ageJours: Math.floor((now - new Date(w.date_ouverture).getTime()) / 86400000),
      valeur: valeurDe(w.montants),
      signale: (w.imports_vus_ouvert ?? 0) >= SEUIL_SIGNALEMENT,
      suiviStatut:        w.suivi_statut ?? null,
      suiviDatePlanifiee: w.suivi_date_planifiee ?? null,
      suiviNote:          w.suivi_note ?? null,
      suiviPar:           w.suivi_par ?? null,
      suiviMajAt:         w.suivi_maj_at ?? null,
      suiviHistorique:    histParFacture.get(w.facture_no) ?? [],
    }))

    const ageMoyenJours = workOrdersWithAge.length > 0
      ? Math.round(workOrdersWithAge.reduce((s, w) => s + w.ageJours, 0) / workOrdersWithAge.length)
      : 0
    const bonsOuvertsPlus30j = workOrdersWithAge.filter(w => w.ageJours > SEUIL_EN_RETARD_JOURS).length
    const bonsSignales = workOrdersWithAge.filter(w => w.signale).length
    const valeurEnAttente = workOrdersWithAge.reduce((s, w) => s + w.valeur, 0)

    // ── Performance financière Mois à Date de cet aviseur
    // chargerTout trie en ascendant : la dernière vue par label est la plus récente.
    const perf = await chargerTout<any>(
      'meca_advisor_performance',
      q => q.select('row_label, valeurs, created_at')
            .eq('advisor_id', id).eq('periode_type', 'mtd')
            .in('row_label', FINANCIAL_ROWS.map(r => r.key)),
      'created_at'
    )
    const latestByLabel = new Map<string, any>()
    for (const p of perf) latestByLabel.set(p.row_label, p)

    const categoriesSeen = new Set<string>()
    for (const p of latestByLabel.values()) {
      for (const cat of Object.keys((p.valeurs ?? {}) as Record<string, number>)) categoriesSeen.add(cat)
    }
    const categories = Array.from(categoriesSeen).sort((a, b) => {
      const idxA = CATEGORY_ORDER.indexOf(a.split('|')[0])
      const idxB = CATEGORY_ORDER.indexOf(b.split('|')[0])
      if (idxA !== idxB) return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
      return a.localeCompare(b)
    })

    const financierRows = FINANCIAL_ROWS.map(r => {
      const vals = (latestByLabel.get(r.key)?.valeurs ?? {}) as Record<string, number>
      const perCategorie: Record<string, number | null> = {}
      for (const cat of categories) perCategorie[cat] = cat in vals ? vals[cat] : null
      return { key: r.key, titre: r.titre, isPercent: r.isPercent, valeurs: perCategorie }
    })

    const revenuGenere = Object.values(financierRows.find(r => r.key === 'ventes')?.valeurs ?? {})
      .reduce<number>((s, v) => s + (v || 0), 0)
    const profitValues = Object.values(financierRows.find(r => r.key === 'profit_pct')?.valeurs ?? {})
      .filter((v): v is number => v !== null)
    const profitPctMoyen = profitValues.length > 0
      ? profitValues.reduce((s, v) => s + v, 0) / profitValues.length : null

    const rythme = await computeRythme(supabaseAdmin, [id], 30)

    // ── Comparaison avec les collègues actifs du même département (lui exclu).
    // Pensé pour situer, pas pour sanctionner.
    let comparaisonEquipe: any = null
    if (advisor.departement) {
      const { data: collegues } = await supabaseAdmin
        .from('meca_advisors').select('id')
        .eq('departement', advisor.departement).eq('actif', true).neq('id', id)
      const collegueIds = (collegues ?? []).map(c => c.id)

      if (collegueIds.length > 0) {
        const perfCollegues = await chargerTout<any>(
          'meca_advisor_performance',
          q => q.select('advisor_id, row_label, valeurs, created_at')
                .in('advisor_id', collegueIds).eq('periode_type', 'mtd')
                .in('row_label', ['ventes', 'profit_pct']),
          'created_at'
        )
        const latestParCollegue = new Map<string, any>()
        for (const p of perfCollegues) latestParCollegue.set(`${p.advisor_id}|${p.row_label}`, p)

        const ventesParCollegue = new Map<string, number>()
        const profitPctParCollegue = new Map<string, number>()
        for (const p of latestParCollegue.values()) {
          const vals = Object.values((p.valeurs ?? {}) as Record<string, number>)
          if (p.row_label === 'ventes') {
            ventesParCollegue.set(p.advisor_id, vals.reduce((s, v) => s + (v || 0), 0))
          } else if (p.row_label === 'profit_pct' && vals.length > 0) {
            profitPctParCollegue.set(p.advisor_id, vals.reduce((s, v) => s + (v || 0), 0) / vals.length)
          }
        }

        const woCollegues = await chargerTout<any>(
          'meca_work_orders',
          q => q.select('advisor_id, date_ouverture').eq('is_open', true).in('advisor_id', collegueIds),
          'facture_no'
        )
        const ageParCollegue = new Map<string, number[]>()
        for (const w of woCollegues) {
          const age = Math.floor((now - new Date(w.date_ouverture).getTime()) / 86400000)
          const liste = ageParCollegue.get(w.advisor_id) ?? []
          liste.push(age)
          ageParCollegue.set(w.advisor_id, liste)
        }

        const revenusValues = collegueIds.map(cid => ventesParCollegue.get(cid) ?? 0)
        const profitValuesEquipe = collegueIds.map(cid => profitPctParCollegue.get(cid))
          .filter((v): v is number => v !== undefined)
        const agesMoyensParCollegue = collegueIds.map(cid => {
          const liste = ageParCollegue.get(cid) ?? []
          return liste.length > 0 ? liste.reduce((s, v) => s + v, 0) / liste.length : 0
        })

        const rythmeEquipe = await computeRythme(supabaseAdmin, collegueIds, 30)

        comparaisonEquipe = {
          nbCollegues: collegueIds.length,
          revenuMoyenEquipe: Math.round((revenusValues.reduce((s, v) => s + v, 0) / collegueIds.length) * 100) / 100,
          profitPctMoyenEquipe: profitValuesEquipe.length > 0
            ? Math.round((profitValuesEquipe.reduce((s, v) => s + v, 0) / profitValuesEquipe.length) * 100) / 100
            : null,
          ageMoyenEquipe: Math.round((agesMoyensParCollegue.reduce((s, v) => s + v, 0) / collegueIds.length) * 10) / 10,
          // computeRythme renvoie le total de l'équipe : on ramène par aviseur
          // pour comparer à un individu.
          ouverturesParJourMoyenEquipe: Math.round((rythmeEquipe.ouverturesParJour / collegueIds.length) * 100) / 100,
          fermeturesParJourMoyenEquipe: Math.round((rythmeEquipe.fermeturesParJour / collegueIds.length) * 100) / 100,
        }
      }
    }

    return NextResponse.json({
      advisor,
      kpi: {
        revenuGenere: Math.round(revenuGenere * 100) / 100,
        profitPctMoyen: profitPctMoyen !== null ? Math.round(profitPctMoyen * 100) / 100 : null,
        bonsOuverts: workOrdersWithAge.length,
        ageMoyenJours,
        bonsOuvertsPlus30j,
        bonsSignales,
        valeurEnAttente: Math.round(valeurEnAttente * 100) / 100,
      },
      financier: { categories, rows: financierRows },
      workOrders: workOrdersWithAge,
      rythme,
      comparaisonEquipe,
    })
  } catch (e: any) {
    console.error('[meca/advisor-summary] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
