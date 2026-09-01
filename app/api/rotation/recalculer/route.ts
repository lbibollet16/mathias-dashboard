// Recalcul complet de l'analyse supply chain.
//
// Déclenché : par le cron mensuel juste après le snapshot, par le sync ERP
// quotidien, ou à la main depuis l'onglet. Coûteux (feed Traction de 130 000
// lignes + 45 000 lignes de ventes) — d'où le stockage du résultat : l'écran
// lit un run pré-calculé et s'affiche instantanément.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { analyser, Finding } from '@/lib/supply-chain'
import {
  chargerConfig, chargerParamsFournisseurs, chargerTraction, chargerVentes,
  chargerSnapshots, chargerRetournables, chargerNegatifs, chargerAlertesRecep,
  ouvrirRun, ecrireResultats, lireTout,
} from '@/lib/supply-chain-db'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) { return POST(req) }

export async function POST(req: NextRequest) {
  const debut = Date.now()
  let runId: string | null = null

  try {
    const declencheur = new URL(req.url).searchParams.get('declencheur') || 'manuel'
    runId = await ouvrirRun(declencheur)

    const [cfg, paramsFournisseur, { ventes, moisDisponibles },
           { snapshots, moisSnapshots }, retournables, negatifs, alertesRecep] =
      await Promise.all([
        chargerConfig(), chargerParamsFournisseurs(), chargerVentes(),
        chargerSnapshots(), chargerRetournables(), chargerNegatifs(), chargerAlertesRecep(),
      ])

    // Les codes de ligne configurés (AMA…) sont écartés dès la lecture du feed :
    // rien en aval n'a plus à s'en soucier.
    const { pieces: traction, exclusion } = await chargerTraction(0, cfg.lignes_hors_perimetre)

    const res = analyser({
      traction, ventes, moisDisponibles, cfg, paramsFournisseur,
      snapshots, moisSnapshots, retournables, negatifs, alertesRecep, exclusion,
    })

    // ── Agent réception ────────────────────────────────────────────────
    // Les réceptions sont détectées en continu par le sync ERP (diff de stock
    // jour à jour) ; l'agent ne fait que remonter celles qui ont déclenché une
    // alerte et qui n'ont pas encore été traitées.
    const fRecep = await findingsReceptions()
    // Le montant d'excédent reçu vient des findings « réception » (agrégat de
    // tête), pas du moteur : les réceptions vivent en base, pas dans le feed.
    res.kpis.exces_receptions = fRecep
      .filter(f => !f.code_piece && !f.fournisseur)
      .reduce((s, f) => s + f.impact_dollars, 0)
    res.findings.push(...fRecep)
    res.findings.sort((a, b) => {
      const rang = { critique: 0, attention: 1, info: 2 } as const
      return rang[a.severite] - rang[b.severite] || b.impact_dollars - a.impact_dollars
    })

    await ecrireResultats({
      runId, pieces: res.pieces, groupes: res.groupes, findings: res.findings,
      kpis: res.kpis, log: res.log, debut,
    })

    return NextResponse.json({
      success: true, run_id: runId, duree_ms: Date.now() - debut,
      stats: { pieces: res.pieces.length, groupes: res.groupes.length, findings: res.findings.length },
      kpis: res.kpis, log: res.log,
    })

  } catch (e: any) {
    if (runId) {
      await supabaseAdmin.from('sc_runs').update({
        statut: 'erreur', termine_le: new Date().toISOString(),
        duree_ms: Date.now() - debut, erreur: e.message,
      }).eq('run_id', runId)
    }
    return NextResponse.json({ success: false, erreur: e.message }, { status: 500 })
  }
}

/**
 * Constats de l'agent « réception excessive ». On remonte les 6 derniers mois
 * d'alertes non traitées, plus une synthèse par fournisseur : une seule grosse
 * réception se discute avec l'acheteur, un fournisseur qui en accumule se
 * discute avec le fournisseur.
 */
