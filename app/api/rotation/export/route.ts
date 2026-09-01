// Export CSV — pour Excel, la comptabilité, ou l'envoi à un fournisseur.
//
//   ?type=fournisseurs                  agrégats par fournisseur
//   ?type=lignes                        agrégats par code de ligne
//   ?type=pieces[&fournisseur=…]        détail par pièce (filtres identiques à /pieces)
//   ?type=snapshot&mois=…[&fournisseur=…]  archive mensuelle
//   ?type=receptions                    alertes de réception
//   ?type=findings[&agent=…]            constats des agents

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun, lireTout } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * CSV pour Excel FR : séparateur point-virgule, décimale virgule, BOM UTF-8
 * (sans le BOM, Excel Windows affiche les accents en mojibake).
 */
function versCSV(colonnes: { cle: string; titre: string }[], rows: any[]): string {
  const esc = (v: any): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')
    }
    if (typeof v === 'object') v = JSON.stringify(v)
    const s = String(v)
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lignes = [colonnes.map(c => esc(c.titre)).join(';')]
  for (const r of rows) lignes.push(colonnes.map(c => esc(r[c.cle])).join(';'))
  return '﻿' + lignes.join('\r\n')
}

function reponseCSV(nom: string, csv: string) {
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nom}"`,
      'Cache-Control': 'no-store',
    },
  })
}

const COLS_GROUPE = [
  { cle: 'cle', titre: 'Fournisseur / Ligne' },
  { cle: 'nb_pieces', titre: 'Nb pièces suivies' },
  { cle: 'nb_pieces_stock', titre: 'Nb pièces en stock' },
  { cle: 'qte_totale', titre: 'Quantité totale' },
  { cle: 'valeur_stock', titre: 'Valeur stock ($)' },
  { cle: 'part_valeur', titre: '% de la valeur' },
  { cle: 'part_cumulee', titre: '% cumulé (Pareto)' },
  { cle: 'classe_pareto', titre: 'Classe' },
  { cle: 'ventes_12m_ca', titre: 'CA 12 mois ($)' },
  { cle: 'ventes_12m_cogs', titre: 'Coût des ventes 12 mois ($)' },
  { cle: 'marge_pct', titre: 'Marge (%)' },
  { cle: 'stock_moyen', titre: 'Stock moyen ($)' },
  { cle: 'nb_snapshots', titre: 'Nb snapshots' },
  { cle: 'rotation', titre: 'Rotation (fois/an)' },
  { cle: 'dsi_jours', titre: 'Jours de stock' },
  { cle: 'nb_rupture', titre: 'Ruptures' },
  { cle: 'nb_sous_stock', titre: 'Sous stock' },
  { cle: 'nb_surstock', titre: 'Surstock' },
  { cle: 'nb_mort', titre: 'Sans mouvement' },
  { cle: 'nb_dormant', titre: 'Dormantes' },
  { cle: 'valeur_exces', titre: 'Valeur excédent ($)' },
  { cle: 'valeur_morte', titre: 'Valeur morte ($)' },
  { cle: 'valeur_dormante', titre: 'Valeur dormante ($)' },
  { cle: 'valeur_retournable', titre: 'Retournable ($)' },
  { cle: 'nb_negatifs', titre: 'Négatifs' },
  { cle: 'nb_alertes_recep', titre: 'Alertes réception' },
  { cle: 'variation_pct', titre: 'Variation vs mois préc. (%)' },
  { cle: 'score_sante', titre: 'Score santé /100' },
]

