import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET — toutes les attributions FNI (stock → vendeur FNI)
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('scoa_fni_assignments')
      .select('*')
      .order('stock_num', { ascending: true })
    if (error) throw error
    return NextResponse.json({ assignments: data || [] })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
