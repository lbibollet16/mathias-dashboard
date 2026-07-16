import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET   — tous les aviseurs connus + nb de bons ouverts, âge moyen, signalés
//         (alimente le paramétrage de l'onglet Aviseur Technique)
// PATCH — règle departement ('powersport' | 'marine' | null) et/ou actif

// Un bon vu ouvert sur 2 imports consécutifs ou plus est signalé.
const SEUIL_SIGNALEMENT = 2

export async function GET() {
  try {
    const { data: advisors, error } = await supabaseAdmin
      .from('meca_advisors')
      .select('id, nom, departement, actif')
      .order('nom', { ascending: true })
    if (error) throw error

    // Paginé : un select() sans range est plafonné à 1000 lignes par PostgREST.
    const openWOs: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error: e } = await supabaseAdmin
        .from('meca_work_orders')
        .select('advisor_id, date_ouverture, imports_vus_ouvert')
        .eq('is_open', true)
        .order('facture_no', { ascending: true })
        .range(from, from + 999)
      if (e) throw e
      if (!data || data.length === 0) break
      openWOs.push(...data)
      if (data.length < 1000) break
    }

    const now = Date.now()
    const stats = new Map<string, { count: number, totalAge: number, signales: number }>()
    for (const wo of openWOs) {
      if (!wo.advisor_id) continue
      const age = Math.floor((now - new Date(wo.date_ouverture).getTime()) / 86400000)
      const s = stats.get(wo.advisor_id) ?? { count: 0, totalAge: 0, signales: 0 }
      s.count += 1
      s.totalAge += age
      if ((wo.imports_vus_ouvert ?? 0) >= SEUIL_SIGNALEMENT) s.signales += 1
      stats.set(wo.advisor_id, s)
    }

    const result = (advisors ?? []).map(a => {
      const s = stats.get(a.id)
      return {
        ...a,
        bonsOuverts:    s?.count ?? 0,
        ageMoyenJours:  s && s.count > 0 ? Math.round(s.totalAge / s.count) : 0,
        bonsSignales:   s?.signales ?? 0,
      }
    })

    return NextResponse.json({ advisors: result })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, departement, actif, nom } = await req.json()
    if (!id) return NextResponse.json({ erreur: "Champ 'id' requis." }, { status: 400 })
    if (departement !== undefined && departement !== null && !['powersport', 'marine'].includes(departement)) {
      return NextResponse.json({ erreur: "'departement' doit être 'powersport', 'marine' ou null." }, { status: 400 })
    }

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (departement !== undefined) patch.departement = departement
    if (actif !== undefined) patch.actif = actif
    // Renommage manuel : l'export des bons de travail ne donne que le numéro
    // d'aviseur, les inconnus arrivent donc en "Aviseur #<id>".
    if (typeof nom === 'string' && nom.trim()) patch.nom = nom.trim()

    const { data, error } = await supabaseAdmin
      .from('meca_advisors').update(patch).eq('id', id).select().single()
    if (error) throw error

    return NextResponse.json({ success: true, advisor: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