const COLS_PIECE = [
  { cle: 'code_piece', titre: 'Code' },
  { cle: 'description', titre: 'Description' },
  { cle: 'fournisseur', titre: 'Fournisseur' },
  { cle: 'code_ligne', titre: 'Code de ligne' },
  { cle: 'stock', titre: 'Stock' },
  { cle: 'stock_dispo', titre: 'Stock disponible' },
  { cle: 'qte_reserve', titre: 'Réservé' },
  { cle: 'qte_transit', titre: 'En transit' },
  { cle: 'qte_commande', titre: 'En commande' },
  { cle: 'cout_unitaire', titre: 'Coût unitaire ($)' },
  { cle: 'valeur_stock', titre: 'Valeur stock ($)' },
  { cle: 'ventes_12m_qte', titre: 'Ventes 12 mois (u)' },
  { cle: 'ventes_12m_ca', titre: 'CA 12 mois ($)' },
  { cle: 'ventes_12m_cogs', titre: 'Coût des ventes 12 mois ($)' },
  { cle: 'demande_mens', titre: 'Demande (u/mois)' },
  { cle: 'derniere_vente', titre: 'Dernière vente' },
  { cle: 'mois_sans_vente', titre: 'Mois sans vente' },
  { cle: 'classe_abc', titre: 'ABC' },
  { cle: 'classe_xyz', titre: 'XYZ' },
  { cle: 'statut', titre: 'Statut' },
  { cle: 'rotation', titre: 'Rotation (fois/an)' },
  { cle: 'couverture_mois', titre: 'Couverture (mois)' },
  { cle: 'stock_securite', titre: 'Stock de sécurité' },
  { cle: 'point_commande', titre: 'Point de commande' },
  { cle: 'eoq', titre: 'Quantité éco. (Wilson)' },
  { cle: 'qte_a_commander', titre: 'À commander' },
  { cle: 'qte_min', titre: 'Min Traction' },
  { cle: 'qte_max', titre: 'Max Traction' },
  { cle: 'exces_unites', titre: 'Excédent (u)' },
  { cle: 'exces_valeur', titre: 'Excédent ($)' },
  { cle: 'valeur_morte', titre: 'Valeur morte ($)' },
  { cle: 'valeur_dormante', titre: 'Valeur dormante ($)' },
]

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams
    const type = p.get('type') || 'fournisseurs'
    const fournisseur = p.get('fournisseur')
    const ligne = p.get('ligne')
    const jour = new Date().toISOString().split('T')[0]
    const slug = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)

    if (type === 'snapshot') {
      const mois = p.get('mois')
      if (!mois) return NextResponse.json({ erreur: 'mois requis' }, { status: 400 })
      const rows = await lireTout<any>('sc_snapshot_lignes', '*', q => {
        let r = q.eq('mois', mois)
        if (fournisseur) r = r.eq('fournisseur', fournisseur)
        if (ligne) r = r.eq('code_ligne', ligne)
        return r.order('fournisseur', { ascending: true }).order('code_piece', { ascending: true })
      })
      const cols = [
        { cle: 'code_piece', titre: 'Code' },
        { cle: 'description', titre: 'Description' },
        { cle: 'fournisseur', titre: 'Fournisseur' },
        { cle: 'code_ligne', titre: 'Code de ligne' },
        { cle: 'localisation', titre: 'Localisation' },
        { cle: 'qty', titre: 'Quantité' },
        { cle: 'qty_dispo', titre: 'Disponible' },
        { cle: 'qte_reserve', titre: 'Réservé' },
        { cle: 'qte_transit', titre: 'En transit' },
        { cle: 'qte_commande', titre: 'En commande' },
        { cle: 'cout_unitaire', titre: 'Coût unitaire ($)' },
        { cle: 'valeur', titre: 'Valeur ($)' },
      ]
      const nom = `inventaire_${mois}${fournisseur ? '_' + slug(fournisseur) : ''}${ligne ? '_' + slug(ligne) : ''}.csv`
      return reponseCSV(nom, versCSV(cols, rows))
    }

    if (type === 'receptions') {
      const jours = Math.min(730, Math.max(7, parseInt(p.get('jours') || '180', 10)))
      const depuis = new Date(Date.now() - jours * 86_400_000).toISOString().split('T')[0]
      const rows = await lireTout<any>('sc_receptions', '*', q => {
        let r = q.gte('date_reception', depuis)
        if (p.get('toutes') !== '1') r = r.eq('alerte', true)
        if (fournisseur) r = r.eq('fournisseur', fournisseur)
        return r.order('date_reception', { ascending: false })
      })
      const cols = [
        { cle: 'date_reception', titre: 'Date' },
        { cle: 'code_piece', titre: 'Code' },
        { cle: 'description', titre: 'Description' },
        { cle: 'fournisseur', titre: 'Fournisseur' },
        { cle: 'code_ligne', titre: 'Code de ligne' },
        { cle: 'qte_recue', titre: 'Quantité reçue' },
        { cle: 'cout_unitaire', titre: 'Coût unitaire ($)' },
        { cle: 'valeur', titre: 'Valeur ($)' },
        { cle: 'stock_avant', titre: 'Stock avant' },
        { cle: 'stock_apres', titre: 'Stock après' },
        { cle: 'demande_mens', titre: 'Demande (u/mois)' },
        { cle: 'couverture_apres', titre: 'Couverture après (mois)' },
        { cle: 'eoq', titre: 'Quantité éco. (Wilson)' },
        { cle: 'severite', titre: 'Sévérité' },
        { cle: 'motifs', titre: 'Déclencheurs' },
        { cle: 'exces_unites', titre: 'Excédent (u)' },
        { cle: 'exces_valeur', titre: 'Excédent ($)' },
        { cle: 'statut', titre: 'Statut' },
        { cle: 'commentaire', titre: 'Commentaire' },
      ]
      return reponseCSV(`receptions_${jour}.csv`, versCSV(cols, rows))
    }

    // Les autres exports viennent du dernier run d'analyse.
    const run = await dernierRun()
    if (!run) return NextResponse.json({ erreur: 'Aucune analyse calculée' }, { status: 409 })

    if (type === 'findings') {
      const agent = p.get('agent')
      const rows = await lireTout<any>('sc_findings', '*', q => {
        let r = q.eq('run_id', run.run_id)
        if (agent) r = r.in('agent', agent.split(','))
        return r.order('rang', { ascending: true })
      })
      const cols = [
        { cle: 'agent', titre: 'Agent' },
        { cle: 'severite', titre: 'Sévérité' },
        { cle: 'titre', titre: 'Constat' },
        { cle: 'detail', titre: 'Détail' },
        { cle: 'action', titre: 'Action recommandée' },
        { cle: 'impact_dollars', titre: 'Impact ($)' },
        { cle: 'code_piece', titre: 'Code' },
        { cle: 'fournisseur', titre: 'Fournisseur' },
        { cle: 'code_ligne', titre: 'Code de ligne' },
      ]
      return reponseCSV(`constats_${jour}.csv`, versCSV(cols, rows))
    }

    if (type === 'pieces') {
      const rows = await lireTout<any>('sc_analyse_pieces', '*', q => {
        let r = q.eq('run_id', run.run_id)
        if (fournisseur) r = r.eq('fournisseur', fournisseur)
        if (ligne) r = r.eq('code_ligne', ligne)
        const statut = p.get('statut')
        if (statut) r = r.in('statut', statut.split(','))
        return r.order('valeur_stock', { ascending: false })
      })
      const nom = `pieces_${fournisseur ? slug(fournisseur) + '_' : ''}${ligne ? slug(ligne) + '_' : ''}${jour}.csv`
      return reponseCSV(nom, versCSV(COLS_PIECE, rows))
    }

    const dimension = type === 'lignes' ? 'ligne' : 'fournisseur'
    const rows = await lireTout<any>('sc_analyse_groupes', '*', q =>
      q.eq('run_id', run.run_id).eq('dimension', dimension).order('valeur_stock', { ascending: false }))
    return reponseCSV(`${type}_${jour}.csv`, versCSV(COLS_GROUPE, rows))

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
