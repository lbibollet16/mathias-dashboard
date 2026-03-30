import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    let lots: any[] = []
    let from = 0
    const today = new Date().toISOString().split('T')[0]
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('lots_retournables')
        .select('*')
        .gt('qte_restante', 0)
        .gte('date_limite', today)
        .order('date_limite', { ascending: true })
        .range(from, from + 4999)
      if (error) return NextResponse.json({ erreur: error.message }, { status: 500 })
      lots = lots.concat(data || [])
      if (!data || data.length < 5000) break
      from += 5000
    }
    return NextResponse.json(lots)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
