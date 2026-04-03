import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const { data, error } = await supabaseAdmin
      .from('inventaire_sessions')
      .select('*')
      .order('date_debut', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { localisation, employe, pieces_attendues, nb_attendues } = await req.json()
    if (!localisation || !employe) return NextResponse.json({ erreur: 'localisation et employe requis' }, { status: 400 })

    const { data: existing } = await supabaseAdmin
      .from('inventaire_sessions')
      .select('*')
      .eq('localisation', localisation)
      .eq('employe', employe)
      .eq('statut', 'en_cours')
      .order('date_debut', { ascending: false })
      .limit(1)

    if (existing && existing.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('inventaire_sessions')
        .update({ pieces_attendues, nb_attendues })
        .eq('id', existing[0].id)
        .select()
      if (error) throw error
      return NextResponse.json({ session: data?.[0], reprise: true })
    }

    const { data, error } = await supabaseAdmin
      .from('inventaire_sessions')
      .insert({ localisation, employe, pieces_attendues, nb_attendues, statut: 'en_cours' })
      .select()
    if (error) throw error
    return NextResponse.json({ session: data?.[0], reprise: false })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, statut } = await req.json()
    if (!id || !statut) return NextResponse.json({ erreur: 'id et statut requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('inventaire_sessions').update({ statut }).eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const all = req.nextUrl.searchParams.get('all')
    if (all === '1') {
      const { error } = await supabaseAdmin
        .from('inventaire_sessions')
        .delete()
        .neq('id', 0)
      if (error) throw error
      return NextResponse.json({ success: true, message: 'Toutes les sessions effacées' })
    }
    return NextResponse.json({ erreur: 'Paramètre all=1 requis' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
