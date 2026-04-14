import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { SkuResolver } from '@/lib/amazon-sku'

// GET — liste les SKU Amazon non résolus (avec suggestions fuzzy) + mappings existants
export async function GET(req: NextRequest) {
  try {
    const mode = req.nextUrl.searchParams.get('mode') || 'unresolved'

    if (mode === 'mappings') {
      const { data, error } = await supabaseAdmin
        .from('amazon_sku_mapping')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) throw error
      return NextResponse.json(data || [])
    }

    const [tx, fba, rb] = await Promise.all([
      supabaseAdmin.from('amazon_transactions').select('sku').is('traction_code', null),
      supabaseAdmin.from('amazon_fba_inventory').select('sku').is('traction_code', null),
      supabaseAdmin.from('amazon_reimbursements').select('sku').is('traction_code', null),
    ])

    const bySku = new Map<string, { amazon_sku: string; sources: Set<string>; count: number }>()
    const bump = (sku: string | null, src: string) => {
      if (!sku) return
      if (!bySku.has(sku)) bySku.set(sku, { amazon_sku: sku, sources: new Set(), count: 0 })
      const e = bySku.get(sku)!
      e.sources.add(src)
      e.count++
    }
    for (const r of tx.data || [])  bump(r.sku, 'transactions')
    for (const r of fba.data || []) bump(r.sku, 'fba_inventory')
    for (const r of rb.data || [])  bump(r.sku, 'reimbursements')

    // Enrichir avec des suggestions fuzzy pour chaque SKU non résolu
    const resolver = new SkuResolver()
    await resolver.init()

    const result = Array.from(bySku.values()).map(e => {
      const suggestions = resolver.suggest(e.amazon_sku, 5, 0.80)
      return {
        amazon_sku: e.amazon_sku,
        sources: Array.from(e.sources),
        count: e.count,
        suggestions,  // [{ traction_code, score, source }]
      }
    }).sort((a, b) => b.count - a.count)

    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer/mettre à jour un mapping manuel + propager traction_code aux tables existantes
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { amazon_sku, traction_code, notes } = body
    if (!amazon_sku || !traction_code) {
      return NextResponse.json({ erreur: 'amazon_sku et traction_code requis' }, { status: 400 })
    }

    // Vérifier que le code Traction existe dans les lignes Amazon
    const { data: check } = await supabaseAdmin
      .from('traction_amazon_lignes')
      .select('pk_code')
      .eq('pk_code', traction_code)
      .limit(1)
    if (!check || check.length === 0) {
      return NextResponse.json({
        erreur: `Code Traction "${traction_code}" introuvable dans les lignes AMA/FBA/FBM. Vérifiez qu'il est bien synchronisé.`
      }, { status: 400 })
    }

    // Upsert mapping
    const { error: mErr } = await supabaseAdmin.from('amazon_sku_mapping').upsert({
      amazon_sku,
      traction_code,
      source: 'manuel',
      confidence: 1.0,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'amazon_sku' })
    if (mErr) throw mErr

    // Propager aux 3 tables pour les rows non résolues avec ce sku
    const updates = await Promise.all([
      supabaseAdmin.from('amazon_transactions').update({ traction_code, resolution_source: 'manuel' }).eq('sku', amazon_sku).is('traction_code', null),
      supabaseAdmin.from('amazon_fba_inventory').update({ traction_code, resolution_source: 'manuel' }).eq('sku', amazon_sku).is('traction_code', null),
      supabaseAdmin.from('amazon_reimbursements').update({ traction_code, resolution_source: 'manuel' }).eq('sku', amazon_sku).is('traction_code', null),
    ])

    return NextResponse.json({ success: true, propagated: updates.map(u => u.error ? 'erreur' : 'ok') })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// DELETE — supprime un mapping + réinitialise les tables
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.amazon_sku) return NextResponse.json({ erreur: 'amazon_sku requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('amazon_sku_mapping').delete().eq('amazon_sku', body.amazon_sku)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
