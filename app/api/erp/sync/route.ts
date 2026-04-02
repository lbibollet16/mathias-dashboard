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
    const iQ = idx('QTY'), iR = idx('QteReserveEnStock')

    const fournRes = await fetch(process.env.FOURNISSEURS_URL!)
    const fournTSV = await fournRes.text()
    const dictFourn = new Map<string, string>()
    for (const line of fournTSV.split(/\r?\n/).slice(1)) {
      const cols = line.split('\t')
      const idF = cols[0]?.replace(/['"]/g, '').trim()
      const nom = cols[1]?.replace(/['"]/g, '').trim()
      if (idF && nom) dictFourn.set(idF, nom)
    }

    // Stock Traction d'aujourd'hui
    const stockTraction = new Map<string, { stock: number; qtyTotal: number; idF: string; nomF: string; ligne: string; cost: number; desc: string }>()
    for (let i = 1; i < tractionLines.length; i++) {
      if (!tractionLines[i]?.trim()) continue
      const cols = tractionLines[i].split(';')
      if (cols.length < 5) continue
      const pk = cols[iP]?.replace(/['"]/g, '').trim()
      if (!pk) continue
      const idF = (cols[iF] || '').replace(/['"]/g, '').trim()
      const qtyDispo = parseFrNum(cols[iS])
      const qtyReserve = iR >= 0 ? parseFrNum(cols[iR]) : 0
      const qtyTotal = iQ >= 0 ? parseFrNum(cols[iQ]) : (qtyDispo + qtyReserve)
      stockTraction.set(pk, {
        stock: qtyDispo, qtyTotal, idF,
        nomF: dictFourn.get(idF) || ('ID:' + idF),
        ligne: (cols[iL] || '').replace(/['"]/g, '').trim() || 'N/A',
        cost: parseFrNum(cols[iC]),
        desc: (cols[iD] || '').replace(/['"]/g, '').trim(),
      })
    }
    log.push(`${stockTraction.size} pièces Traction`)

    // 3. Politiques fournisseurs
    const { data: pols } = await supabaseAdmin.from('politiques_fournisseurs').select('*')
    const mapPol = new Map<string, { nom: string; jours: number }>()
    for (const p of pols || []) mapPol.set(String(p.id_fournisseur), { nom: p.nom_fournisseur, jours: p.jours_retour })

    // 4. Lire stock_hier (snapshot de la veille — stable toute la journée)
    const mapHier = new Map<string, number>()
    let hierFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin.from('stock_hier').select('code_piece, qty_total, quantite').range(hierFrom, hierFrom + 4999)
      for (const r of rows || []) mapHier.set(r.code_piece, Number(r.qty_total || r.quantite))
      if (!rows || rows.length < 5000) break
      hierFrom += 5000
    }
    const modeInit = mapHier.size === 0
    log.push(modeInit ? 'Mode initialisation (stock_hier vide)' : `${mapHier.size} pièces dans stock_hier`)

    // 5. Lots actifs
    let lotsActifs: any[] = []
    let lotsFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin.from('lots_retournables').select('*').gt('qte_restante', 0).gte('date_limite', todayStr).range(lotsFrom, lotsFrom + 4999)
      lotsActifs = lotsActifs.concat((rows || []).map((l: any) => ({ ...l, qte_restante: Number(l.qte_restante) })))
      if (!rows || rows.length < 5000) break
      lotsFrom += 5000
    }

    const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().split('T')[0] }
    const nouveauStockAuj: any[] = []
    const nouveauxNegatifs: any[] = []
    const lotsAAjouter: any[] = []
    const lotsAMaj: { id: number; qte_restante: number }[] = []
    let lotCtr = 0

    for (const [pk, info] of stockTraction.entries()) {
      // Préparer stock_aujourdhui (remplace l'ancien)
      nouveauStockAuj.push({ code_piece: pk, quantite: info.stock, qty_total: info.qtyTotal || info.stock })

      // Négatifs
      if (info.stock < 0) {
        nouveauxNegatifs.push({
          fournisseur: info.nomF, ligne: info.ligne, code_piece: pk,
          description: info.desc, stock_negatif: info.stock,
          cout_unitaire: info.cost, date_apparition: todayStr
        })
      }

      // Lots retournables — comparer stock_hier vs stock_aujourdhui
      const pol = mapPol.get(info.idF)
      if (!pol || modeInit) continue
      if (!mapHier.has(pk)) continue

      const qtyHier = mapHier.get(pk)!
      const qtyAuj = info.qtyTotal || info.stock
      const diff = qtyAuj - qtyHier  // positif = réception, négatif = vente/sortie

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
        const lp = lotsActifs
          .filter(l => l.code_piece === pk && l.qte_restante > 0)
          .sort((a, b) => new Date(a.date_limite).getTime() - new Date(b.date_limite).getTime())
        for (const lot of lp) {
          if (qty <= 0) break
          if (lot.qte_restante >= qty) { lotsAMaj.push({ id: lot.id, qte_restante: lot.qte_restante - qty }); qty = 0 }
          else { lotsAMaj.push({ id: lot.id, qte_restante: 0 }); qty -= lot.qte_restante }
        }
      }
    }

    log.push(`${lotsAAjouter.length} nouveaux lots, ${lotsAMaj.length} lots mis à jour`)

    // 6. ROTATION: stock_aujourdhui → stock_hier → remplacer stock_aujourdhui
    // a) Copier stock_aujourdhui vers stock_hier
    const ancienAuj: any[] = []
    let aujFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin.from('stock_aujourdhui').select('code_piece, quantite, qty_total').range(aujFrom, aujFrom + 4999)
      ancienAuj.push(...(rows || []))
      if (!rows || rows.length < 5000) break
      aujFrom += 5000
    }

    if (ancienAuj.length > 0) {
      // stock_aujourdhui existant → devient stock_hier
      await supabaseAdmin.from('stock_hier').delete().neq('id', 0)
      for (let i = 0; i < ancienAuj.length; i += 500)
        await supabaseAdmin.from('stock_hier').insert(ancienAuj.slice(i, i + 500))
      log.push(`Rotation: ${ancienAuj.length} lignes stock_aujourdhui → stock_hier`)
    } else {
      // Première fois: pas de stock_aujourdhui → on initialise stock_hier avec Traction
      await supabaseAdmin.from('stock_hier').delete().neq('id', 0)
      for (let i = 0; i < nouveauStockAuj.length; i += 500)
        await supabaseAdmin.from('stock_hier').insert(nouveauStockAuj.slice(i, i + 500))
      log.push(`Init: stock_hier initialisé avec ${nouveauStockAuj.length} pièces`)
    }

    // b) Mettre à jour stock_aujourdhui avec Traction frais
    await supabaseAdmin.from('stock_aujourdhui').delete().neq('id', 0)
    for (let i = 0; i < nouveauStockAuj.length; i += 500)
      await supabaseAdmin.from('stock_aujourdhui').insert(nouveauStockAuj.slice(i, i + 500))
    log.push(`stock_aujourdhui mis à jour: ${nouveauStockAuj.length} pièces`)

    // 7. Lots
    if (lotsAAjouter.length > 0) await supabaseAdmin.from('lots_retournables').insert(lotsAAjouter)
    for (const m of lotsAMaj) await supabaseAdmin.from('lots_retournables').update({ qte_restante: m.qte_restante }).eq('id', m.id)

    // 8. Négatifs
    const { data: negExistants } = await supabaseAdmin.from('memoire_negatifs').select('code_piece, date_apparition')
    const mapDatesNeg = new Map<string, string>()
    for (const n of negExistants || []) mapDatesNeg.set(n.code_piece, n.date_apparition)
    const negAvecDates = nouveauxNegatifs.map((n: any) => ({
      ...n, date_apparition: mapDatesNeg.get(n.code_piece) || todayStr
    }))
    await supabaseAdmin.from('memoire_negatifs').delete().neq('id', 0)
    for (let i = 0; i < negAvecDates.length; i += 500)
      await supabaseAdmin.from('memoire_negatifs').insert(negAvecDates.slice(i, i + 500))

    // 9. Réconciliation inventaire cyclique
    const hier = new Date(now)
    hier.setDate(hier.getDate() - 1)
    const hierStr = hier.toISOString().split('T')[0]
    const { data: comptagesAReconcilier } = await supabaseAdmin
      .from('inventaire_comptages').select('*')
      .eq('statut', 'en_attente').lte('date_comptage', hierStr + 'T23:59:59')
    if (comptagesAReconcilier && comptagesAReconcilier.length > 0) {
      let nb = 0
      for (const c of comptagesAReconcilier) {
        const s = stockTraction.get(c.code_piece)
        if (!s) continue
        await supabaseAdmin.from('inventaire_comptages').update({
          stock_apres_sync: s.stock, ecart_reconcilie: c.qte_comptee - s.stock,
          date_reconciliation: now.toISOString(), statut: 'reconcilie'
        }).eq('id', c.id)
        nb++
      }
      log.push(`${nb} comptages réconciliés`)
    }

    // 10. Recalcul cache
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    try { await fetch(`${baseUrl}/api/calculateur/recalculer`, { method: 'POST' }) } catch {}

    return NextResponse.json({
      success: true, modeInit,
      stats: { pieces: stockTraction.size, lots_new: lotsAAjouter.length, lots_maj: lotsAMaj.length, negatifs: nouveauxNegatifs.length },
      log
    })

  } catch (e: any) {
    return NextResponse.json({ success: false, erreur: e.message, log }, { status: 500 })
  }
}
