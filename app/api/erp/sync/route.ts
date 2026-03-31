import { NextResponse } from 'next/server'
import { supabaseAdmin, parseFrNum } from '@/lib/supabase'

export async function GET() { return POST() }

export async function POST() {
  const log: string[] = []
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]

  try {
    log.push(`=== ERP Sync ${todayStr} ===`)

    // 1. Télécharger Traction
    const tractionRes = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(90000) })
    if (!tractionRes.ok) throw new Error('Traction HTTP ' + tractionRes.status)
    const tractionCSV = await tractionRes.text()
    const tractionLines = tractionCSV.split(/\r?\n/)
    if (tractionLines.length < 10) throw new Error('Traction données insuffisantes')

    // 2. Parser Traction
    const hdrs = (tractionLines[0] || '').split(';')
    const idx = (n: string) => hdrs.findIndex(h => h.trim().toLowerCase() === n.toLowerCase())
    const iP = idx('PKCode'), iS = idx('QTYMINUSRESERVED'), iF = idx('PKFournisseur')
    const iC = idx('PrixCoutant'), iL = idx('CodeLigne'), iD = idx('DescFra')

    // Télécharger fournisseurs TSV pour avoir les noms
    const fournRes = await fetch(process.env.FOURNISSEURS_URL!)
    const fournTSV = await fournRes.text()
    const dictFourn = new Map<string, string>()
    for (const line of fournTSV.split(/\r?\n/).slice(1)) {
      const cols = line.split('\t')
      const idF = cols[0]?.replace(/['"]/g, '').trim()
      const nom = cols[1]?.replace(/['"]/g, '').trim()
      if (idF && nom) dictFourn.set(idF, nom)
    }

    const stockAuj = new Map<string, { stock: number; idF: string; nomF: string; ligne: string; cost: number; desc: string }>()
    for (let i = 1; i < tractionLines.length; i++) {
      if (!tractionLines[i]?.trim()) continue
      const cols = tractionLines[i].split(';')
      if (cols.length < 5) continue
      const pk = cols[iP]?.replace(/['"]/g, '').trim()
      if (!pk) continue
      const idF = (cols[iF] || '').replace(/['"]/g, '').trim()
      stockAuj.set(pk, {
        stock: parseFrNum(cols[iS]),
        idF,
        nomF: dictFourn.get(idF) || ('ID:' + idF),
        ligne: (cols[iL] || '').replace(/['"]/g, '').trim() || 'N/A',
        cost:  parseFrNum(cols[iC]),
        desc:  (cols[iD] || '').replace(/['"]/g, '').trim(),
      })
    }
    log.push(`${stockAuj.size} pièces Traction`)

    // 3. Politiques (pour les lots retournables seulement)
    const { data: pols } = await supabaseAdmin.from('politiques_fournisseurs').select('*')
    const mapPol = new Map<string, { nom: string; jours: number }>()
    for (const p of pols || []) mapPol.set(String(p.id_fournisseur), { nom: p.nom_fournisseur, jours: p.jours_retour })

    // 4. Stock hier — pagination complète
    const mapHier = new Map<string, number>()
    let hierFrom = 0
    while (true) {
      const { data: hierRows } = await supabaseAdmin.from('stock_hier').select('code_piece, quantite').range(hierFrom, hierFrom + 4999)
      for (const r of hierRows || []) mapHier.set(r.code_piece, Number(r.quantite))
      if (!hierRows || hierRows.length < 5000) break
      hierFrom += 5000
    }
    const modeInit = mapHier.size === 0

    // 5. Lots actifs — pagination complète
    let lotsActifs: any[] = []
    let lotsFrom = 0
    while (true) {
      const { data: lotsRows } = await supabaseAdmin.from('lots_retournables').select('*').gt('qte_restante', 0).gte('date_limite', todayStr).range(lotsFrom, lotsFrom + 4999)
      lotsActifs = lotsActifs.concat((lotsRows || []).map((l: any) => ({ ...l, qte_restante: Number(l.qte_restante) })))
      if (!lotsRows || lotsRows.length < 5000) break
      lotsFrom += 5000
    }

    const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().split('T')[0] }
    const nouveauStock: any[] = []
    const nouveauxNegatifs: any[] = []  // TOUS les négatifs, tous fournisseurs
    const lotsAAjouter: any[] = []
    const lotsAMaj: { id: number; qte_restante: number }[] = []
    let lotCtr = 0

    for (const [pk, info] of stockAuj.entries()) {
      // Sauvegarder dans stock_hier (toutes les pièces)
      nouveauStock.push({ code_piece: pk, quantite: info.stock })

      // Négatifs — TOUS les fournisseurs, pas seulement ceux avec politique
      if (info.stock < 0) {
        nouveauxNegatifs.push({
          fournisseur:   info.nomF,
          ligne:         info.ligne,
          code_piece:    pk,
          description:   info.desc,
          stock_negatif: info.stock,
          cout_unitaire: info.cost,
          date_apparition: todayStr
        })
      }

      // Lots retournables — seulement fournisseurs avec politique
      const pol = mapPol.get(info.idF)
      if (!pol) continue
      if (modeInit) continue

      if (!mapHier.has(pk)) continue
      const hier = mapHier.get(pk)!
      const diff = Math.max(0, info.stock) - Math.max(0, hier)

      if (diff > 0) {
        lotCtr++
        lotsAAjouter.push({
          id_lot: `LOT_${pk}_${now.getTime()}_${lotCtr}`,
          code_piece: pk, code_ligne: info.ligne, fournisseur: pol.nom,
          qte_recue: diff, qte_restante: diff,
          date_limite: addDays(now, pol.jours), cout_unitaire: info.cost,
        })
      } else if (diff < 0) {
        let qty = Math.abs(diff)
        const lp = lotsActifs.filter(l => l.code_piece === pk && l.qte_restante > 0)
          .sort((a, b) => new Date(a.date_limite).getTime() - new Date(b.date_limite).getTime())
        for (const lot of lp) {
          if (qty <= 0) break
          if (lot.qte_restante >= qty) { lotsAMaj.push({ id: lot.id, qte_restante: lot.qte_restante - qty }); qty = 0 }
          else { lotsAMaj.push({ id: lot.id, qte_restante: 0 }); qty -= lot.qte_restante }
        }
      }
    }

    log.push(`${nouveauxNegatifs.length} négatifs (tous fournisseurs)`)
    log.push(`${lotsAAjouter.length} nouveaux lots, ${lotsAMaj.length} lots mis à jour`)

    // 7. Sauvegarder stock
    await supabaseAdmin.from('stock_hier').delete().neq('id', 0)
    for (let i = 0; i < nouveauStock.length; i += 500)
      await supabaseAdmin.from('stock_hier').insert(nouveauStock.slice(i, i + 500))

    // 8. Lots
    if (lotsAAjouter.length > 0) await supabaseAdmin.from('lots_retournables').insert(lotsAAjouter)
    for (const m of lotsAMaj) await supabaseAdmin.from('lots_retournables').update({ qte_restante: m.qte_restante }).eq('id', m.id)

    // 9. Négatifs — upsert pour conserver la date d'apparition originale
    // Lire les dates existantes
    const { data: negExistants } = await supabaseAdmin.from('memoire_negatifs').select('code_piece, date_apparition')
    const mapDatesNeg = new Map<string, string>()
    for (const n of negExistants || []) mapDatesNeg.set(n.code_piece, n.date_apparition)

    // Conserver la date d'apparition originale si la pièce était déjà négative
    const negAvecDates = nouveauxNegatifs.map((n: any) => ({
      ...n,
      date_apparition: mapDatesNeg.get(n.code_piece) || todayStr
    }))

    await supabaseAdmin.from('memoire_negatifs').delete().neq('id', 0)
    for (let i = 0; i < negAvecDates.length; i += 500)
      await supabaseAdmin.from('memoire_negatifs').insert(negAvecDates.slice(i, i + 500))

    // 10. Remettre dans "À vérifier" les pièces encore négatives
    const codesNegatifsAujourd = new Set(nouveauxNegatifs.map((n: any) => n.code_piece))
    const { data: verifiesExistants } = await supabaseAdmin.from('negatifs_verifies').select('id, code_piece')
    const aRetablir = (verifiesExistants || []).filter((v: any) => codesNegatifsAujourd.has(v.code_piece))
    if (aRetablir.length > 0) {
      for (const v of aRetablir) {
        await supabaseAdmin.from('negatifs_verifies').delete().eq('id', v.id)
      }
      log.push(`${aRetablir.length} pièces vérifiées remises en "À vérifier" (encore négatives)`)
    }

    // 11. Recalcul cache
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    try { await fetch(`${baseUrl}/api/calculateur/recalculer`, { method: 'POST' }) } catch {}

    return NextResponse.json({
      success: true, modeInit,
      stats: { pieces: stockAuj.size, lots_new: lotsAAjouter.length, lots_maj: lotsAMaj.length, negatifs: nouveauxNegatifs.length },
      log
    })

  } catch (e: any) {
    return NextResponse.json({ success: false, erreur: e.message, log }, { status: 500 })
  }
}
