import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'

// GET ?commande_id=X — historique des modifs (remarque/plan_action/date_bo)
// pour une commande, du plus récent au plus ancien.
export async function GET(req: NextRequest) {
  try {
    const id = Number(new URL(req.url).searchParams.get('commande_id') || 0)
    if (!id) return NextResponse.json({ erreur: 'commande_id requis' }, { status: 400 })

    const { data, error } = await supabaseAdmin
      .from('commandes_attente_historique')
      .select('*')
      .eq('commande_id', id)
      .order('modifie_le', { ascending: false })
      .limit(50)

    if (error) throw error
    return NextResponse.json({ historique: data || [] })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
