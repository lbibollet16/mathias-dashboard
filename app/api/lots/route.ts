import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('lots_retournables')
    .select('*')
    .gt('qte_restante', 0)
    .gte('date_limite', new Date().toISOString().split('T')[0])
    .order('date_limite', { ascending: true })

  if (error) return NextResponse.json({ erreur: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}
