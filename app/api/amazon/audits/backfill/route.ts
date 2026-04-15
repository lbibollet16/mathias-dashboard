import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { syncTractionFeed } from '@/lib/amazon-traction-sync'
import { createAuditSnapshot } from '@/lib/amazon-audit-create'

// POST — crée rétroactivement un audit pour chaque settlement qui n'en a pas
//        déjà un. Utile pour partir sur une base propre.
export async function POST() {
  try {
    // 1. Sync Traction une seule fois
    const sync = await syncTractionFeed()

    // 2. Lister tous les settlements
    const { data: settlements, error } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end, deposit_date')
      .order('deposit_date', { ascending: true })
    if (error) throw error

    const results: Array<{ settlement_id: string; status: string; audit_id?: number; erreur?: string }> = []
    let created = 0
    let skipped = 0

    for (const s of settlements || []) {
      const refDate = s.deposit_date || s.settlement_end
      let mois = new Date().toISOString().slice(0, 7)
      if (refDate) {
        const d = new Date(refDate)
        if (!isNaN(d.getTime())) mois = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
      }
      const r = await createAuditSnapshot({
        mois,
        label: `Auto — Settlement ${s.settlement_id}`,
        settlement_id: s.settlement_id,
        started_by: 'backfill',
      })
      if (r.skipped) {
        skipped++
        results.push({ settlement_id: s.settlement_id, status: 'skipped' })
      } else if (r.success && r.audit) {
        created++
        results.push({ settlement_id: s.settlement_id, status: 'created', audit_id: r.audit.id })
      } else {
        results.push({ settlement_id: s.settlement_id, status: 'erreur', erreur: r.erreur })
      }
    }

    return NextResponse.json({
      success: true,
      sync_traction: sync,
      total_settlements: (settlements || []).length,
      created,
      skipped,
      results,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
