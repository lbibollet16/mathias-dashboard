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

// PATCH — édition d'une remarque / plan d'action OU du seuil de config
//
// body = { id, remarque?, plan_action? }                → update ligne
// body = { config: { seuil_jours: number } }            → update config
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

    const { id, remarque, plan_action } = body || {}
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

    const patch: any = { date_action: new Date().toISOString() }
    if (remarque !== undefined) patch.remarque = remarque || null
    if (plan_action !== undefined) patch.plan_action = plan_action || null

    const { error } = await supabaseAdmin
      .from('commandes_attente')
      .update(patch)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
