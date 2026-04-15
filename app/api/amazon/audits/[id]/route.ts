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
      const hubRaw = Number(c.hub_theorique || 0)
      const fbmRaw = Number(c.fbm_theorique || 0)
      const spRaw = Number(c.sans_prefix_theorique || 0)

      // Déduction Amazon : on applique la déduction progressivement
      //   - d'abord sur sans_prefix (le plus probable à être un master record)
      //   - puis sur HUB si le SP ne couvre pas toute la déduction
      const dedSp = Math.min(spRaw, fbaAmz)
      const sp_theorique_net = spRaw - dedSp
      const remainingAmz = fbaAmz - dedSp
      const dedHub = Math.min(hubRaw, remainingAmz)
      const hub_theorique_net = hubRaw - dedHub

      // ─── Warehouse fusionné : HUB + SP (physiquement au même endroit) ───
      const warehouse_theorique_net = hub_theorique_net + sp_theorique_net
      const warehouse_theorique_deducted = dedHub + dedSp

      // Comptage physique warehouse = somme hub_compte + sp_compte (les audits
      // précédents peuvent avoir les 2, les nouveaux n'utilisent que hub_compte)
      const hubCompteNum = c.hub_compte != null ? Number(c.hub_compte) : null
      const spCompteNum = c.sans_prefix_compte != null ? Number(c.sans_prefix_compte) : null
      const warehouse_compte = (hubCompteNum != null || spCompteNum != null)
        ? (hubCompteNum || 0) + (spCompteNum || 0)
        : null
      const warehouse_ecart = warehouse_compte != null ? warehouse_compte - warehouse_theorique_net : null

      // Total physique attendu au warehouse (warehouse + FBM)
      const total_warehouse_attendu = warehouse_theorique_net + fbmRaw

      // Écarts FBM inchangés
      const fbm_ecart = c.fbm_compte != null ? Number(c.fbm_compte) - fbmRaw : null
      const compte = warehouse_compte != null || c.fbm_compte != null

      return {
        ...c,
        hub_theorique_net,
        hub_theorique_deducted: dedHub,
        sans_prefix_theorique_net: sp_theorique_net,
        sans_prefix_theorique_deducted: dedSp,
        warehouse_theorique_net,
        warehouse_theorique_deducted,
        warehouse_compte,
        warehouse_ecart,
        // Flag pour signaler les oublis à tagger (action item, pas un input)
        has_oubli: spRaw > 0,
        total_warehouse_attendu,
        fbm_ecart,
        valeur_warehouse_ecart: warehouse_ecart != null ? warehouse_ecart * Number(c.coutant || 0) : 0,
        valeur_fbm_ecart: fbm_ecart != null ? fbm_ecart * Number(c.coutant || 0) : 0,
        compte,
        has_ecart: (warehouse_ecart !== null && warehouse_ecart !== 0) || (fbm_ecart !== null && fbm_ecart !== 0),
      }
    })

    // Tri : priorité au stock à compter (warehouse_theorique_net ou FBM > 0),
    // puis par quantité totale décroissante, base_code ascendant en tiebreak
    enriched.sort((a: any, b: any) => {
      const aStock = Number(a.warehouse_theorique_net || 0) + Number(a.fbm_theorique || 0)
      const bStock = Number(b.warehouse_theorique_net || 0) + Number(b.fbm_theorique || 0)
      const aHas = aStock > 0 ? 1 : 0
      const bHas = bStock > 0 ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (aStock !== bStock) return bStock - aStock
      return String(a.base_code).localeCompare(String(b.base_code))
    })

    const stats = {
      total: enriched.length,
      comptes: enriched.filter(c => c.compte).length,
      restants: enriched.filter(c => !c.compte).length,
      avec_ecart: enriched.filter(c => c.has_ecart).length,
      valeur_ecart_abs: enriched.reduce((a, c) => a + Math.abs(c.valeur_warehouse_ecart) + Math.abs(c.valeur_fbm_ecart), 0),
      total_warehouse_theorique_net: enriched.reduce((a, c) => a + Number(c.warehouse_theorique_net || 0), 0),
      total_warehouse_compte: enriched.reduce((a, c) => a + (c.warehouse_compte != null ? Number(c.warehouse_compte) : 0), 0),
      total_fbm_theorique: enriched.reduce((a, c) => a + Number(c.fbm_theorique || 0), 0),
      total_fbm_compte: enriched.reduce((a, c) => a + (c.fbm_compte != null ? Number(c.fbm_compte) : 0), 0),
      nb_oublis: enriched.filter(c => c.has_oubli).length,
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
    // Nouveau modèle: warehouse_compte (HUB + SP fusionnés) → stocké dans hub_compte
    const { base_code, hub_compte, warehouse_compte, fbm_compte, counted_by, notes } = body
    if (!base_code) return NextResponse.json({ erreur: 'base_code requis' }, { status: 400 })

    const update: any = { counted_at: new Date().toISOString() }
    // warehouse_compte est le nouveau champ unifié ; écrit dans hub_compte et
    // clear sp_compte pour migrer le modèle
    if (warehouse_compte !== undefined) {
      update.hub_compte = warehouse_compte
      update.sans_prefix_compte = null
    } else if (hub_compte !== undefined) {
      update.hub_compte = hub_compte
    }
    if (fbm_compte !== undefined)         update.fbm_compte = fbm_compte
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
