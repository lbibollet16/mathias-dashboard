import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — charger tous les comptages
export async function GET(req: NextRequest) {
  try {
    const loc = req.nextUrl.searchParams.get('loc')
    let query = supabaseAdmin
      .from('inventaire_comptages')
      .select('*')
      .order('date_comptage', { ascending: false })
    
    if (loc) query = query.ilike('localisation', `%${loc}%`)

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

// POST — sauvegarder un comptage (remplace si déjà compté aujourd'hui)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { code_piece, localisation, qte_comptee, qte_systeme, qte_reservee, employe, note } = body

    if (!code_piece || !localisation || qte_comptee === undefined || !employe) {
      return NextResponse.json({ erreur: 'Champs requis manquants' }, { status: 400 })
    }

    const ecart = qte_comptee - (qte_systeme || 0)
    const today = new Date().toISOString().split('T')[0]

    // Supprimer comptage existant aujourd'hui pour cette pièce+localisation
    await supabaseAdmin
      .from('inventaire_comptages')
      .delete()
      .eq('code_piece', code_piece)
      .eq('localisation', localisation)
      .gte('date_comptage', today + 'T00:00:00')

    // Insérer le nouveau
    const { error } = await supabaseAdmin.from('inventaire_comptages').insert({
      code_piece, localisation,
      qte_comptee: Number(qte_comptee),
      qte_systeme: Number(qte_systeme || 0),
      qte_reservee: Number(qte_reservee || 0),
      ecart,
      employe,
      note: note || null,
      date_comptage: new Date().toISOString()
    })

    if (error) throw error
    return NextResponse.json({ success: true, ecart })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
