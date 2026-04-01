import { NextResponse } from 'next/server'
import { supabaseAdmin, parseFrNum } from '@/lib/supabase'

export async function POST() {
  const log: string[] = []
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]

  try {
    const res = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(90000) })
    if (!res.ok) throw new Error('Traction inaccessible')
    const csv = await res.text()
    const lines = csv.split(/\r?\n/)
    const hdrs = (lines[0] || '').split(';')
    const idx = (n: string) => hdrs.findIndex(h => h.trim().toLowerCase() === n.toLowerCase())
    const iP = idx('PKCode'), iS = idx('QTYMINUSRESERVED'), iF = idx('PKFournisseur')
    const iC = idx('PrixCoutant'), iL = idx('CodeLigne'), iQ = idx('QTY'), iR = idx('QteReserveEnStock')

    const { data: pols } = await supabaseAdmin.from('politiques_fournisseurs').select('*')
    const mapPol = new Map<string, { nom: string; jours: number }>()
    for (const p of pols || []) mapPol.set(String(p.id_fournisseur), { nom: p.nom_fournisseur, jours: p.jours_retour })

    const stockAuj = new Map<string, { stock: number; qtyTotal: number; idF: string; cost: number; ligne: string }>()
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]?.trim()) continue
      const cols = lines[i].split(';')
      if (cols.length < 5) continue
      const pk = cols[iP]?.replace(/['"]/g, '').trim()
      if (!pk) continue
      const idF = (cols[iF] || '').replace(/['"]/g, '').trim()
      if (!mapPol.has(idF)) continue
      const qtyDispo = parseFrNum(cols[iS])
      const qtyReserve = iR >= 0 ? parseFrNum(cols[iR]) : 0
      const qtyTotal = iQ >= 0 ? parseFrNum(cols[iQ]) : (qtyDispo + qtyReserve)
      stockAuj.set(pk, { stock: qtyDispo, qtyTotal, idF, cost: parseFrNum(cols[iC]), ligne: (cols[iL] || '').replace(/['"]/g, '').trim() || 'N/A' })
    }

    const mapHierQty = new Map<string, number>()
    let from = 0
    while (true) {
      const { data: hierRows } = await supabaseAdmin.from('stock_hier').select('code_piece, qty_total, quantite').range(from, from + 4999)
      for (const r of hierRows || []) mapHierQty.set(r.code_piece, Number(r.qty_total || r.quantite))
      if (!hierRows || hierRows.length < 5000) break
      from += 5000
    }

    const { data: lotsActifs } = await supabaseAdmin.from('lots_retournables').select('*').gt('qte_restante', 0).gte('date_limite', todayStr)
    const lots = (lotsActifs || []).map((l: any) => ({ ...l, qte_restante: Number(l.qte_restante) }))
    const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().split('T')[0] }

    const lotsAAjouter: any[] = []
    const lotsAMaj: { id: number; qte_restante: number }[] = []
    let ctr = 0

    for (const [pk, info] of stockAuj.entries()) {
      const pol = mapPol.get(info.idF)
      if (!pol) continue
      const hierQty = mapHierQty.get(pk)
      if (hierQty === undefined) continue
      const diff = info.qtyTotal - hierQty
      if (diff > 0) {
        ctr++
        lotsAAjouter.push({ id_lot: `LOT_${pk}_${now.getTime()}_${ctr}`, code_piece: pk, code_ligne: info.ligne, fournisseur: pol.nom, qte_recue: diff, qte_restante: diff, date_limite: addDays(now, pol.jours), cout_unitaire: info.cost })
      } else if (diff < 0) {
        let qty = Math.abs(diff)
        const lp = lots.filter(l => l.code_piece === pk && l.qte_restante > 0).sort((a, b) => new Date(a.date_limite).getTime() - new Date(b.date_limite).getTime())
        for (const lot of lp) {
          if (qty <= 0) break
          if (lot.qte_restante >= qty) { lotsAMaj.push({ id: lot.id, qte_restante: lot.qte_restante - qty }); qty = 0 }
          else { lotsAMaj.push({ id: lot.id, qte_restante: 0 }); qty -= lot.qte_restante }
        }
      }
    }

    if (lotsAAjouter.length > 0) await supabaseAdmin.from('lots_retournables').insert(lotsAAjouter)
    for (const m of lotsAMaj) await supabaseAdmin.from('lots_retournables').update({ qte_restante: m.qte_restante }).eq('id', m.id)

    log.push(`${lotsAAjouter.length} nouveaux lots, ${lotsAMaj.length} mis a jour`)
    return NextResponse.json({ success: true, log, nouveaux: lotsAAjouter.length })
  } catch (e: any) {
    return NextResponse.json({ success: false, erreur: e.message, log }, { status: 500 })
  }
}
