import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — charger tous les suivis actifs
export async function GET() {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('suivi_commandes')
      .select('*')
      .or(`statut.neq.pas_besoin,date_expiry.gt.${now}`)
      .order('date_action', { ascending: false })

    if (error) throw error
    
    // Dédupliquer — garder seulement le suivi le plus récent par pièce
    const map = new Map<string, any>()
    for (const s of data || []) {
      if (!map.has(s.code_piece)) map.set(s.code_piece, s)
    }
    return NextResponse.json(Array.from(map.values()))
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer ou mettre à jour un suivi
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { code_piece, fournisseur, qte_suggeree, statut, stock_au_moment, employe, date_expiry, piece_alternative } = body

    if (!code_piece || !statut) {
      return NextResponse.json({ erreur: 'code_piece et statut requis' }, { status: 400 })
    }

    // Supprimer l'ancien suivi pour cette pièce
    await supabaseAdmin.from('suivi_commandes').delete().eq('code_piece', code_piece)

    // Insérer le nouveau
    const { error } = await supabaseAdmin.from('suivi_commandes').insert({
      code_piece, fournisseur, qte_suggeree, statut,
      stock_au_moment, employe, date_expiry: date_expiry || null,
      piece_alternative: piece_alternative || null,
      date_action: new Date().toISOString()
    })

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
