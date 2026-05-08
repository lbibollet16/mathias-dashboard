import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'

// GET — toutes les commandes en attente (active=true) + config (seuil_jours)
export async function GET() {
  try {
    const [{ data: lignes, error: e1 }, { data: cfg, error: e2 }] = await Promise.all([
      supabaseAdmin
        .from('commandes_attente')
        .select('*')
        .eq('active', true)
        .order('date_premiere_vue', { ascending: true }),
      supabaseAdmin
        .from('commandes_attente_config')
        .select('seuil_jours')
        .eq('id', 1)
        .single(),
    ])
    if (e1) throw e1
    const seuil_jours = (cfg && !e2) ? cfg.seuil_jours : 5
    return NextResponse.json({ lignes: lignes || [], seuil_jours })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// PATCH — édition d'une remarque / plan d'action / date_bo OU du seuil de config
//
// body = { id, remarque?, plan_action?, date_bo?, modifie_par? }   → update ligne + log historique
// body = { config: { seuil_jours: number } }                       → update config
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()

    if (body?.config && typeof body.config.seuil_jours === 'number') {
      const seuil = Math.max(1, Math.min(365, Math.round(body.config.seuil_jours)))
      const { error } = await supabaseAdmin
        .from('commandes_attente_config')
        .upsert({ id: 1, seuil_jours: seuil, updated_at: new Date().toISOString() })
      if (error) throw error
      return NextResponse.json({ success: true, seuil_jours: seuil })
    }

    const { id, remarque, plan_action, date_bo, modifie_par } = body || {}
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

    // 1) Récupérer les valeurs actuelles pour détecter les changements
    const { data: avant, error: errLoad } = await supabaseAdmin
      .from('commandes_attente')
      .select('remarque, plan_action, date_bo')
      .eq('id', id)
      .single()
    if (errLoad) throw errLoad

    // 2) Détecter les changements (champ par champ) et préparer l'historique
    const norm = (v: any) => (v === undefined || v === null || v === '') ? null : String(v)
    const changements: { commande_id: number, champ: string, valeur_avant: string | null, valeur_apres: string | null, modifie_par: string | null }[] = []
    const par = (typeof modifie_par === 'string' && modifie_par.trim()) ? modifie_par.trim() : null

    if (remarque !== undefined && norm(avant?.remarque) !== norm(remarque)) {
      changements.push({ commande_id: id, champ: 'remarque', valeur_avant: norm(avant?.remarque), valeur_apres: norm(remarque), modifie_par: par })
    }
    if (plan_action !== undefined && norm(avant?.plan_action) !== norm(plan_action)) {
      changements.push({ commande_id: id, champ: 'plan_action', valeur_avant: norm(avant?.plan_action), valeur_apres: norm(plan_action), modifie_par: par })
    }
    if (date_bo !== undefined && norm(avant?.date_bo) !== norm(date_bo)) {
      changements.push({ commande_id: id, champ: 'date_bo', valeur_avant: norm(avant?.date_bo), valeur_apres: norm(date_bo), modifie_par: par })
    }

    // 3) Insérer l'historique (si changements)
    if (changements.length > 0) {
      const { error: errHist } = await supabaseAdmin
        .from('commandes_attente_historique')
        .insert(changements)
      if (errHist) throw errHist
    }

    // 4) Mettre à jour la commande
    const patch: any = { date_action: new Date().toISOString() }
    if (remarque !== undefined) patch.remarque = remarque || null
    if (plan_action !== undefined) patch.plan_action = plan_action || null
    if (date_bo !== undefined) patch.date_bo = date_bo || null

    const { error } = await supabaseAdmin
      .from('commandes_attente')
      .update(patch)
      .eq('id', id)
    if (error) throw error

    return NextResponse.json({ success: true, changements: changements.length })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
