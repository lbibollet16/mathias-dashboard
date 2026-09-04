// Calcule une proposition de booking. Ne l'enregistre pas : l'ecran la montre,
// on la discute, et on ne garde que ce qu'on decide de garder.
//
// POST { programme_id, objectif, budget_max?, couverture_mois?, palier_vise?,
//        date_commande?, exclure_jamais_vendues? }
//
// MODE PREVISION — sans programme_id :
// POST { fournisseur, couvre_debut, couvre_fin }
// Repond a « de quoi vais-je avoir besoin chez ce fournisseur entre ces deux
// dates », sans grille commerciale. Meme calcul de besoin — saisonnalite,
// stock en route, references interchangeables, exclusion des commandes
// speciales — mais aucun escompte a arbitrer : le montant est le besoin nu.

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
    const prevision = !programmeId

    if (prevision && !body.fournisseur) {
      return NextResponse.json({
        erreur: 'Precise un programme_id, ou bien un fournisseur et une periode pour une prevision.',
      }, { status: 400 })
    }

    const run = await dernierRun()
    if (!run) {
      return NextResponse.json({
        erreur: 'Aucune analyse calculee. Lance un recalcul depuis l\'onglet avant de booker.',
      }, { status: 409 })
    }

    const [{ data: programme }, paliers, bonus, cfg] = await Promise.all([
      prevision
        ? Promise.resolve({ data: null })
        : supabaseAdmin.from('sc_booking_programmes').select('*').eq('id', programmeId).single(),
      prevision ? Promise.resolve([]) : lireTout<PalierBooking>('sc_booking_paliers', '*', q =>
        q.eq('programme_id', programmeId).order('bareme').order('rang')),
      prevision ? Promise.resolve([]) : lireTout<BonusBooking>('sc_booking_bonus', '*', q =>
        q.eq('programme_id', programmeId)),
      chargerConfig(),
    ])
    if (!prevision && !programme) {
      return NextResponse.json({ erreur: 'Programme introuvable' }, { status: 404 })
    }

    // En prevision, on fabrique un programme sans grille : le moteur calcule
    // alors le besoin nu, sans escompte ni palier a arbitrer. C'est la reponse
    // a « de quoi vais-je avoir besoin », par opposition a « ce programme
    // vaut-il le coup ».
    const prog: ProgrammeBooking = prevision
      ? {
          id: 0,
          nom: `Prevision de besoin — ${body.fournisseur}`,
          fournisseur: String(body.fournisseur),
          fournisseurs_alt: [],
          saison: null,
          ouvre_le: null, ferme_le: null,
          // La livraison est immediate : on ne prevoit pas une commande
          // future, on regarde ce qui manque pour tenir la periode demandee.
          livraison_debut: body.couvre_debut || null,
          livraison_fin: null,
          couvre_debut: body.couvre_debut || null,
          couvre_fin: body.couvre_fin || null,
          perimetre_lignes: body.perimetre_lignes || [],
          perimetre_marques: body.perimetre_marques || [],
          perimetre_categories: body.perimetre_categories || [],
          perimetre_codes: [], exclus_codes: [],
          // Une prevision ne connait pas de regle d'exclusion : elle regarde
          // tout ce que le fournisseur peut fournir.
          exclus_marques: [], exclus_categories: [], exclus_mots: [],
          min_commande: null, min_reappro: null, franco_seuil: null,
          transport_pct: null, retour_pct: null,
          baremes_exclusifs: false,
          notes: null, source_fichier: null, actif: true,
        }
      : (programme as ProgrammeBooking)

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

    // ── Les references interchangeables ───────────────────────────
    // Une piece dont l'equivalent dort sur la tablette n'a pas besoin d'etre
    // bookee. L'equivalent peut appartenir a un AUTRE fournisseur — on va
    // donc chercher son stock separement, hors du perimetre du programme.
    const codes = new Set(pieces.map(p => p.code_piece))
    const { data: altRows } = await supabaseAdmin
      .from('pieces_alternatives').select('code_principal, code_alternatif')

    const alternatives = new Map<string, string[]>()
    const codesAlt = new Set<string>()
    for (const r of altRows || []) {
      // L'equivalence joue dans les deux sens : si B remplace A, A remplace B.
      const paires: [string, string][] = [
        [r.code_principal, r.code_alternatif],
        [r.code_alternatif, r.code_principal],
      ]
      for (const [de, vers] of paires) {
        if (!codes.has(de)) continue
        alternatives.set(de, [...(alternatives.get(de) || []), vers])
        if (!codes.has(vers)) codesAlt.add(vers)
      }
    }

    // Le stock des pieces du programme, plus celui des alternatives externes.
    const stockParCode = new Map<string, number>()
    for (const p of pieces) {
      stockParCode.set(p.code_piece, p.stock_dispo + p.qte_transit + p.qte_commande)
    }
    if (codesAlt.size > 0) {
      const liste = [...codesAlt]
      for (let i = 0; i < liste.length; i += 300) {
        const { data } = await supabaseAdmin
          .from('sc_analyse_pieces')
          .select('code_piece, stock_dispo, qte_transit, qte_commande')
          .eq('run_id', run.run_id).in('code_piece', liste.slice(i, i + 300))
        for (const r of data || []) {
          stockParCode.set(r.code_piece,
            Number(r.stock_dispo || 0) + Number(r.qte_transit || 0) + Number(r.qte_commande || 0))
        }
      }
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
      // Sans grille, il n'y a rien a etirer : on reste au strict besoin.
      objectif: prevision ? 'couverture' : (body.objectif || 'optimal'),
      budgetMax: body.budget_max ?? null,
      couvertureMois: body.couverture_mois ?? 6,
      palierVise: body.palier_vise ?? null,
      exclureJamaisVendues: body.exclure_jamais_vendues !== false,
      alternatives,
      stockParCode,
    })

    resultat.avertissements = [...alerteCourbe, ...resultat.avertissements]

    return NextResponse.json({
      success: true,
      mode: prevision ? 'prevision' : 'programme',
      run_id: run.run_id,
      programme: prog,
      proposition: resultat,
      nb_pieces_examinees: pieces.length,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
