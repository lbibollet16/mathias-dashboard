import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/comptabilite/retours
//   ?demandeur=email   → retours actifs (non corrigés) pour ce demandeur
//   ?actifs=1          → tous les retours actifs (pour la vue Comptabilité)
//   sans param         → tous les retours (historique inclus)
export async function GET(req: NextRequest) {
  try {
    const demandeur = req.nextUrl.searchParams.get('demandeur')
    const actifs = req.nextUrl.searchParams.get('actifs')

    let query = supabaseAdmin
      .from('comptabilite_retours')
      .select('*')
      .order('retourne_le', { ascending: false })

    if (demandeur) {
      query = query.eq('demandeur_employe', demandeur).is('corrige_le', null)
    } else if (actifs === '1') {
      query = query.is('corrige_le', null)
    }

    const { data, error } = await query.limit(500)
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// POST /api/comptabilite/retours
// Body: { source: 'negatif'|'comptage', ref_id, code_piece, demandeur_employe,
//         comptable_email, commentaire_retour }
// Crée un retour. Retire automatiquement la validation comptable existante
// si elle existe (pour que l'item réapparaisse dans son onglet d'origine).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { source, ref_id, code_piece, demandeur_employe, comptable_email, commentaire_retour } = body
    if (!source || !ref_id || !demandeur_employe || !comptable_email || !commentaire_retour) {
      return NextResponse.json({ erreur: 'Champs requis : source, ref_id, demandeur_employe, comptable_email, commentaire_retour' }, { status: 400 })
    }
    if (!['negatif', 'comptage'].includes(source)) {
      return NextResponse.json({ erreur: 'source invalide' }, { status: 400 })
    }
    // Empêcher un doublon de retour actif pour le même item
    const { data: existing } = await supabaseAdmin
      .from('comptabilite_retours')
      .select('id')
      .eq('source', source)
      .eq('ref_id', ref_id)
      .is('corrige_le', null)
      .limit(1)
    if (existing && existing.length > 0) {
      return NextResponse.json({ erreur: 'Un retour actif existe déjà pour cet item' }, { status: 409 })
    }

    const { data, error } = await supabaseAdmin
      .from('comptabilite_retours')
      .insert({
        source, ref_id, code_piece: code_piece || null,
        demandeur_employe, comptable_email,
        commentaire_retour,
      })
      .select()
      .single()
    if (error) throw error

    // Retirer la validation comptable existante si présente (pour que l'item
    // réapparaisse dans son onglet d'origine après le retour).
    await supabaseAdmin
      .from('validations_comptables')
      .delete()
      .eq('source', source)
      .eq('ref_id', ref_id)

    return NextResponse.json({ success: true, retour: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// PATCH /api/comptabilite/retours
// Body: { id, action: 'vu' | 'corrige', user_email, commentaire_correction? }
// Marque un retour comme vu (badge rouge → vu) ou corrigé (sort de la liste active).
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, action, user_email, commentaire_correction } = body
    if (!id || !action || !user_email) {
      return NextResponse.json({ erreur: 'id + action + user_email requis' }, { status: 400 })
    }
    const update: any = {}
    if (action === 'vu') {
      update.vu_le = new Date().toISOString()
      update.vu_par = user_email
    } else if (action === 'corrige') {
      update.corrige_le = new Date().toISOString()
      update.corrige_par = user_email
      if (commentaire_correction) update.commentaire_correction = commentaire_correction
      // Marquer comme vu au passage si pas déjà fait
      if (!update.vu_le) {
        update.vu_le = new Date().toISOString()
        update.vu_par = user_email
      }
    } else {
      return NextResponse.json({ erreur: 'action invalide (vu | corrige)' }, { status: 400 })
    }
    const { error } = await supabaseAdmin
      .from('comptabilite_retours')
      .update(update)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE /api/comptabilite/retours?id=XX
// Annule un retour (le comptable s'est trompé).
export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('comptabilite_retours').delete().eq('id', Number(id))
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
