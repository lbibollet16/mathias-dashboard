import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const loc = req.nextUrl.searchParams.get('loc')?.trim()
    if (!loc) return NextResponse.json([])

    // Utiliser eq avec or pour correspondance exacte insensible à la casse
    const locUpper = loc.toUpperCase()

    const { data, error } = await supabaseAdmin
      .from('inventaire_localisations')
      .select('*')
      .or(`localisation1.eq.${loc},localisation2.eq.${loc},localisation3.eq.${loc},localisation4.eq.${loc},localisation1.eq.${locUpper},localisation2.eq.${locUpper},localisation3.eq.${locUpper},localisation4.eq.${locUpper}`)
      .order('code_piece')
      .limit(1000)

    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
