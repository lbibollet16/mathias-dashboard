import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('memoire_negatifs')
      .select('*')
      .order('stock_negatif', { ascending: true })
      .range(0, 9999)

    if (error) return NextResponse.json({ erreur: error.message }, { status: 500 })
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
