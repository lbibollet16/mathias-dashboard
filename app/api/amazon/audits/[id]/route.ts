import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — détail d'un audit + toutes ses lignes de comptage
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const auditId = parseInt(id, 10)
    if (isNaN(auditId)) return NextResponse.json({ erreur: 'id invalide' }, { status: 400 })

    const { data: audit, error: aErr } = await supabaseAdmin
      .from('amazon_audits')
      .select('*')
      .eq('id', auditId)
      .single()
    if (aErr || !audit) return NextResponse.json({ erreur: 'Audit introuvable' }, { status: 404 })

    const counts: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_audit_counts')
        .select('*')
        .eq('audit_id', auditId)
        .order('base_code', { ascending: true })
        .range(from, from + 999)
      if (error) throw error
      counts.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // Calculer les écarts par ligne + stats globales
    //
    // Les records "sans préfixe" dans Traction peuvent être des master records
    // qui incluent le stock TOTAL (HUB + FBA + FBM). Pour le comptage physique
    // au warehouse, on déduit ce qu'Amazon a déjà chez eux afin de ne pas
    // chercher des unités fantômes.
    //
    // Formule:
    //   sp_theorique_net   = max(0, sp_theorique - fba_amazon - fbm_amazon_declared)
    //   Le HUB reste comme tel (records explicites HUB-xxx)
    //
    const enriched = counts.map((c: any) => {
      const fbaAmz = Number(c.fba_amazon_theorique || 0)
      // Théorique "net" pour sans préfixe : on déduit le stock chez Amazon
      const sp_theorique_raw = Number(c.sans_prefix_theorique || 0)
      const sp_theorique_net = Math.max(0, sp_theorique_raw - fbaAmz)

      const hub_ecart = c.hub_compte != null ? Number(c.hub_compte) - Number(c.hub_theorique || 0) : null
      const fbm_ecart = c.fbm_compte != null ? Number(c.fbm_compte) - Number(c.fbm_theorique || 0) : null
      const sans_prefix_ecart = c.sans_prefix_compte != null ? Number(c.sans_prefix_compte) - sp_theorique_net : null
      const compte = c.hub_compte != null || c.fbm_compte != null || c.sans_prefix_compte != null
      return {
        ...c,
        sans_prefix_theorique_net: sp_theorique_net,
        sans_prefix_theorique_deducted: Math.min(sp_theorique_raw, fbaAmz),
        hub_ecart,
        fbm_ecart,
        sans_prefix_ecart,
        valeur_hub_ecart: hub_ecart != null ? hub_ecart * Number(c.coutant || 0) : 0,
        valeur_fbm_ecart: fbm_ecart != null ? fbm_ecart * Number(c.coutant || 0) : 0,
        compte,
        has_ecart: (hub_ecart !== null && hub_ecart !== 0) || (fbm_ecart !== null && fbm_ecart !== 0) || (sans_prefix_ecart !== null && sans_prefix_ecart !== 0),
      }
    })

    const stats = {
      total: enriched.length,
      comptes: enriched.filter(c => c.compte).length,
      restants: enriched.filter(c => !c.compte).length,
      avec_ecart: enriched.filter(c => c.has_ecart).length,
      valeur_ecart_abs: enriched.reduce((a, c) => a + Math.abs(c.valeur_hub_ecart) + Math.abs(c.valeur_fbm_ecart), 0),
      total_hub_theorique: enriched.reduce((a, c) => a + Number(c.hub_theorique || 0), 0),
      total_hub_compte: enriched.reduce((a, c) => a + (c.hub_compte != null ? Number(c.hub_compte) : 0), 0),
      total_fbm_theorique: enriched.reduce((a, c) => a + Number(c.fbm_theorique || 0), 0),
      total_fbm_compte: enriched.reduce((a, c) => a + (c.fbm_compte != null ? Number(c.fbm_compte) : 0), 0),
    }

    return NextResponse.json({ audit, counts: enriched, stats })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH — saisir les comptages physiques d'une ligne OU finaliser l'audit
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const auditId = parseInt(id, 10)
    if (isNaN(auditId)) return NextResponse.json({ erreur: 'id invalide' }, { status: 400 })
    const body = await req.json()

    // Finaliser l'audit ?
    if (body.action === 'finalize') {
      const { error } = await supabaseAdmin
        .from('amazon_audits')
        .update({
          statut: 'termine',
          finished_at: new Date().toISOString(),
          finished_by: body.finished_by || null,
          notes: body.notes || null,
        })
        .eq('id', auditId)
      if (error) throw error
      return NextResponse.json({ success: true })
    }
    // Réouvrir ?
    if (body.action === 'reopen') {
      const { error } = await supabaseAdmin
        .from('amazon_audits')
        .update({ statut: 'en_cours', finished_at: null, finished_by: null })
        .eq('id', auditId)
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    // Sinon, c'est un update de ligne de comptage
    const { base_code, hub_compte, fbm_compte, sans_prefix_compte, counted_by, notes } = body
    if (!base_code) return NextResponse.json({ erreur: 'base_code requis' }, { status: 400 })

    const update: any = { counted_at: new Date().toISOString() }
    if (hub_compte !== undefined)         update.hub_compte = hub_compte
    if (fbm_compte !== undefined)         update.fbm_compte = fbm_compte
    if (sans_prefix_compte !== undefined) update.sans_prefix_compte = sans_prefix_compte
    if (counted_by !== undefined)         update.counted_by = counted_by || null
    if (notes !== undefined)              update.notes = notes || null

    const { error } = await supabaseAdmin
      .from('amazon_audit_counts')
      .update(update)
      .eq('audit_id', auditId)
      .eq('base_code', base_code)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
