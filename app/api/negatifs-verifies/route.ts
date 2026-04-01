import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('negatifs_verifies')
      .select('*')
      .order('date_verification', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { code_piece, employe, note, stock_au_moment, valeur_au_moment } = await req.json()
    if (!code_piece || !employe) return NextResponse.json({ erreur: 'code_piece et employe requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('negatifs_verifies').insert({
      code_piece, employe, note: note || null,
      stock_au_moment, valeur_au_moment,
      date_verification: new Date().toISOString()
    })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    // Supprimer par id (prioritaire) ou par code_piece
    if (body.id) {
      const { error } = await supabaseAdmin.from('negatifs_verifies').delete().eq('id', body.id)
      if (error) throw error
    } else if (body.code_piece) {
      const { error } = await supabaseAdmin.from('negatifs_verifies').delete().eq('code_piece', body.code_piece)
      if (error) throw error
    }
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
