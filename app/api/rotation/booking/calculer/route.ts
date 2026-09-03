// Calcule une proposition de booking. Ne l'enregistre pas : l'ecran la montre,
// on la discute, et on ne garde que ce qu'on decide de garder.
//
// POST { programme_id, objectif, budget_max?, couverture_mois?, palier_vise?,
//        date_commande?, exclure_jamais_vendues? }

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun, lireTout, chargerConfig } from '@/lib/supply-chain-db'
import { calculerBooking, PieceBooking, ProgrammeBooking, PalierBooking, BonusBooking } from '@/lib/booking'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Les seules colonnes dont le moteur a besoin. Sur 33 000 pieces, tout
// remonter coute plusieurs secondes pour rien.
const COLONNES = [
  'code_piece', 'description', 'fournisseur', 'code_ligne', 'marque',
  'categorie_nom', 'categorie_chemin', 'cout_unitaire', 'prix_vente',
  'stock_dispo', 'qte_transit', 'qte_commande', 'stock_securite',
  'demande_mens', 'demande_deseason', 'indice_12m', 'rotation', 'ventes_12m_cogs',
  'classe_abc', 'statut', 'discontinue', 'popularite',
].join(', ')

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const programmeId = body.programme_id
    if (!programmeId) return NextResponse.json({ erreur: 'programme_id requis' }, { status: 400 })

    const run = await dernierRun()
    if (!run) {
      return NextResponse.json({
        erreur: 'Aucune analyse calculee. Lance un recalcul depuis l\'onglet avant de booker.',
      }, { status: 409 })
    }

    const [{ data: programme }, paliers, bonus, cfg] = await Promise.all([
      supabaseAdmin.from('sc_booking_programmes').select('*').eq('id', programmeId).single(),
      lireTout<PalierBooking>('sc_booking_paliers', '*', q =>
        q.eq('programme_id', programmeId).order('bareme').order('rang')),
      lireTout<BonusBooking>('sc_booking_bonus', '*', q => q.eq('programme_id', programmeId)),
      chargerConfig(),
    ])
    if (!programme) return NextResponse.json({ erreur: 'Programme introuvable' }, { status: 404 })

    const prog = programme as ProgrammeBooking

    // On ne descend que les pieces du ou des fournisseurs du programme.
    const fournisseurs = [prog.fournisseur, ...(prog.fournisseurs_alt || [])]
    const pieces = await lireTout<PieceBooking>('sc_analyse_pieces', COLONNES, q =>
      q.eq('run_id', run.run_id).in('fournisseur', fournisseurs))

    if (!pieces.length) {
      return NextResponse.json({
        erreur: `Aucune piece trouvee pour « ${prog.fournisseur} » dans la derniere analyse. ` +
                `Le nom du fournisseur du programme doit correspondre exactement a celui du feed Traction.`,
      }, { status: 409 })
    }

    // La courbe saisonniere n'est peuplee que depuis le recalcul du 3 septembre.
    // Sur un run plus ancien le moteur retomberait sur une saison plate sans
    // le dire — mieux vaut l'annoncer.
    const sansCourbe = pieces.filter(p => !Array.isArray(p.indice_12m) || p.indice_12m.length !== 12).length
    const alerteCourbe = sansCourbe > pieces.length * 0.5
      ? [`La derniere analyse date d'avant l'ajout de la courbe saisonniere : ${sansCourbe} pieces sur ` +
         `${pieces.length} n'en ont pas. Le besoin est calcule en moyenne plate. Relance « Recalculer » ` +
         `pour un chiffre saisonnier.`]
      : []

    const dateCommande = body.date_commande
      ? new Date(body.date_commande + 'T12:00:00')
      : new Date()

    const resultat = calculerBooking({
      programme: prog,
      paliers,
      bonus,
      pieces,
      config: {
        taux_possession: Number(cfg.taux_possession) || 0.25,
        cout_capital_annuel: Number((cfg as any).cout_capital_annuel) || 0.08,
        termes_standard_jours: Number((cfg as any).termes_standard_jours) || 30,
      },
      dateCommande,
      objectif: body.objectif || 'optimal',
      budgetMax: body.budget_max ?? null,
      couvertureMois: body.couverture_mois ?? 6,
      palierVise: body.palier_vise ?? null,
      exclureJamaisVendues: body.exclure_jamais_vendues !== false,
    })

    resultat.avertissements = [...alerteCourbe, ...resultat.avertissements]

    return NextResponse.json({
      success: true,
      run_id: run.run_id,
      programme: prog,
      proposition: resultat,
      nb_pieces_examinees: pieces.length,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
