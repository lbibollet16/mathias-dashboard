import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — chercher pièces par localisation
export async function GET(req: NextRequest) {
  try {
    const loc = req.nextUrl.searchParams.get('loc')?.trim()
    if (!loc) return NextResponse.json([])

    // Chercher dans les 4 colonnes de localisation
    const { data, error } = await supabaseAdmin
      .from('inventaire_localisations')
      .select('*')
      .or(`localisation1.ilike.%${loc}%,localisation2.ilike.%${loc}%,localisation3.ilike.%${loc}%,localisation4.ilike.%${loc}%`)
      .order('code_piece')

    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
