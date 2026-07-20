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
    const { id, actif, nom, transfererVers } = await req.json()
    if (!id) return NextResponse.json({ erreur: "Champ 'id' requis." }, { status: 400 })

    // ── Transfert : donner tout ce qui appartient à un commis (ventes,
    //    factures, factures ouvertes) à un autre commis.
    if (transfererVers) {
      if (transfererVers === id) return NextResponse.json({ erreur: 'Source et destination identiques.' }, { status: 400 })
      const { data: dest } = await supabaseAdmin.from('parts_clerks').select('id, nom').eq('id', transfererVers).maybeSingle()
      if (!dest) return NextResponse.json({ erreur: `Aucun commis destinataire ${transfererVers}.` }, { status: 400 })

      const now = new Date().toISOString()
      const counts: Record<string, number> = {}
      for (const table of ['parts_sales', 'parts_invoices', 'parts_open_invoices']) {
        const maj: any = { clerk_id: transfererVers }
        if (table !== 'parts_sales') maj.updated_at = now
        const { data, error } = await supabaseAdmin.from(table).update(maj).eq('clerk_id', id).select('id')
        if (error) throw error
        counts[table] = data?.length ?? 0
      }
      return NextResponse.json({ success: true, transfere: { ...counts, vers: dest.nom } })
    }

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
