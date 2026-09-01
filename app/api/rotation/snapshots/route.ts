// Consultation des snapshots mensuels archivés.
//
//   (sans param)                → liste des snapshots + série de valeurs
//   ?mois=YYYY-MM               → agrégats fournisseur / code de ligne du mois
//   ?mois=…&fournisseur=…       → détail imprimable de l'inventaire du fournisseur
//   ?mois=…&ligne=…             → idem par code de ligne
//   ?serie=fournisseur:NOM      → évolution mensuelle d'un fournisseur (roulement)

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { lireTout } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams
    const mois = p.get('mois')
    const fournisseur = p.get('fournisseur')
    const ligne = p.get('ligne')
    const serie = p.get('serie')

    // ── Série d'un groupe : la courbe de roulement ─────────────────────
    if (serie) {
      const [dimension, ...reste] = serie.split(':')
      const cle = reste.join(':')
      if (!['fournisseur', 'ligne'].includes(dimension) || !cle) {
        return NextResponse.json({ erreur: 'serie attendu au format "fournisseur:NOM" ou "ligne:CODE"' }, { status: 400 })
      }
      const { data, error } = await supabaseAdmin
        .from('sc_snapshot_agregats')
        .select('mois, nb_pieces, qte_totale, valeur_totale')
        .eq('dimension', dimension).eq('cle', cle)
        .order('mois', { ascending: true })
      if (error) throw new Error(error.message)
      return NextResponse.json({ dimension, cle, serie: data || [] })
    }

    // ── Détail imprimable ──────────────────────────────────────────────
    if (mois && (fournisseur || ligne)) {
      const { data: entete } = await supabaseAdmin
        .from('sc_snapshots').select('*').eq('mois', mois).maybeSingle()
      if (!entete) return NextResponse.json({ erreur: `Aucun snapshot pour ${mois}` }, { status: 404 })

      const lignes = await lireTout<any>('sc_snapshot_lignes', '*', q => {
        let r = q.eq('mois', mois)
        if (fournisseur) r = r.eq('fournisseur', fournisseur)
        if (ligne) r = r.eq('code_ligne', ligne)
        return r.order('code_piece', { ascending: true })
      })

      return NextResponse.json({
        entete, cible: fournisseur || ligne,
        dimension: fournisseur ? 'fournisseur' : 'ligne',
        lignes,
        totaux: {
          nb_pieces: lignes.length,
          qte: lignes.reduce((s, l) => s + Number(l.qty || 0), 0),
          valeur: lignes.reduce((s, l) => s + Number(l.valeur || 0), 0),
        },
      })
    }

    // ── Agrégats d'un mois ─────────────────────────────────────────────
    if (mois) {
      const { data: entete } = await supabaseAdmin
        .from('sc_snapshots').select('*').eq('mois', mois).maybeSingle()
      if (!entete) return NextResponse.json({ erreur: `Aucun snapshot pour ${mois}` }, { status: 404 })

      const agregats = await lireTout<any>('sc_snapshot_agregats', '*', q =>
        q.eq('mois', mois).order('valeur_totale', { ascending: false }))
      return NextResponse.json({
        entete,
        fournisseurs: agregats.filter(a => a.dimension === 'fournisseur'),
        lignes: agregats.filter(a => a.dimension === 'ligne'),
      })
    }

    // ── Liste ──────────────────────────────────────────────────────────
    const { data, error } = await supabaseAdmin
      .from('sc_snapshots').select('*').order('mois', { ascending: true })
    if (error) throw new Error(error.message)

    const snaps = data || []
    // Variation d'un mois à l'autre : la lecture la plus directe du roulement
    // au niveau de l'entrepôt entier.
    const serieGlobale = snaps.map((s, i) => ({
      mois: s.mois,
      valeur: Number(s.valeur_totale),
      nb_pieces: s.nb_pieces,
      variation_pct: i > 0 && Number(snaps[i - 1].valeur_totale) > 0
        ? ((Number(s.valeur_totale) - Number(snaps[i - 1].valeur_totale)) / Number(snaps[i - 1].valeur_totale)) * 100
        : null,
    }))

    return NextResponse.json({ snapshots: snaps, serie: serieGlobale })

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
