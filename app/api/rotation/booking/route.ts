// Les programmes de booking et les propositions enregistrees.
//
// GET                     programmes (avec paliers et bonus) + bookings sauvegardes
// GET ?booking=<id>       une proposition et ses lignes
// POST                    enregistre une proposition calculee
// PATCH                   change le statut d'une proposition, ou coche/decoche une ligne
// DELETE ?id=<id>         supprime une proposition

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { lireTout, dernierRun } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const idBooking = req.nextUrl.searchParams.get('booking')

    if (idBooking) {
      const [{ data: booking }, lignes] = await Promise.all([
        supabaseAdmin.from('sc_bookings').select('*').eq('id', idBooking).single(),
        lireTout<any>('sc_booking_lignes', '*', q =>
          q.eq('booking_id', idBooking).order('rang', { ascending: true })),
      ])
      if (!booking) return NextResponse.json({ erreur: 'Proposition introuvable' }, { status: 404 })
      return NextResponse.json({ booking, lignes })
    }

    // La liste des fournisseurs de l'ERP accompagne la reponse : c'est elle
    // qui alimente le rapprochement d'un programme importe. La deduire des
    // programmes deja saisis serait circulaire — au premier import, elle
    // serait vide.
    const run = await dernierRun()
    const groupesFournisseurs = run
      ? await lireTout<any>('sc_analyse_groupes', 'cle, valeur_stock, nb_pieces', q =>
          q.eq('run_id', run.run_id).eq('dimension', 'fournisseur')
           .order('valeur_stock', { ascending: false }))
      : []

    const [programmes, paliers, bonus, bookings] = await Promise.all([
      lireTout<any>('sc_booking_programmes', '*', q => q.order('ferme_le', { ascending: false })),
      lireTout<any>('sc_booking_paliers', '*', q =>
        q.order('programme_id').order('bareme').order('rang')),
      lireTout<any>('sc_booking_bonus', '*', q => q.order('programme_id')),
      lireTout<any>('sc_bookings', '*', q => q.order('cree_le', { ascending: false })),
    ])

    // Chaque programme repart avec sa grille : l'ecran n'a plus a recoller.
    const parProg = (rows: any[]) => {
      const m = new Map<number, any[]>()
      for (const r of rows) m.set(r.programme_id, [...(m.get(r.programme_id) || []), r])
      return m
    }
    const mp = parProg(paliers)
    const mb = parProg(bonus)

    const aujourdhui = new Date().toISOString().slice(0, 10)
    const enrichis = programmes.map(p => {
      const ouvert = (!p.ouvre_le || p.ouvre_le <= aujourdhui) &&
                     (!p.ferme_le || p.ferme_le >= aujourdhui)
      // Combien de jours avant que le prochain avantage tombe ? C'est
      // l'information qui fait agir : un escompte hatif qui expire dans
      // douze jours ne se rattrape pas.
      const bs = mb.get(p.id) || []
      const echeances = bs
        .filter((b: any) => b.avant_le && b.avant_le >= aujourdhui)
        .sort((a: any, b: any) => a.avant_le.localeCompare(b.avant_le))
      const prochaine = echeances[0] || null
      return {
        ...p,
        paliers: mp.get(p.id) || [],
        bonus: bs,
        ouvert,
        jours_restants: p.ferme_le
          ? Math.ceil((new Date(p.ferme_le + 'T12:00:00').getTime() - Date.now()) / 86_400_000)
          : null,
        prochaine_echeance: prochaine
          ? {
              libelle: prochaine.libelle,
              valeur_pct: prochaine.valeur_pct,
              date: prochaine.avant_le,
              jours: Math.ceil((new Date(prochaine.avant_le + 'T23:59:59').getTime() - Date.now()) / 86_400_000),
            }
          : null,
      }
    })

    return NextResponse.json({
      programmes: enrichis,
      bookings,
      fournisseurs: groupesFournisseurs.map(g => g.cle),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { proposition, programme_id, run_id, nom, objectif, budget_max,
            couverture_mois, palier_vise, date_commande, user_email } = body

    if (!proposition?.lignes?.length) {
      return NextResponse.json({ erreur: 'Aucune ligne a enregistrer' }, { status: 400 })
    }

    const { data: booking, error } = await supabaseAdmin.from('sc_bookings').insert({
      programme_id: programme_id ?? null,
      run_id: run_id ?? null,
      nom: nom || 'Booking sans nom',
      objectif: objectif || 'optimal',
      budget_max: budget_max ?? null,
      couverture_mois: couverture_mois ?? null,
      palier_vise: palier_vise ?? null,
      date_commande: date_commande || new Date().toISOString().slice(0, 10),
      montant_brut: proposition.montant_brut,
      escompte_pct: proposition.escompte_pct,
      escompte_dollars: proposition.escompte_dollars,
      montant_net: proposition.montant_net,
      dating_jours: proposition.dating_jours,
      dating_dollars: proposition.dating_dollars,
      portage_dollars: proposition.portage_dollars,
      gain_net_dollars: proposition.gain_net_dollars,
      nb_lignes: proposition.nb_lignes,
      resume: {
        baremes: proposition.baremes,
        avertissements: proposition.avertissements,
        detail_bonus: proposition.detail_bonus,
        dating_choisi: proposition.dating_choisi,
        transport_dollars: proposition.transport_dollars,
        couvre_debut: proposition.couvre_debut,
        couvre_fin: proposition.couvre_fin,
        livraison: proposition.livraison,
      },
      cree_par: user_email || null,
    }).select().single()
    if (error) throw new Error(error.message)

    const lignes = proposition.lignes.map((l: any, i: number) => ({
      booking_id: booking.id,
      rang: i,
      code_piece: l.code_piece,
      description: l.description,
      fournisseur: l.fournisseur,
      code_ligne: l.code_ligne,
      marque: l.marque,
      categorie_nom: l.categorie_nom,
      cout_unitaire: l.cout_unitaire,
      qte: l.qte,
      montant: l.montant,
      bareme: l.bareme,
      motif: l.motif,
      qte_besoin: l.qte_besoin,
      qte_etirement: l.qte_etirement,
      stock: l.stock,
      en_route: l.en_route,
      demande_periode: l.demande_periode,
      couverture_apres: l.couverture_apres,
      classe_abc: l.classe_abc,
      statut_piece: l.statut_piece,
      rotation: l.rotation,
      portage_dollars: l.portage_dollars,
    }))

    for (let i = 0; i < lignes.length; i += 500) {
      const { error: e2 } = await supabaseAdmin.from('sc_booking_lignes').insert(lignes.slice(i, i + 500))
      if (e2) throw new Error(e2.message)
    }

    return NextResponse.json({ success: true, booking })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, statut, ligne_id, retenu, qte } = await req.json()

    if (ligne_id != null) {
      const patch: any = {}
      if (retenu !== undefined) patch.retenu = retenu
      if (qte !== undefined) patch.qte = qte
      const { data, error } = await supabaseAdmin
        .from('sc_booking_lignes').update(patch).eq('id', ligne_id).select().single()
      if (error) throw new Error(error.message)
      return NextResponse.json({ success: true, ligne: data })
    }

    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { data, error } = await supabaseAdmin.from('sc_bookings')
      .update({ statut, maj_le: new Date().toISOString() }).eq('id', id).select().single()
    if (error) throw new Error(error.message)
    return NextResponse.json({ success: true, booking: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('sc_bookings').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
