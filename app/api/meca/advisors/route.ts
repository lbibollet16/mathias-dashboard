import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'

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

    // Noms vus dans le rapport aviseur sans aviseur rattaché.
    //
    // Les deux fichiers sources n'ont AUCUNE clé commune : la liste des bons
    // donne le numéro d'aviseur (d'où les « Aviseur #NN »), le rapport donne le
    // nom. Le rattachement se fait par nom, donc il n'aboutit qu'une fois
    // l'aviseur renommé à l'identique. On renvoie la liste des noms en attente
    // pour que l'UI les propose au lieu de faire retaper la chaîne exacte.
    const orphelins = await chargerTout<any>(
      'meca_advisor_performance',
      q => q.select('advisor_nom').is('advisor_id', null),
      'advisor_nom'
    )
    const nomsRapportNonRattaches = Array.from(new Set(orphelins.map(o => o.advisor_nom))).sort()

    return NextResponse.json({ advisors: result, nomsRapportNonRattaches })
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

    // Renommage : on rattache aussi les lignes de performance déjà importées qui
    // portaient ce nom sans aviseur. Sans ça, renommer ne servirait à rien tant
    // qu'on n'a pas réimporté le rapport — le rattachement ne se fait qu'à
    // l'import, et l'utilisateur ne peut pas le deviner.
    let perfRattachees = 0
    if (patch.nom) {
      const { data: liees, error: errLink } = await supabaseAdmin
        .from('meca_advisor_performance')
        .update({ advisor_id: id })
        .eq('advisor_nom', patch.nom)
        .is('advisor_id', null)
        .select('id')
      if (errLink) throw errLink
      perfRattachees = liees?.length ?? 0
    }

    return NextResponse.json({ success: true, advisor: data, perfRattachees })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
