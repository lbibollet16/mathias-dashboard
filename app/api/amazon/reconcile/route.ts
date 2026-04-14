import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST — réconcilie les remboursements CSV avec les settlements via un
// matching exact (SKU + montant) contre les lignes FBA Inventory
// Reimbursement du fichier payments.
//
// Algorithme:
//   1. Reset: vide settlement_id de tous les remboursements
//   2. Pour chaque settlement (par ordre chronologique, oldest first):
//      a. Liste les lignes 'FBA Inventory Reimbursement' du payments
//      b. Pour chaque ligne (SKU, $), cherche un CSV non encore
//         attribué avec même SKU et même amount_total (±0.01$)
//      c. Tie-break: approval_date la plus proche (≤) du settlement_end
//      d. Marque le CSV comme attribué à ce settlement
//   3. Les CSV non matchés restent à settlement_id=null (futurs ou hors-scope)

export async function POST() {
  try {
    // 1. Reset toutes les attributions
    await supabaseAdmin
      .from('amazon_reimbursements')
      .update({ settlement_id: null })
      .not('id', 'is', null)

    // 2. Récupérer tous les settlements, ordre chronologique
    const { data: settlements, error: sErr } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_end')
      .order('settlement_end', { ascending: true })
    if (sErr) throw sErr
    if (!settlements || settlements.length === 0) {
      return NextResponse.json({ success: true, matched: 0, unmatched: 0, message: 'Aucun settlement' })
    }

    // 3. Charger tous les CSV reimbursements en mémoire (pool)
    type Reimb = { id: number; sku: string | null; amount_total: number; approval_date: string | null; settlement_id: string | null }
    const pool: Reimb[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_reimbursements')
        .select('id, sku, amount_total, approval_date, settlement_id')
        .range(from, from + 999)
      if (error) throw error
      for (const r of data || []) {
        pool.push({
          id: r.id,
          sku: r.sku,
          amount_total: Number(r.amount_total || 0),
          approval_date: r.approval_date,
          settlement_id: null,
        })
      }
      if (!data || data.length < 1000) break
      from += 1000
    }

    // 4. Pour chaque settlement (oldest first), greedy match
    const assignments = new Map<number, string>()  // reimb_id → settlement_id
    for (const s of settlements) {
      // Lignes FBA Inventory Reimbursement POSITIVES de ce settlement
      // (les négatives = clawbacks, pas des remboursements à matcher)
      const { data: lines, error: lErr } = await supabaseAdmin
        .from('amazon_transactions')
        .select('sku, amount, amount_description')
        .eq('settlement_id', s.settlement_id)
        .eq('amount_type', 'FBA Inventory Reimbursement')
      if (lErr) throw lErr

      const positives = (lines || []).filter(l => Number(l.amount || 0) > 0)

      for (const p of positives) {
        const pSku = p.sku
        const pAmt = Number(p.amount || 0)
        if (!pSku || pAmt <= 0) continue

        // Candidats: même SKU, même amount_total (±0.01), non assignés,
        // approval_date <= settlement_end (si présente)
        const candidates = pool
          .filter(r => r.settlement_id === null)
          .filter(r => r.sku === pSku)
          .filter(r => Math.abs(r.amount_total - pAmt) < 0.01)
          .filter(r => {
            if (!r.approval_date) return true
            if (!s.settlement_end) return true
            return new Date(r.approval_date).getTime() <= new Date(s.settlement_end).getTime()
          })
          .sort((a, b) => {
            // Préférer la date d'approval la plus proche (récente) du settlement_end
            const da = a.approval_date ? new Date(a.approval_date).getTime() : 0
            const db = b.approval_date ? new Date(b.approval_date).getTime() : 0
            return db - da
          })

        if (candidates.length > 0) {
          const picked = candidates[0]
          picked.settlement_id = s.settlement_id
          assignments.set(picked.id, s.settlement_id)
        }
      }
    }

    // 5. Persister les attributions par lots
    const byStl = new Map<string, number[]>()
    for (const [rid, sid] of assignments) {
      if (!byStl.has(sid)) byStl.set(sid, [])
      byStl.get(sid)!.push(rid)
    }
    for (const [sid, ids] of byStl) {
      // Update par lots de 500 ids
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500)
        const { error } = await supabaseAdmin
          .from('amazon_reimbursements')
          .update({ settlement_id: sid })
          .in('id', batch)
        if (error) throw error
      }
    }

    // 6. Stats
    const total = pool.length
    const matched = assignments.size
    const unmatched = total - matched
    return NextResponse.json({
      success: true,
      total_reimbursements: total,
      matched,
      unmatched,
      by_settlement: Array.from(byStl.entries()).map(([sid, ids]) => ({ settlement_id: sid, matched: ids.length })),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
