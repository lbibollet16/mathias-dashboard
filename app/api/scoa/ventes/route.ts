import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { appliquerOverridesFni } from '@/lib/scoa-fni-overrides'

// GET /api/scoa/ventes - liste filtrable des ventes brutes.
// DELETE /api/scoa/ventes?type=...&periode_debut=...&periode_fin=... - purge un import.

const TYPES_VALIDES = new Set(['ps_neuf', 'ps_usage', 'bateau_neuf', 'bateau_usage', 'rapport_fni_vendeur'])

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl
    const types = url.searchParams.getAll('type').filter(t => TYPES_VALIDES.has(t))
    const marque = url.searchParams.get('marque')
    const vendeur = url.searchParams.get('vendeur')
    const dateDebut = url.searchParams.get('date_debut')
    const dateFin = url.searchParams.get('date_fin')
    const search = (url.searchParams.get('q') || '').trim()

    let q = supabaseAdmin.from('scoa_ventes').select('*')
    if (types.length > 0) q = q.in('type', types)
    if (marque) q = q.eq('marque', marque)
    if (vendeur) q = q.eq('vendeur_nom', vendeur)
    if (dateDebut) q = q.gte('date_vente', dateDebut)
    if (dateFin) q = q.lte('date_vente', dateFin)
    if (search) {
      const s = search.replace(/[%]/g, '')
      q = q.or(`client.ilike.%${s}%,stock_num.ilike.%${s}%,modele.ilike.%${s}%,marque.ilike.%${s}%`)
    }
    q = q.order('date_vente', { ascending: false }).limit(5000)

    const { data, error } = await q
    if (error) throw error

    // Applique les overrides FNI (mappings stock → spécialiste FNI)
    const ventes = await appliquerOverridesFni(data || [])

    // Stats rapides (comptes par type) même sans filtre
    const { data: counts } = await supabaseAdmin.from('scoa_ventes').select('type')
    const parType: Record<string, number> = {}
    for (const r of (counts || [])) parType[r.type] = (parType[r.type] || 0) + 1

    return NextResponse.json({ ventes, counts: parType })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = req.nextUrl
    const type = url.searchParams.get('type') || ''
    const periode_debut = url.searchParams.get('periode_debut')
    const periode_fin = url.searchParams.get('periode_fin')
    if (!TYPES_VALIDES.has(type)) return NextResponse.json({ erreur: 'type invalide' }, { status: 400 })
    if (!periode_debut || !periode_fin) return NextResponse.json({ erreur: 'periode_debut et periode_fin requis' }, { status: 400 })

    const { error, count } = await supabaseAdmin
      .from('scoa_ventes')
      .delete({ count: 'exact' })
      .eq('type', type)
      .eq('periode_debut', periode_debut)
      .eq('periode_fin', periode_fin)
    if (error) throw error
    return NextResponse.json({ success: true, deleted: count || 0 })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
