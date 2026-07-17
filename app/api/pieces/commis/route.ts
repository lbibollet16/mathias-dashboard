import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET   — tous les commis pièces connus.
// PATCH { id, actif?, nom? } — visibilité et/ou renommage d'un commis.

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('parts_clerks').select('id, nom, actif').order('nom', { ascending: true })
    if (error) throw error
    return NextResponse.json({ clerks: data ?? [] })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, actif, nom } = await req.json()
    if (!id) return NextResponse.json({ erreur: "Champ 'id' requis." }, { status: 400 })
    const patch: any = { updated_at: new Date().toISOString() }
    if (actif !== undefined) patch.actif = actif
    if (typeof nom === 'string' && nom.trim()) patch.nom = nom.trim()

    const { data, error } = await supabaseAdmin
      .from('parts_clerks').update(patch).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, clerk: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