async function findingsReceptions(): Promise<Finding[]> {
  const depuis = new Date(Date.now() - 180 * 86_400_000).toISOString().split('T')[0]
  const rows = await lireTout<any>('sc_receptions', '*',
    q => q.eq('alerte', true).in('statut', ['nouveau', 'vu']).gte('date_reception', depuis))
  if (rows.length === 0) return []

  const arg = (v: number) => Math.round(v).toLocaleString('fr-CA') + ' $'
  const nb = (v: number, d = 1) => Number(v).toLocaleString('fr-CA', { maximumFractionDigits: d })
  const LIBELLE: Record<string, string> = {
    couverture: 'couverture excessive',
    valeur: 'montant élevé',
    eoq: 'au-delà du lot économique',
    sans_vente: 'pièce sans vente',
  }

  const out: Finding[] = []
  const total = rows.reduce((s, r) => s + (Number(r.exces_valeur) || 0), 0)

  out.push({
    agent: 'reception', severite: total > 25000 ? 'critique' : 'attention',
    code_piece: null, fournisseur: null, code_ligne: null,
    titre: `${rows.length} réceptions signalées comme trop importantes (6 derniers mois)`,
    detail: `${arg(total)} d'excédent immobilisé par ces entrées en inventaire. `
      + `${rows.filter(r => r.severite === 'critique').length} sont critiques (au moins deux déclencheurs).`,
    action: `Passer la liste en revue dans l'onglet « Réceptions » : justifier, marquer à retourner, ou ignorer.`,
    impact_dollars: total,
    donnees: { nb: rows.length },
  })

  const parFourn = new Map<string, { n: number; val: number }>()
  for (const r of rows) {
    const f = r.fournisseur || 'Non assigné'
    const e = parFourn.get(f) || { n: 0, val: 0 }
    e.n++; e.val += Number(r.exces_valeur) || 0
    parFourn.set(f, e)
  }
  for (const [f, v] of [...parFourn.entries()].sort((a, b) => b[1].val - a[1].val).slice(0, 10)) {
    if (v.n < 2) continue
    out.push({
      agent: 'reception', severite: 'attention', code_piece: null, fournisseur: f, code_ligne: null,
      titre: `${f} : ${v.n} réceptions excessives pour ${arg(v.val)} d'excédent`,
      detail: `Ce n'est pas un accident isolé — le schéma se répète chez ce fournisseur.`,
      action: `Revoir la quantité minimale de commande imposée, ou le paramétrage min/max des pièces concernées.`,
      impact_dollars: v.val,
      donnees: { nb: v.n, valeur: v.val },
    })
  }

  for (const r of rows.sort((a, b) => (Number(b.exces_valeur) || 0) - (Number(a.exces_valeur) || 0)).slice(0, 40)) {
    const motifs = (Array.isArray(r.motifs) ? r.motifs : []).map((m: string) => LIBELLE[m] || m)
    out.push({
      agent: 'reception', severite: r.severite === 'critique' ? 'critique' : 'attention',
      code_piece: r.code_piece, fournisseur: r.fournisseur, code_ligne: r.code_ligne,
      titre: `${r.code_piece} : ${nb(r.qte_recue, 0)} u reçues le ${r.date_reception} (${arg(Number(r.valeur))})`,
      detail: `${r.description || 'sans description'} · déclencheurs : ${motifs.join(', ')}. `
        + `Stock ${nb(r.stock_avant, 0)} → ${nb(r.stock_apres, 0)} u pour une demande de `
        + `${nb(r.demande_mens, 1)} u/mois`
        + (r.couverture_apres != null ? ` → ${nb(r.couverture_apres, 0)} mois de couverture.` : ' (aucune vente sur 12 mois).')
        + (r.eoq > 0 ? ` Lot économique : ${nb(r.eoq, 0)} u.` : ''),
      action: `Vérifier le bon de commande. Retour fournisseur possible sur ${nb(r.exces_unites, 0)} u `
        + `(${arg(Number(r.exces_valeur))}).`,
      impact_dollars: Number(r.exces_valeur) || 0,
      donnees: { reception_id: r.id, motifs: r.motifs, date: r.date_reception },
    })
  }

  return out
}
