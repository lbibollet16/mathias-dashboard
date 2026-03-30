import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    let alts: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('pieces_alternatives')
        .select('code_principal, code_alternatif')
        .range(from, from + 999)
      if (error) throw error
      alts = alts.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    return NextResponse.json(alts)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
