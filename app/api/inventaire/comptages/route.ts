import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    let query = supabaseAdmin.from('inventaire_comptages').select('*').order('date_comptage', { ascending: false })
    let all: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await query.range(from, from + 999)
      if (error) throw error
      all = all.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    return NextResponse.json(all)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { code_piece, localisation, qte_comptee, qte_systeme, qte_reservee, employe, note } = body
    if (!code_piece || !localisation || qte_comptee === undefined || !employe) {
      return NextResponse.json({ erreur: 'Champs requis manquants' }, { status: 400 })
    }
    const ecart = qte_comptee - (qte_systeme || 0)
    const today = new Date().toISOString().split('T')[0]

    await supabaseAdmin.from('inventaire_comptages').delete()
      .eq('code_piece', code_piece).eq('localisation', localisation)
      .gte('date_comptage', today + 'T00:00:00')

    const { error } = await supabaseAdmin.from('inventaire_comptages').insert({
      code_piece, localisation,
      qte_comptee: Number(qte_comptee),
      qte_systeme: Number(qte_systeme || 0),
      qte_reservee: Number(qte_reservee || 0),
      ecart, employe,
      note: note || null,
      date_comptage: new Date().toISOString(),
      statut: 'en_attente'
    })
    if (error) throw error
    return NextResponse.json({ success: true, ecart })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get('code')
    const loc = req.nextUrl.searchParams.get('loc')
    if (!code || !loc) return NextResponse.json({ erreur: 'code et loc requis' }, { status: 400 })
    const today = new Date().toISOString().split('T')[0]
    await supabaseAdmin.from('inventaire_comptages').delete()
      .eq('code_piece', code).eq('localisation', loc)
      .gte('date_comptage', today + 'T00:00:00')
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
