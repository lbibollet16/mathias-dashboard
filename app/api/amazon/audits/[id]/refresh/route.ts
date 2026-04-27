import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant } from '@/lib/amazon-inventory'
import { loadManualMappings, distributeToBases } from '@/lib/amazon-mapping'

// POST — rafraîchit les valeurs théoriques d'un audit sans toucher aux comptages
// physiques déjà saisis (hub_compte, fbm_compte, sans_prefix_compte, counted_by,
// counted_at, notes). Utile quand le snapshot FBA Amazon a été mis à jour ou
// que les mappings manuels ont changé après la création de l'audit.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const auditId = parseInt(id, 10)
    if (isNaN(auditId)) return NextResponse.json({ erreur: 'id invalide' }, { status: 400 })

    const { data: audit, error: aErr } = await supabaseAdmin
      .from('amazon_audits')
      .select('id, statut')
      .eq('id', auditId)
      .single()
    if (aErr || !audit) return NextResponse.json({ erreur: 'Audit introuvable' }, { status: 404 })

    // 1. Traction AMA/FBA/FBM
    const tractionRows: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, qty_minus_reserved, prix_coutant, desc_fra')
        .in('code_ligne', ['AMA', 'FBA', 'FBM'])
        .range(from, from + 999)
      if (error) throw error
      tractionRows.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // 2. Dernier snapshot FBA
    const { data: snapDates } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const latestSnap = snapDates && snapDates[0]?.snapshot_date

    const manualMappings = await loadManualMappings()

    const fbaByBase = new Map<string, number>()
    if (latestSnap) {
      let f = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, afn_fulfillable_quantity, afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity, afn_reserved_quantity, traction_code')
          .eq('snapshot_date', latestSnap)
          .range(f, f + 999)
        if (!data) break
        for (const row of data) {
          const amazonTotal = Number(row.afn_fulfillable_quantity || 0)
            + Number(row.afn_inbound_working_quantity || 0)
            + Number(row.afn_inbound_shipped_quantity || 0)
            + Number(row.afn_inbound_receiving_quantity || 0)
            + Number(row.afn_reserved_quantity || 0)
          if (amazonTotal === 0) continue
          const dist = distributeToBases(row.sku, row.traction_code, amazonTotal, manualMappings)
          for (const d of dist) {
            if (!d.base) continue
            fbaByBase.set(d.base, (fbaByBase.get(d.base) || 0) + d.physical_qty)
          }
        }
        if (data.length < 1000) break
        f += 1000
      }
    }

    // 3. Grouper Traction par base
    type BaseAccum = { description: string | null; coutant: number; hub: number; fbm: number; sans_prefix: number; fba_traction: number }
    const bases = new Map<string, BaseAccum>()
    for (const t of tractionRows) {
      const v = detectVariant(t.pk_code)
      const qty = Number(t.qty_minus_reserved || 0)
      const ex = bases.get(v.base) || { description: null, coutant: 0, hub: 0, fbm: 0, sans_prefix: 0, fba_traction: 0 }
      if (!ex.description && t.desc_fra) ex.description = t.desc_fra
      if (ex.coutant === 0 && Number(t.prix_coutant || 0) > 0) ex.coutant = Number(t.prix_coutant)
      if (v.location === 'HUB')       ex.hub += qty
      else if (v.location === 'FBM')  ex.fbm += qty
      else if (v.location === 'FBA')  ex.fba_traction += qty
      else                            ex.sans_prefix += qty
      bases.set(v.base, ex)
    }

    // 4. Charger les lignes existantes pour savoir lesquelles update vs insert
    const { data: existingRows } = await supabaseAdmin
      .from('amazon_audit_counts')
      .select('id, base_code')
      .eq('audit_id', auditId)
    const existingByBase = new Map<string, number>()
    for (const r of existingRows || []) existingByBase.set(r.base_code, r.id)

    // 5. UPDATE lignes existantes (sans toucher aux *_compte)
    let updated = 0
    let inserted = 0
    const toInsert: any[] = []

    for (const [base, b] of bases) {
      const fba_amazon = fbaByBase.get(base) || 0
      if (b.hub === 0 && b.fbm === 0 && b.sans_prefix === 0 && fba_amazon === 0 && b.fba_traction === 0) continue

      const existingId = existingByBase.get(base)
      if (existingId) {
        const { error } = await supabaseAdmin
          .from('amazon_audit_counts')
          .update({
            description: b.description,
            coutant: b.coutant,
            hub_theorique: b.hub,
            fbm_theorique: b.fbm,
            sans_prefix_theorique: b.sans_prefix,
            fba_amazon_theorique: fba_amazon,
            fba_traction_theorique: b.fba_traction,
          })
          .eq('id', existingId)
        if (error) throw error
        updated++
      } else {
        toInsert.push({
          audit_id: auditId,
          base_code: base,
          description: b.description,
          coutant: b.coutant,
          hub_theorique: b.hub,
          fbm_theorique: b.fbm,
          sans_prefix_theorique: b.sans_prefix,
          fba_amazon_theorique: fba_amazon,
          fba_traction_theorique: b.fba_traction,
        })
      }
    }

    if (toInsert.length > 0) {
      for (let i = 0; i < toInsert.length; i += 500) {
        const batch = toInsert.slice(i, i + 500)
        const { error } = await supabaseAdmin.from('amazon_audit_counts').insert(batch)
        if (error) throw error
        inserted += batch.length
      }
    }

    // Maj snapshot_count
    const newTotal = (existingRows?.length || 0) + inserted
    await supabaseAdmin
      .from('amazon_audits')
      .update({ snapshot_count: newTotal })
      .eq('id', auditId)

    return NextResponse.json({
      success: true,
      updated,
      inserted,
      snapshot_date: latestSnap,
      total: newTotal,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
