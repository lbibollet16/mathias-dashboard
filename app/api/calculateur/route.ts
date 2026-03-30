import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('cache_inventaire')
      .select('cache_json, calcule_le')
      .order('calcule_le', { ascending: false })
      .limit(1)
      .single()

    if (error || !data) {
      return NextResponse.json({ erreur: 'Cache vide - lancez /api/calculateur/recalculer' }, { status: 200 })
    }

    return NextResponse.json({ ...data.cache_json, calcule_le: data.calcule_le })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
