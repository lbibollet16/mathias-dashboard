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

    // 2c. GARDE-FOU anti-effacement : si le feed parse beaucoup moins de pièces
    // que ce qu'on a déjà en base, c'est probablement un feed tronqué (incident
    // réseau/Traction). On refuse d'écraser les tables — un DELETE+INSERT partiel
    // viderait sinon stock_aujourdhui et memoire_negatifs.
    const { count: nbStockExistant } = await supabaseAdmin
      .from('stock_aujourdhui').select('*', { count: 'exact', head: true })
    if ((nbStockExistant || 0) > 0 && stockTraction.size < 0.8 * (nbStockExistant || 0)) {
      throw new Error(`Feed Traction suspect : ${stockTraction.size} pièces parsées vs ${nbStockExistant} en base (<80 %). Sync annulé pour éviter un écrasement partiel.`)
    }

    // 3. Politiques fournisseurs
    const { data: pols } = await supabaseAdmin.from('politiques_fournisseurs').select('*')
    const mapPol = new Map<string, { nom: string; jours: number }>()
    for (const p of pols || []) mapPol.set(String(p.id_fournisseur), { nom: p.nom_fournisseur, jours: p.jours_retour })

    // 4. Lire stock_hier (snapshot de la veille — stable toute la journée)
    const mapHier = new Map<string, number>()
    let hierFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin.from('stock_hier').select('code_piece, qty_total, quantite').range(hierFrom, hierFrom + 999)
      for (const r of rows || []) mapHier.set(r.code_piece, Number(r.qty_total || r.quantite))
      if (!rows || rows.length < 1000) break
      hierFrom += 1000
    }
    const modeInit = mapHier.size === 0
    log.push(modeInit ? 'Mode initialisation (stock_hier vide)' : `${mapHier.size} pièces dans stock_hier`)

    // 4b. Purge des lots expirés : passé la date limite, le retour fournisseur
    // n'est plus possible — l'unité n'est plus « retournable ». On remet
    // qte_restante à 0 pour qu'ils ne gonflent plus la valeur des retournables
    // ni ne faussent le FIFO ci-dessous.
    const { data: expiresPurge } = await supabaseAdmin
      .from('lots_retournables').update({ qte_restante: 0 })
      .gt('qte_restante', 0).lt('date_limite', todayStr).select('id')
    if (expiresPurge && expiresPurge.length > 0)
      log.push(`${expiresPurge.length} lots expirés purgés (qte_restante → 0)`)

    // 5. Lots actifs
    let lotsActifs: any[] = []
    let lotsFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin.from('lots_retournables').select('*').gt('qte_restante', 0).gte('date_limite', todayStr).range(lotsFrom, lotsFrom + 999)
      lotsActifs = lotsActifs.concat((rows || []).map((l: any) => ({ ...l, qte_restante: Number(l.qte_restante) })))
      if (!rows || rows.length < 1000) break
      lotsFrom += 1000
    }

    const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().split('T')[0] }
    const nouveauStockAuj: any[] = []
    const nouveauxNegatifs: any[] = []
    const lotsAAjouter: any[] = []
    const lotsAMaj: { id: number; qte_restante: number }[] = []
    let lotCtr = 0

    // Toutes les entrées de stock du jour, TOUS fournisseurs confondus —
    // alimente sc_receptions et l'alerte « commande trop importante ».
    // lots_retournables ne couvre que les 11 fournisseurs ayant une politique
    // de retour : il ne pouvait pas servir de base à cette alerte.
    const receptionsDetectees: ReceptionDetectee[] = []

    for (const [pk, info] of stockTraction.entries()) {
      // Préparer stock_aujourdhui (remplace l'ancien)
      nouveauStockAuj.push({ code_piece: pk, quantite: info.stock, qty_total: info.qtyTotal || info.stock })

      // Négatifs. On persiste aussi le TOTAL physique (qty_total) et la quantité
      // réservée : un « négatif » où seul le disponible est < 0 mais le total ≥ 0
      // est en réalité une pièce entièrement réservée (négatif fictif), pas un
      // vrai manque physique. La modale et getAjust s'appuient là-dessus pour ne
      // pas sur-corriger de la quantité réservée.
      if (info.stock < 0) {
        nouveauxNegatifs.push({
          fournisseur: info.nomF, ligne: info.ligne, code_piece: pk,
          description: info.desc, stock_negatif: info.stock,
          qty_total: info.qtyTotal, qte_reservee: info.qtyTotal - info.stock,
          cout_unitaire: info.cost, date_apparition: todayStr
        })
      }

      // Comparer stock_hier vs Traction du jour. Le diff sert à DEUX choses :
      // le suivi des lots retournables (limité aux fournisseurs sous politique)
      // et le journal des réceptions (tous fournisseurs).
      if (modeInit) continue
      if (!mapHier.has(pk)) continue

      const qtyHier = mapHier.get(pk)!
      const qtyAuj = info.qtyTotal || info.stock
      const diff = qtyAuj - qtyHier  // positif = réception, négatif = vente/sortie

      if (diff > 0) receptionsDetectees.push({ pk, info, diff, avant: qtyHier, apres: qtyAuj })

      // Lots retournables — uniquement pour les fournisseurs ayant une politique.
      const pol = mapPol.get(info.idF)
      if (!pol) continue

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

    // 6. ROTATION (corrigée — anti double-comptage des lots)
    //    AVANT : stock_hier recevait l'ancien stock_aujourdhui, qui datait déjà
    //    du run PRÉCÉDENT. Résultat : au run suivant, mapHier pointait 2 runs en
    //    arrière, et chaque réception tombait dans le diff de DEUX syncs
    //    consécutifs → lot créé 2 fois (sync 2×/jour).
    //    MAINTENANT : on écrit le Traction frais de CE run dans stock_hier. Au
    //    prochain run, diff = Traction(k+1) − Traction(k) : chaque réception
    //    n'est captée qu'UNE seule fois, peu importe le nombre de syncs/jour.
    //    (mapHier a déjà été lu à l'étape 4, AVANT cette écriture — l'ordre est sûr.)
    await supabaseAdmin.from('stock_hier').delete().neq('id', 0)
    for (let i = 0; i < nouveauStockAuj.length; i += 500)
      await supabaseAdmin.from('stock_hier').insert(nouveauStockAuj.slice(i, i + 500))
    log.push(`stock_hier ← Traction frais (${nouveauStockAuj.length} pièces) = référence du prochain diff`)

    // b) Mettre à jour stock_aujourdhui avec le même Traction frais
    await supabaseAdmin.from('stock_aujourdhui').delete().neq('id', 0)
    for (let i = 0; i < nouveauStockAuj.length; i += 500)
      await supabaseAdmin.from('stock_aujourdhui').insert(nouveauStockAuj.slice(i, i + 500))
    log.push(`stock_aujourdhui mis à jour: ${nouveauStockAuj.length} pièces`)

    // 7. Lots
    if (lotsAAjouter.length > 0) await supabaseAdmin.from('lots_retournables').insert(lotsAAjouter)
    for (const m of lotsAMaj) await supabaseAdmin.from('lots_retournables').update({ qte_restante: m.qte_restante }).eq('id', m.id)

    // 7b. Journal des réceptions + alerte « commande trop importante ».
    //   Tout est encapsulé dans un try/catch : c'est un module d'analyse greffé
    //   sur le sync, il ne doit JAMAIS faire échouer la synchronisation des
    //   stocks, des lots ou des négatifs dont dépendent les autres onglets.
    try {
      const nbRecep = await enregistrerReceptions(receptionsDetectees, todayStr)
      if (nbRecep.total > 0) {
        log.push(`${nbRecep.total} réceptions journalisées, dont ${nbRecep.alertes} en alerte`)
      }
    } catch (e: any) {
      log.push(`⚠️ Journal des réceptions ignoré : ${e.message}`)
    }

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

    // 8b. Négatifs vérifiés dont le stock est revenu positif : on ARCHIVE
    // (soft-delete via archive_le) au lieu de supprimer, pour conserver la trace
    // d'enquête (cause, photos, justification). Si la pièce redevient négative
    // plus tard, elle réapparaîtra comme un négatif neuf à investiguer.
    const codesEncoreNegatifs = new Set(nouveauxNegatifs.map((n: any) => n.code_piece))
    const { data: verifiesExistants } = await supabaseAdmin.from('negatifs_verifies').select('id, code_piece').is('archive_le', null)
    const verifiesAArchiver = (verifiesExistants || []).filter((v: any) => !codesEncoreNegatifs.has(v.code_piece))
    if (verifiesAArchiver.length > 0) {
      const ids = verifiesAArchiver.map((v: any) => v.id)
      for (let i = 0; i < ids.length; i += 100) {
        await supabaseAdmin.from('negatifs_verifies').update({ archive_le: now.toISOString() }).in('id', ids.slice(i, i + 100))
      }
      log.push(`${verifiesAArchiver.length} négatifs vérifiés archivés (stock corrigé)`)
    }

    // 8c. Auto-correction des retours comptables
    //   - Retour 'négatif'  : si la pièce n'est plus en négatif → marqué corrigé
    //   - Retour 'comptage' : si stock_actuel >= qte_comptee → marqué corrigé
    //   Logique : la Comptabilité ne fait QUE des corrections d'inventaire
    //   (= incrémenter le stock système quand il est trop bas). Quand le
    //   système est déjà ≥ ce qui a été compté, aucune correction comptable
    //   n'est nécessaire. C'est aux employés de vérifier le physique avant.
    const { data: retoursActifs } = await supabaseAdmin
      .from('comptabilite_retours')
      .select('id, source, ref_id, code_piece')
      .is('corrige_le', null)

    if (retoursActifs && retoursActifs.length > 0) {
      const idsAutoCorrNeg: number[] = []
      const idsAutoCorrCpt: number[] = []

      const refIdsComptages = retoursActifs.filter(r => r.source === 'comptage').map(r => r.ref_id)
      const comptagesMap = new Map<number, any>()
      if (refIdsComptages.length > 0) {
        const { data: comptages } = await supabaseAdmin
          .from('inventaire_comptages')
          .select('id, code_piece, qte_comptee, stock_apres_sync, statut')
          .in('id', refIdsComptages)
        for (const c of comptages || []) comptagesMap.set(c.id, c)
      }

      for (const r of retoursActifs) {
        if (r.source === 'negatif' && r.code_piece) {
          if (!codesEncoreNegatifs.has(r.code_piece)) idsAutoCorrNeg.push(r.id)
        } else if (r.source === 'comptage') {
          const c = comptagesMap.get(r.ref_id)
          if (!c) continue
          // On compare avec stock_apres_sync (= stock J+1 du comptage, après
          // les ventes intermédiaires normalement comptabilisées) et non
          // avec stockTraction current. == strict : tout autre cas est un
          // écart réel à corriger par la comptable.
          if (c.stock_apres_sync !== null && c.stock_apres_sync !== undefined
              && Number(c.stock_apres_sync) === Number(c.qte_comptee || 0)) {
            idsAutoCorrCpt.push(r.id)
          }
        }
      }

      const nowIso = now.toISOString()
      if (idsAutoCorrNeg.length > 0) {
        await supabaseAdmin.from('comptabilite_retours').update({
          corrige_le: nowIso, corrige_par: 'SYSTEM',
          vu_le: nowIso, vu_par: 'SYSTEM',
          commentaire_correction: 'Auto-corrigé : stock revenu à zéro ou positif',
        }).in('id', idsAutoCorrNeg)
        log.push(`${idsAutoCorrNeg.length} retours « négatif » auto-corrigés (stock OK)`)
      }
      if (idsAutoCorrCpt.length > 0) {
        await supabaseAdmin.from('comptabilite_retours').update({
          corrige_le: nowIso, corrige_par: 'SYSTEM',
          vu_le: nowIso, vu_par: 'SYSTEM',
          commentaire_correction: 'Auto-corrigé : stock J+1 = quantité comptée (match parfait, aucune correction nécessaire)',
        }).in('id', idsAutoCorrCpt)
        log.push(`${idsAutoCorrCpt.length} retours « comptage » auto-corrigés (stock_apres_sync = qte_comptee)`)
      }
    }

    // 8d. Auto-réconciliation des comptages — basée sur stock_apres_sync
    //   stock_apres_sync = stock au J+1 du comptage, après les ventes
    //   intermédiaires normales. C'est la référence pour décider si un
    //   écart est résiduel (à corriger) ou résolu (équilibré).
    //
    //   PIÈCES MULTI-LOCALISATION : qte_comptee est par localisation alors que
    //   stock_apres_sync est le TOTAL système (toutes locs confondues). On
    //   regroupe donc les comptages par code_piece et on compare la SOMME des
    //   qte_comptee au stock_apres_sync. Le statut n'est passé en « resolu »
    //   que lorsque TOUTES les localisations connues de la pièce ont été
    //   comptées, sinon on attendrait que l'employé finisse son cycle.
    let comptagesReconcilies: any[] = []
    let reconFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin
        .from('inventaire_comptages')
        .select('id, code_piece, localisation, qte_comptee, qte_systeme, ecart_reconcilie, stock_apres_sync, statut')
        .eq('statut', 'reconcilie')
        .order('id', { ascending: true })
        .range(reconFrom, reconFrom + 999)
      comptagesReconcilies = comptagesReconcilies.concat(rows || [])
      if (!rows || rows.length < 1000) break
      reconFrom += 1000
    }

    if (comptagesReconcilies && comptagesReconcilies.length > 0) {
      // Charger les localisations connues pour ces codes
      const codesUniq = Array.from(new Set(comptagesReconcilies.map((c:any) => c.code_piece)))
      const locsParCode = new Map<string, Set<string>>()
      for (let i = 0; i < codesUniq.length; i += 200) {
        const slice = codesUniq.slice(i, i + 200)
        const { data: rows } = await supabaseAdmin
          .from('inventaire_localisations')
          .select('code_piece, localisation1, localisation2, localisation3, localisation4')
          .in('code_piece', slice)
        for (const r of rows || []) {
          if (!r.code_piece || r.code_piece.startsWith('LOC_')) continue
          const set = locsParCode.get(r.code_piece) || new Set<string>()
          for (const l of [r.localisation1, r.localisation2, r.localisation3, r.localisation4]) {
            if (l) set.add(String(l).toUpperCase())
          }
          locsParCode.set(r.code_piece, set)
        }
      }
      // Couverture des localisations basée UNIQUEMENT sur 'reconcilie' (cohérent
      // avec l'agrégation en Comptabilité). Une loc seulement 'en_attente' ne
      // doit pas déclencher l'auto-résolution d'une pièce multi-loc, sinon
      // l'écart serait clos alors qu'une loc n'est pas encore réconciliée.
      const { data: tousRecents } = await supabaseAdmin
        .from('inventaire_comptages')
        .select('code_piece, localisation, statut')
        .in('code_piece', codesUniq)
        .eq('statut', 'reconcilie')
      const compteesParCode = new Map<string, Set<string>>()
      for (const c of tousRecents || []) {
        const set = compteesParCode.get(c.code_piece) || new Set<string>()
        set.add(String(c.localisation || '').toUpperCase())
        compteesParCode.set(c.code_piece, set)
      }

      // Grouper les reconciliés par code_piece
      const parCode = new Map<string, any[]>()
      for (const c of comptagesReconcilies) {
        if (!parCode.has(c.code_piece)) parCode.set(c.code_piece, [])
        parCode.get(c.code_piece)!.push(c)
      }

      const idsResolus: number[] = []
      for (const [code, list] of parCode) {
        const locsConnues = locsParCode.get(code) || new Set<string>()
        if (locsConnues.size > 1) {
          // Pièce multi-loc : exiger que toutes les locs aient été comptées
          const comptees = compteesParCode.get(code) || new Set<string>()
          const toutesComptees = Array.from(locsConnues).every(l => comptees.has(l))
          if (!toutesComptees) continue
          // Somme sur les localisations CONNUES uniquement (#2), comparée au
          // snapshot qte_systeme du premier comptage : si égal, ajustement nul → resolu.
          const listConnues = list.filter((x:any) => locsConnues.has(String(x.localisation || '').toUpperCase()))
          const sumComptee = listConnues.reduce((s:number, x:any) => s + Number(x.qte_comptee || 0), 0)
          const ordered = [...listConnues].sort((a:any, b:any) =>
            new Date(a.date_comptage).getTime() - new Date(b.date_comptage).getTime())
          const qteSysFirst = Number(ordered[0]?.qte_systeme || 0)
          if (sumComptee === qteSysFirst) {
            for (const x of list) idsResolus.push(x.id)
          }
        } else {
          // Single-loc : un comptage est 'resolu' quand l'écart FIGÉ au comptage
          // est nul (aucun ajustement d'inventaire à passer). On n'utilise plus
          // stock_apres_sync === qte_comptee : après une vente intermédiaire ce
          // test est quasi toujours faux, ce qui laissait des comptages parfaits
          // coincés en 'reconcilie' et affichait un faux ajustement en Compta.
          for (const x of list) {
            if (Number(x.ecart_reconcilie || 0) === 0) idsResolus.push(x.id)
          }
        }
      }

      if (idsResolus.length > 0) {
        for (let i = 0; i < idsResolus.length; i += 200) {
          const slice = idsResolus.slice(i, i + 200)
          await supabaseAdmin.from('inventaire_comptages').update({
            statut: 'resolu',
          }).in('id', slice)
        }
        log.push(`${idsResolus.length} comptages marqués « resolu » (stock_apres_sync = somme(qte_comptee))`)
      }
    }

    // 8e. Déduplication des comptages — garder uniquement le PLUS RÉCENT par
    //     (code_piece, localisation). Les anciens passent en statut 'obsolete'.
    //     Évite les doublons dans la liste comptable quand un employé refait
    //     le comptage sur la même pièce+loc à plusieurs jours d'intervalle.
    let tousComptages: any[] = []
    let dedupFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin
        .from('inventaire_comptages')
        .select('id, code_piece, localisation, date_comptage, statut')
        .in('statut', ['reconcilie', 'resolu'])
        .order('id', { ascending: true })
        .range(dedupFrom, dedupFrom + 999)
      tousComptages = tousComptages.concat(rows || [])
      if (!rows || rows.length < 1000) break
      dedupFrom += 1000
    }

    if (tousComptages && tousComptages.length > 0) {
      // Grouper par (code_piece, localisation)
      const groupes = new Map<string, any[]>()
      for (const c of tousComptages) {
        const key = `${c.code_piece}__${String(c.localisation || '').toUpperCase()}`
        if (!groupes.has(key)) groupes.set(key, [])
        groupes.get(key)!.push(c)
      }
      // Pour chaque groupe avec ≥ 2 comptages, marquer les anciens en 'obsolete'
      const idsObsolete: number[] = []
      for (const [, list] of groupes) {
        if (list.length < 2) continue
        list.sort((a, b) => new Date(b.date_comptage).getTime() - new Date(a.date_comptage).getTime())
        // Garder list[0] (le plus récent), marquer les autres
        for (let i = 1; i < list.length; i++) {
          if (list[i].statut !== 'obsolete') idsObsolete.push(list[i].id)
        }
      }
      if (idsObsolete.length > 0) {
        for (let i = 0; i < idsObsolete.length; i += 200) {
          const slice = idsObsolete.slice(i, i + 200)
          await supabaseAdmin.from('inventaire_comptages').update({
            statut: 'obsolete',
          }).in('id', slice)
        }
        log.push(`${idsObsolete.length} comptages anciens marqués « obsolete » (superseded par un comptage plus récent)`)
      }
    }

    // 8f. Auto-résolution des comptages dont la pièce est MAINTENANT à 0 en stock.
    //   L'écart d'inventaire n'est plus corrigeable : il n'y a plus rien à
    //   ajuster ni à recompter (le stock compté a été vendu/expédié depuis). On
    //   passe ces comptages en 'resolu' pour ne plus encombrer la Comptabilité
    //   avec une valeur « Système » périmée. La donnée reste en base.
    const stockTotalUC = new Map<string, number>()
    for (const [k, v] of stockTraction) stockTotalUC.set(k.toUpperCase(), v.qtyTotal || 0)
    let recAvecEcart: any[] = []
    let recFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin
        .from('inventaire_comptages')
        .select('id, code_piece')
        .eq('statut', 'reconcilie')
        .neq('ecart_reconcilie', 0)
        .order('id', { ascending: true })
        .range(recFrom, recFrom + 999)
      recAvecEcart = recAvecEcart.concat(rows || [])
      if (!rows || rows.length < 1000) break
      recFrom += 1000
    }
    const idsStock0 = recAvecEcart
      .filter(c => (stockTotalUC.get(String(c.code_piece || '').toUpperCase()) || 0) === 0)
      .map(c => c.id)
    if (idsStock0.length > 0) {
      for (let i = 0; i < idsStock0.length; i += 200) {
        await supabaseAdmin.from('inventaire_comptages').update({ statut: 'resolu' }).in('id', idsStock0.slice(i, i + 200))
      }
      log.push(`${idsStock0.length} comptages auto-résolus (pièce maintenant à 0 — écart non corrigeable)`)
    }

    // 9. Réconciliation inventaire cyclique
    const hier = new Date(now)
    hier.setDate(hier.getDate() - 1)
    const hierStr = hier.toISOString().split('T')[0]
    const { data: comptagesAReconcilier } = await supabaseAdmin
      .from('inventaire_comptages').select('*')
      .eq('statut', 'en_attente').lte('date_comptage', hierStr + 'T23:59:59')
    if (comptagesAReconcilier && comptagesAReconcilier.length > 0) {
      // Index Traction insensible à la casse : les PKCode scannés par l'employé
      // sont mis en majuscules, un simple écart de casse bloquait sinon la pièce.
      const stockTractionUC = new Map<string, any>()
      for (const [k, v] of stockTraction) stockTractionUC.set(k.toUpperCase(), v)
      let nb = 0
      for (const c of comptagesAReconcilier) {
        const s = stockTraction.get(c.code_piece) || stockTractionUC.get(String(c.code_piece || '').toUpperCase())
        // Écart d'inventaire = différence AU MOMENT DU COMPTAGE (qte_comptee
        // vs qte_systeme), PAS au moment de la sync. Les ventes intermédiaires
        // (entre comptage et sync) ne doivent pas amplifier l'écart — elles
        // sont déjà comptabilisées normalement.
        // IMPORTANT : on réconcilie MÊME si la pièce a disparu de Traction
        // (radiée), avec stock_apres_sync=null, pour ne plus laisser le comptage
        // bloqué en 'en_attente' éternel et perdre l'écart d'inventaire.
        const ecartReconcilie = Number(c.qte_comptee || 0) - Number(c.qte_systeme || 0)
        await supabaseAdmin.from('inventaire_comptages').update({
          stock_apres_sync: s ? s.stock : null,
          ecart_reconcilie: ecartReconcilie,
          date_reconciliation: now.toISOString(),
          statut: 'reconcilie'
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

// ═══════════════════════════════════════════════════════════════════════
// Journal des réceptions (module Rotation & Fournisseurs)
// ═══════════════════════════════════════════════════════════════════════

interface ReceptionDetectee {
  pk: string
  info: { stock: number; qtyTotal: number; idF: string; nomF: string; ligne: string; cost: number; desc: string }
  diff: number
  avant: number
  apres: number
}

/**
 * Écrit chaque entrée de stock détectée dans sc_receptions et évalue les quatre
 * déclencheurs d'alerte (couverture après réception, valeur en dollars, multiple
 * du lot économique de Wilson, pièce sans historique de vente).
 *
 * Deux subtilités :
 *
 *  1. Le sync tourne 2×/jour. Deux réceptions du même code le même jour doivent
 *     s'ADDITIONNER, pas s'écraser : on relit la ligne du jour et on cumule
 *     avant de réévaluer l'alerte sur le total.
 *
 *  2. La demande est calculée sur les mois RÉELLEMENT importés de la fenêtre
 *     (historique_ventes a des trous), en réutilisant la liste de mois du
 *     dernier run d'analyse pour rester cohérent avec l'onglet.
 */
async function enregistrerReceptions(
  receptions: ReceptionDetectee[],
  todayStr: string,
): Promise<{ total: number; alertes: number }> {
  if (receptions.length === 0) return { total: 0, alertes: 0 }

  const { chargerConfig, dernierRun } = await import('@/lib/supply-chain-db')
  const { evaluerReception, fenetreMois, moisPrecedent } = await import('@/lib/supply-chain')

  const cfg = await chargerConfig()
  const run = await dernierRun()

  // Les lignes écartées du module (AMA…) n'ont pas à générer d'alerte : leurs
  // ventes passent par Amazon, donc la demande calculée ici serait nulle et
  // CHAQUE réception ressortirait en « pièce sans vente ».
  const exclues = new Set((cfg.lignes_hors_perimetre || []).map(l => l.trim().toUpperCase()))
  receptions = receptions.filter(r => !exclues.has(String(r.info.ligne || '').toUpperCase()))
  if (receptions.length === 0) return { total: 0, alertes: 0 }

  const moisFin = run?.kpis?.mois_fin || moisPrecedent(new Date())
  const fenetre = fenetreMois(moisFin, 12)
  // Mois réellement importés : sans cette liste on diviserait par 12 alors que
  // seuls 7 mois sont chargés, et la demande serait sous-évaluée de moitié.
  const moisPresents: string[] = Array.isArray(run?.kpis?.mois_presents) && run.kpis.mois_presents.length > 0
    ? run.kpis.mois_presents
    : fenetre
  const nbMois = Math.max(1, moisPresents.length)

  // Ventes de la fenêtre pour les seuls codes reçus.
  const codes = receptions.map(r => r.pk)
  const ventes = new Map<string, number>()
  for (let i = 0; i < codes.length; i += 200) {
    const { data } = await supabaseAdmin
      .from('historique_ventes').select('code_piece, quantite, mois')
      .in('code_piece', codes.slice(i, i + 200))
      .gte('mois', fenetre[0]).lte('mois', moisFin)
    for (const v of data || []) {
      ventes.set(v.code_piece, (ventes.get(v.code_piece) || 0) + (Number(v.quantite) || 0))
    }
  }

  // Réceptions déjà enregistrées aujourd'hui pour ces codes (2e passage du jour).
  const dejaAuj = new Map<string, any>()
  for (let i = 0; i < codes.length; i += 200) {
    const { data } = await supabaseAdmin
      .from('sc_receptions').select('*')
      .eq('date_reception', todayStr)
      .in('code_piece', codes.slice(i, i + 200))
    for (const r of data || []) dejaAuj.set(r.code_piece, r)
  }

  const rows: any[] = []
  let alertes = 0

  for (const r of receptions) {
    const precedent = dejaAuj.get(r.pk)
    const qteRecue = r.diff + (precedent ? Number(precedent.qte_recue) || 0 : 0)
    const stockAvant = precedent ? Number(precedent.stock_avant) : r.avant
    const stockApres = r.apres

    const cout = Number(r.info.cost) || 0
    const ventes12 = ventes.get(r.pk) || 0
    const demandeMens = ventes12 / nbMois

    // Wilson : Q* = √(2·D·S/H), H = taux de possession × coût unitaire.
    const D = demandeMens * 12
    const H = cfg.taux_possession * cout
    let eoq = 0
    if (D > 0 && H > 0) eoq = Math.max(1, Math.round(Math.min(Math.sqrt((2 * D * cfg.cout_commande) / H), D)))

    const ev = evaluerReception({
      qteRecue, coutUnitaire: cout, stockAvant, stockApres,
      demandeMens, aVenduSur12m: ventes12 > 0, eoq, cfg,
    })
    if (ev.alerte) alertes++

    rows.push({
      date_reception: todayStr,
      code_piece: r.pk,
      description: r.info.desc || null,
      fournisseur: r.info.nomF || 'Non assigné',
      code_ligne: r.info.ligne || 'N/A',
      qte_recue: qteRecue,
      cout_unitaire: cout,
      valeur: qteRecue * cout,
      stock_avant: stockAvant,
      stock_apres: stockApres,
      demande_mens: demandeMens,
      couverture_avant: ev.couverture_avant,
      couverture_apres: ev.couverture_apres,
      eoq,
      alerte: ev.alerte,
      severite: ev.severite,
      motifs: ev.motifs,
      exces_unites: ev.exces_unites,
      exces_valeur: ev.exces_valeur,
      // Une réception déjà traitée par un humain garde son statut : le 2e sync
      // du jour ne doit pas remettre à « nouveau » ce qui vient d'être justifié.
      statut: precedent?.statut && precedent.statut !== 'nouveau' ? precedent.statut : 'nouveau',
      vu_le: precedent?.vu_le || null,
      vu_par: precedent?.vu_par || null,
      commentaire: precedent?.commentaire || null,
    })
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin
      .from('sc_receptions')
      .upsert(rows.slice(i, i + 500), { onConflict: 'date_reception,code_piece' })
    if (error) throw new Error(error.message)
  }

  return { total: rows.length, alertes }
}
