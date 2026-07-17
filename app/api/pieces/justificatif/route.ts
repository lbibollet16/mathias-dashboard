import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH { venteId, texte } — justificatif d'une vente sous le seuil de marge.
export async function PATCH(req: NextRequest) {
  try {
    const { venteId, texte } = await req.json()
    if (!venteId || typeof texte !== 'string' || texte.trim().length < 5) {
      return NextResponse.json({ erreur: "Un justificatif d'au moins 5 caractères est requis." }, { status: 400 })
    }
    const { data, error } = await supabaseAdmin
      .from('parts_sales')
      .update({ justificatif_texte: texte.trim(), justificatif_fourni_at: new Date().toISOString() })
      .eq('id', venteId).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, vente: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
