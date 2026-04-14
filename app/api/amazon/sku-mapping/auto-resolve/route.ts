import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { SkuResolver } from '@/lib/amazon-sku'

// POST — ré-exécute le résolveur sur tous les SKU Amazon non mappés
// et applique automatiquement ceux dont la meilleure suggestion est ≥ 95%.
// Propagation aux 3 tables (transactions, fba_inventory, reimbursements).
export async function POST() {
  try {
    // Collecter tous les SKU non résolus depuis les 3 sources
    const [tx, fba, rb] = await Promise.all([
      supabaseAdmin.from('amazon_transactions').select('sku').is('traction_code', null),
      supabaseAdmin.from('amazon_fba_inventory').select('sku').is('traction_code', null),
      supabaseAdmin.from('amazon_reimbursements').select('sku').is('traction_code', null),
    ])

    const uniqueSkus = new Set<string>()
    for (const r of tx.data || [])  if (r.sku) uniqueSkus.add(r.sku)
    for (const r of fba.data || []) if (r.sku) uniqueSkus.add(r.sku)
    for (const r of rb.data || [])  if (r.sku) uniqueSkus.add(r.sku)

    if (uniqueSkus.size === 0) {
      return NextResponse.json({ success: true, resolved: 0, total_unresolved: 0, message: 'Aucun SKU à résoudre' })
    }

    const resolver = new SkuResolver()
    await resolver.init()

    const AUTO_THRESHOLD = 0.95
    const resolved: Array<{ amazon_sku: string; traction_code: string; score: number; source: string }> = []
    const stillUnresolved: string[] = []

    for (const sku of uniqueSkus) {
      const suggestions = resolver.suggest(sku, 1, AUTO_THRESHOLD)
      const top = suggestions[0]
      if (top && top.score >= AUTO_THRESHOLD) {
        resolved.push({
          amazon_sku: sku,
          traction_code: top.traction_code,
          score: top.score,
          source: top.source,
        })
      } else {
        stillUnresolved.push(sku)
      }
    }

    if (resolved.length === 0) {
      return NextResponse.json({
        success: true,
        resolved: 0,
        total_unresolved: uniqueSkus.size,
        message: 'Aucun match ≥ 95% trouvé',
      })
    }

    // Persister les mappings
    const mappingRows = resolved.map(r => ({
      amazon_sku: r.amazon_sku,
      traction_code: r.traction_code,
      source: 'auto',
      confidence: r.score,
      updated_at: new Date().toISOString(),
    }))
    const { error: mErr } = await supabaseAdmin
      .from('amazon_sku_mapping')
      .upsert(mappingRows, { onConflict: 'amazon_sku' })
    if (mErr) throw mErr

    // Propager aux 3 tables. On update par SKU (granulaire mais fiable).
    let txUpdated = 0, fbaUpdated = 0, rbUpdated = 0
    for (const r of resolved) {
      const [t1, t2, t3] = await Promise.all([
        supabaseAdmin.from('amazon_transactions')
          .update({ traction_code: r.traction_code, resolution_source: 'auto-rerun' })
          .eq('sku', r.amazon_sku).is('traction_code', null).select('id'),
        supabaseAdmin.from('amazon_fba_inventory')
          .update({ traction_code: r.traction_code, resolution_source: 'auto-rerun' })
          .eq('sku', r.amazon_sku).is('traction_code', null).select('id'),
        supabaseAdmin.from('amazon_reimbursements')
          .update({ traction_code: r.traction_code, resolution_source: 'auto-rerun' })
          .eq('sku', r.amazon_sku).is('traction_code', null).select('id'),
      ])
      txUpdated  += (t1.data || []).length
      fbaUpdated += (t2.data || []).length
      rbUpdated  += (t3.data || []).length
    }

    return NextResponse.json({
      success: true,
      resolved: resolved.length,
      total_unresolved: uniqueSkus.size,
      still_unresolved: stillUnresolved.length,
      propagated: {
        transactions: txUpdated,
        fba_inventory: fbaUpdated,
        reimbursements: rbUpdated,
      },
      examples: resolved.slice(0, 10),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
