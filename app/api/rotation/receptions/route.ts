// Journal des réceptions détectées par le sync ERP + traitement des alertes.
//
// GET   : liste filtrable (alertes seules par défaut)
// PATCH : marquer une réception justifiée / à retourner / ignorée

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const STATUTS = ['nouveau', 'vu', 'justifie', 'a_retourner', 'ignore']

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams
    const alertesSeules = p.get('toutes') !== '1'
    const statut = p.get('statut')
    const fournisseur = p.get('fournisseur')
    const codePiece = p.get('code_piece')
    const jours = Math.min(730, Math.max(7, parseInt(p.get('jours') || '180', 10)))
    const limite = Math.min(1000, Math.max(10, parseInt(p.get('limite') || '300', 10)))

    const depuis = new Date(Date.now() - jours * 86_400_000).toISOString().split('T')[0]

    let q = supabaseAdmin.from('sc_receptions').select('*', { count: 'exact' })
      .gte('date_reception', depuis)
    if (alertesSeules) q = q.eq('alerte', true)
    if (statut) q = q.in('statut', statut.split(','))
    if (fournisseur) q = q.eq('fournisseur', fournisseur)
    if (codePiece) q = q.eq('code_piece', codePiece)

    const { data, error, count } = await q
      .order('date_reception', { ascending: false })
      .order('exces_valeur', { ascending: false })
      .limit(limite)
    if (error) throw new Error(error.message)

    const rows = data || []
    return NextResponse.json({
      receptions: rows,
      total: count || 0,
      totaux: {
        nb_alertes: rows.filter(r => r.alerte).length,
        nb_nouvelles: rows.filter(r => r.alerte && r.statut === 'nouveau').length,
        exces_valeur: rows.filter(r => r.alerte).reduce((s, r) => s + (Number(r.exces_valeur) || 0), 0),
        valeur_recue: rows.reduce((s, r) => s + (Number(r.valeur) || 0), 0),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, statut, commentaire, user_email } = body
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    if (statut && !STATUTS.includes(statut)) {
      return NextResponse.json({ erreur: `statut invalide (${STATUTS.join(', ')})` }, { status: 400 })
    }

    const patch: any = { vu_le: new Date().toISOString(), vu_par: user_email || null }
    if (statut) patch.statut = statut
    if (commentaire !== undefined) patch.commentaire = commentaire

    const { data, error } = await supabaseAdmin
      .from('sc_receptions').update(patch).eq('id', id).select().single()
    if (error) throw new Error(error.message)

    return NextResponse.json({ success: true, reception: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
