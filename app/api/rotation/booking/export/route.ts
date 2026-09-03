// Export CSV d'une proposition de booking, pour la recopier dans le formulaire
// du fournisseur ou la relire dans Excel.
//
//   ?booking=<id>          la proposition enregistree
//   ?booking=<id>&brut=1   toutes les lignes, y compris celles decochees

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { lireTout } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'

/** CSV pour Excel FR : point-virgule, decimale virgule, BOM UTF-8. */
function versCSV(colonnes: { cle: string; titre: string }[], rows: any[]): string {
  const esc = (v: any): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') {
      return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')
    }
    const s = String(v)
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lignes = [colonnes.map(c => esc(c.titre)).join(';')]
  for (const r of rows) lignes.push(colonnes.map(c => esc(r[c.cle])).join(';'))
  return '﻿' + lignes.join('\r\n')
}

const MOTIFS: Record<string, string> = {
  besoin: 'Besoin de la periode',
  rupture: 'Rupture',
  palier: 'Ajoutee pour atteindre un palier',
  minimum: 'Ajoutee pour atteindre le minimum de commande',
}

export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('booking')
    if (!id) return NextResponse.json({ erreur: 'booking requis' }, { status: 400 })
    const brut = req.nextUrl.searchParams.get('brut') === '1'

    const { data: booking } = await supabaseAdmin
      .from('sc_bookings').select('*').eq('id', id).single()
    if (!booking) return NextResponse.json({ erreur: 'Proposition introuvable' }, { status: 404 })

    let lignes = await lireTout<any>('sc_booking_lignes', '*', q =>
      q.eq('booking_id', id).order('rang', { ascending: true }))
    if (!brut) lignes = lignes.filter(l => l.retenu)

    const rows = lignes.map(l => ({
      ...l,
      motif_libelle: MOTIFS[l.motif] || l.motif,
      // La part etiree est ce qu'il faut pouvoir couper en negociation : on la
      // sort en clair plutot que de la noyer dans la quantite.
      qte_etirement: Number(l.qte_etirement) || 0,
    }))

    const csv = versCSV([
      { cle: 'code_piece', titre: 'Code piece' },
      { cle: 'description', titre: 'Description' },
      { cle: 'qte', titre: 'Quantite' },
      { cle: 'cout_unitaire', titre: 'Cout unitaire' },
      { cle: 'montant', titre: 'Montant' },
      { cle: 'bareme', titre: 'Bareme' },
      { cle: 'motif_libelle', titre: 'Pourquoi' },
      { cle: 'qte_besoin', titre: 'Dont besoin' },
      { cle: 'qte_etirement', titre: 'Dont etirement' },
      { cle: 'stock', titre: 'Stock actuel' },
      { cle: 'en_route', titre: 'Deja en route' },
      { cle: 'demande_periode', titre: 'Demande sur la periode' },
      { cle: 'couverture_apres', titre: 'Couverture apres (mois)' },
      { cle: 'rotation', titre: 'Rotation' },
      { cle: 'classe_abc', titre: 'ABC' },
      { cle: 'statut_piece', titre: 'Statut' },
      { cle: 'portage_dollars', titre: 'Cout de portage' },
      { cle: 'marque', titre: 'Marque' },
      { cle: 'categorie_nom', titre: 'Categorie' },
      { cle: 'code_ligne', titre: 'Code de ligne' },
    ], rows)

    const nom = `booking_${String(booking.nom).replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}_${booking.date_commande}.csv`
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${nom}"`,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
