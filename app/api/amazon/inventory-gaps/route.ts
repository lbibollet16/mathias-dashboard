import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant } from '@/lib/amazon-inventory'

// Retourne un "wide base" qui regroupe A2883424 + 2883424 + FBA-2883424 + HUB-2883424
// sous la même clé logique "2883424". Utilisé pour la somme Traction par produit.
function wideBase(code: string | null | undefined): string {
  if (!code) return ''
  const narrow = detectVariant(code).base
  // Strip un "A" ou "a" en tête uniquement si suivi de chiffres (convention master Amazon)
  const m = /^[Aa](\d.*)$/.exec(narrow)
  return m ? m[1] : narrow
}

// GET — dashboard complet des écarts d'inventaire FBA ↔ Traction
//
// Données exploitées dans le fichier FBA Amazon:
//   afn-fulfillable-quantity   : vendable
//   afn-inbound-*              : en transit vers Amazon (3 états)
//   afn-reserved-quantity      : réservé pour commandes en cours
//   afn-unsellable-quantity    : endommagé chez Amazon (à claim)
//   afn-researching-quantity   : Amazon enquête (perdu présumé)
//   mfn-fulfillable-quantity   : stock FBM déclaré à Amazon (chez toi)
//   your-price                 : prix Amazon (fallback pour valorisation)
//
// Traction:
//   Agrégé par PKCode sur code_ligne IN (AMA, FBA, FBM) → tous fournisseurs
//   confondus. Pour FBM on compare séparément ligne FBM uniquement.
//
// Catégorisation de l'action suggérée par SKU:
//   'unsellable'    → demander removal ou reimbursement
//   'researching'   → Amazon enquête, attendre
//   'rupture_fba'   → stock FBA épuisé mais Traction > 0 (à réapprovisionner)
//   'reclamation'   → FBA dispo nettement < Traction (possible réclamation)
//   'ajust_traction'→ FBA dispo > Traction (Traction sous-déclare)
//   'ok'            → pas d'écart significatif

export async function GET(_req: NextRequest) {
  try {
    // 1) Snapshot le plus récent
    const { data: snapshots } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(50)

    const uniqueDates = Array.from(new Set((snapshots || []).map((s: any) => s.snapshot_date)))
    const latestDate = uniqueDates[0]
    const previousDate = uniqueDates[1] || null

    if (!latestDate) {
      return NextResponse.json({
        snapshot_date: null,
        previous_snapshot_date: null,
        rows: [],
        totals: { nb_total: 0, nb_ecart: 0, nb_ok: 0, valeur_ecart_abs: 0, valeur_ecart_net: 0 },
        dashboard: null,
        history: null,
        message: 'Aucun snapshot FBA importé',
      })
    }

    // 2) Charger le snapshot complet
    const fbaRows: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('*')
        .eq('snapshot_date', latestDate)
        .range(from, from + 999)
      if (error) throw error
      fbaRows.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // 3) Stock Traction agrégé par WIDE BASE (regroupe toutes les variantes
    //    d'un même produit: A2883424 + 2883424 + FBA-2883424 + HUB-2883424).
    //    On charge TOUTES les lignes AMA pour construire l'index base → somme.
    const tractionBaseStock = new Map<string, {
      qty_dispo_ama: number; qty_fbm: number; qty_fba: number;
      coutant: number; desc: string | null;
      variants: { pk_code: string; code_ligne: string; qty_dispo: number }[];
    }>()
    {
      let from = 0
      while (true) {
        const { data, error } = await supabaseAdmin
          .from('traction_amazon_lignes')
          .select('pk_code, qty, qty_minus_reserved, prix_coutant, desc_fra, code_ligne')
          .in('code_ligne', ['AMA', 'FBA', 'FBM'])
          .range(from, from + 999)
        if (error) throw error
        for (const t of data || []) {
          const base = wideBase(t.pk_code)
          if (!base) continue
          const ex = tractionBaseStock.get(base) || {
            qty_dispo_ama: 0, qty_fbm: 0, qty_fba: 0,
            coutant: 0, desc: null, variants: [],
          }
          const qd = Number(t.qty_minus_reserved || 0)
          // User demande explicitement : stock Traction sur CodeLigne AMA
          if (t.code_ligne === 'AMA') ex.qty_dispo_ama += qd
          if (t.code_ligne === 'FBM') ex.qty_fbm += qd
          if (t.code_ligne === 'FBA') ex.qty_fba += qd
          if (ex.coutant === 0 && Number(t.prix_coutant || 0) > 0) ex.coutant = Number(t.prix_coutant)
          if (!ex.desc && t.desc_fra) ex.desc = t.desc_fra
          ex.variants.push({ pk_code: t.pk_code, code_ligne: t.code_ligne, qty_dispo: qd })
          tractionBaseStock.set(base, ex)
        }
        if (!data || data.length < 1000) break
        from += 1000
      }
    }

    // 3c) Multi-mappings manuels SKU → [{pk_code, multiplier}] (prioritaire sur wideBase auto)
    // multiplier = combien d'unités Traction pour 1 unité Amazon (packs).
    // Ex: FBM-78920-4 mappé à FBM-78920 × 4 → 40 Traction = 10 packs Amazon.
    const manualMap = new Map<string, { pk_code: string; multiplier: number }[]>()
    {
      const { data: mans } = await supabaseAdmin.from('amazon_sku_pkcodes').select('amazon_sku, pk_code, multiplier')
      for (const m of mans || []) {
        const list = manualMap.get(m.amazon_sku) || []
        list.push({ pk_code: m.pk_code, multiplier: Number(m.multiplier) > 0 ? Number(m.multiplier) : 1 })
        manualMap.set(m.amazon_sku, list)
      }
    }
    // Index des stocks AMA par pk_code exact (pour le lookup manuel)
    const pkStockAma = new Map<string, number>()
    {
      let from = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('traction_amazon_lignes')
          .select('pk_code, qty_minus_reserved')
          .eq('code_ligne', 'AMA')
          .range(from, from + 999)
        if (!data || data.length === 0) break
        for (const r of data) pkStockAma.set(r.pk_code, (pkStockAma.get(r.pk_code) || 0) + Number(r.qty_minus_reserved || 0))
        if (data.length < 1000) break
        from += 1000
      }
    }

    // 4) Watchlist
    const { data: watchData } = await supabaseAdmin.from('amazon_sku_watchlist').select('amazon_sku')
    const watchSet = new Set<string>((watchData || []).map((w: any) => w.amazon_sku))

    // 5) Construire les lignes enrichies
    const rows = fbaRows.map((f: any) => {
      const amazonFulfillable = Number(f.afn_fulfillable_quantity || 0)
      const amazonInboundWork = Number(f.afn_inbound_working_quantity || 0)
      const amazonInboundShip = Number(f.afn_inbound_shipped_quantity || 0)
      const amazonInboundRecv = Number(f.afn_inbound_receiving_quantity || 0)
      const amazonInbound = amazonInboundWork + amazonInboundShip + amazonInboundRecv
      const amazonReserved = Number(f.afn_reserved_quantity || 0)
      const amazonUnsellable = Number(f.afn_unsellable_quantity || 0)
      const amazonTotal = Number(f.afn_total_quantity || 0)
      const amazonDispo = amazonFulfillable + amazonInbound + amazonReserved
      const mfnFulfillable = Number(f.mfn_fulfillable_quantity || 0)
      // afn-researching non stocké en DB actuellement (sera 0), ignoré pour l'instant

      // Priorité 1 : mapping MANUEL (amazon_sku_pkcodes) → somme stock/multiplier
      // Priorité 2 : mapping AUTO via wideBase (retrocompat)
      const manualList = manualMap.get(f.sku)
      let tractionQty: number
      let tractionVariants: any[]
      let traction: any = null
      if (manualList && manualList.length > 0) {
        // Stock Amazon-équivalent = somme (stock pk_code / multiplier) arrondi inférieur
        tractionQty = Math.floor(manualList.reduce((s, m) => s + ((pkStockAma.get(m.pk_code) || 0) / m.multiplier), 0))
        tractionVariants = manualList.map(m => ({
          pk_code: m.pk_code, code_ligne: 'AMA',
          qty_dispo: pkStockAma.get(m.pk_code) || 0,
          multiplier: m.multiplier,
        }))
      } else {
        const lookupCode = f.traction_code || f.sku
        const base = wideBase(lookupCode)
        traction = base ? tractionBaseStock.get(base) : null
        tractionQty = traction?.qty_dispo_ama || 0
        tractionVariants = traction?.variants || []
      }
      const tractionTotal = tractionQty
      const tractionFbm = traction?.qty_fbm || 0
      const coutant = traction?.coutant || Number(f.your_price || 0)
      const desc = traction?.desc || f.product_name || null

      const ecart = amazonDispo - tractionQty
      const valeurEcart = ecart * (coutant || 0)
      const valeurUnsellable = amazonUnsellable * (coutant || 0)
      const ecartFbm = mfnFulfillable - tractionFbm
      const valeurEcartFbm = ecartFbm * (coutant || 0)

      // Catégorisation de l'action suggérée
      let action: string = 'ok'
      let priorite: number = 0
      if (amazonUnsellable > 0) {
        action = 'unsellable'
        priorite = 100 + valeurUnsellable  // priorité très haute
      } else if (amazonDispo === 0 && tractionQty > 0) {
        action = 'rupture_fba'
        priorite = 80 + (tractionQty * (coutant || 1))
      } else if (ecart < -0.5 && Math.abs(valeurEcart) >= 20) {
        action = 'reclamation'
        priorite = 60 + Math.abs(valeurEcart)
      } else if (ecart > 0.5 && Math.abs(valeurEcart) >= 20) {
        action = 'ajust_traction'
        priorite = 40 + Math.abs(valeurEcart)
      } else if (!f.traction_code) {
        action = 'non_mappe'
        priorite = 20
      }

      return {
        sku: f.sku,
        fnsku: f.fnsku,
        asin: f.asin,
        product_name: desc,
        traction_code: f.traction_code,
        amazon_fulfillable: amazonFulfillable,
        amazon_inbound: amazonInbound,
        amazon_reserved: amazonReserved,
        amazon_unsellable: amazonUnsellable,
        amazon_total: amazonTotal,
        amazon_dispo: amazonDispo,
        mfn_fulfillable: mfnFulfillable,
        traction_qty: tractionQty,
        traction_total: tractionTotal,
        traction_fbm: tractionFbm,
        traction_variants: tractionVariants,   // détail des pk_codes sommés sur AMA
        has_manual_mapping: !!(manualList && manualList.length > 0),
        manual_pk_codes: manualList ? manualList.map(m => `${m.pk_code}${m.multiplier > 1 ? `×${m.multiplier}` : ''}`) : null,
        coutant,
        your_price: Number(f.your_price || 0),
        ecart,
        valeur_ecart: valeurEcart,
        valeur_unsellable: valeurUnsellable,
        ecart_fbm: ecartFbm,
        valeur_ecart_fbm: valeurEcartFbm,
        action,
        priorite,
        is_watched: watchSet.has(f.sku),
      }
    })

    // 6) Tri par priorité décroissante puis valeur écart
    rows.sort((a, b) => b.priorite - a.priorite || Math.abs(b.valeur_ecart) - Math.abs(a.valeur_ecart))

    // 7) Totaux généraux
    const totals = {
      nb_total: rows.length,
      nb_ecart: rows.filter(r => r.ecart !== 0).length,
      nb_ok: rows.filter(r => r.ecart === 0).length,
      nb_non_mappes: rows.filter(r => !r.traction_code).length,
      valeur_ecart_abs: rows.reduce((a, r) => a + Math.abs(r.valeur_ecart), 0),
      valeur_ecart_net: rows.reduce((a, r) => a + r.valeur_ecart, 0),
      amazon_dispo_total: rows.reduce((a, r) => a + r.amazon_dispo, 0),
      traction_total: rows.reduce((a, r) => a + r.traction_qty, 0),
    }

    // 8) Dashboard summary
    const byAction = {
      unsellable: rows.filter(r => r.action === 'unsellable'),
      rupture_fba: rows.filter(r => r.action === 'rupture_fba'),
      reclamation: rows.filter(r => r.action === 'reclamation'),
      ajust_traction: rows.filter(r => r.action === 'ajust_traction'),
      non_mappe: rows.filter(r => r.action === 'non_mappe'),
      ok: rows.filter(r => r.action === 'ok'),
    }

    const valueFbaDispo = rows.reduce((a, r) => a + r.amazon_dispo * r.coutant, 0)
    const valueFbaUnsellable = rows.reduce((a, r) => a + r.valeur_unsellable, 0)
    const valueFbaInbound = rows.reduce((a, r) => a + r.amazon_inbound * r.coutant, 0)
    const valueTraction = rows.reduce((a, r) => a + r.traction_qty * r.coutant, 0)
    const deltaValue = valueFbaDispo - valueTraction

    const dashboard = {
      value_fba_dispo: valueFbaDispo,
      value_fba_unsellable: valueFbaUnsellable,
      value_fba_inbound: valueFbaInbound,
      value_traction: valueTraction,
      delta_value: deltaValue,
      total_fba_units: totals.amazon_dispo_total,
      total_inbound_units: rows.reduce((a, r) => a + r.amazon_inbound, 0),
      total_unsellable_units: rows.reduce((a, r) => a + r.amazon_unsellable, 0),
      total_traction_units: totals.traction_total,
      actions: {
        unsellable: { count: byAction.unsellable.length, value: byAction.unsellable.reduce((a, r) => a + r.valeur_unsellable, 0) },
        rupture_fba: { count: byAction.rupture_fba.length, value: byAction.rupture_fba.reduce((a, r) => a + r.traction_qty * r.coutant, 0) },
        reclamation: { count: byAction.reclamation.length, value: byAction.reclamation.reduce((a, r) => a + Math.abs(r.valeur_ecart), 0) },
        ajust_traction: { count: byAction.ajust_traction.length, value: byAction.ajust_traction.reduce((a, r) => a + Math.abs(r.valeur_ecart), 0) },
        non_mappe: { count: byAction.non_mappe.length, value: 0 },
        ok: { count: byAction.ok.length, value: 0 },
      },
      top_pertes: rows.filter(r => r.valeur_ecart < 0).slice(0, 5).map(r => ({
        sku: r.sku, traction_code: r.traction_code, product_name: r.product_name,
        amazon_dispo: r.amazon_dispo, traction_qty: r.traction_qty,
        ecart: r.ecart, valeur_ecart: r.valeur_ecart, action: r.action,
      })),
      top_gains: rows.filter(r => r.valeur_ecart > 0).slice(0, 5).map(r => ({
        sku: r.sku, traction_code: r.traction_code, product_name: r.product_name,
        amazon_dispo: r.amazon_dispo, traction_qty: r.traction_qty,
        ecart: r.ecart, valeur_ecart: r.valeur_ecart, action: r.action,
      })),
      watched_count: rows.filter(r => r.is_watched).length,
    }

    // 9) Historique (delta entre latest et previous snapshot)
    let history: any = null
    if (previousDate) {
      const prevRows: any[] = []
      let pf = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, afn_fulfillable_quantity, afn_total_quantity, afn_unsellable_quantity, your_price')
          .eq('snapshot_date', previousDate)
          .range(pf, pf + 999)
        if (!data) break
        prevRows.push(...data)
        if (data.length < 1000) break
        pf += 1000
      }
      const prevMap = new Map<string, any>()
      for (const p of prevRows) prevMap.set(p.sku, p)

      const deltas: any[] = []
      let delta_units = 0, delta_value = 0, nb_degraded = 0, nb_improved = 0
      for (const r of rows) {
        const prev = prevMap.get(r.sku)
        if (!prev) continue
        const prevFul = Number(prev.afn_fulfillable_quantity || 0)
        const diff = r.amazon_fulfillable - prevFul
        if (diff === 0) continue
        const valDiff = diff * r.coutant
        delta_units += diff
        delta_value += valDiff
        if (diff < 0) nb_degraded++
        else nb_improved++
        deltas.push({
          sku: r.sku, traction_code: r.traction_code,
          prev_qty: prevFul, current_qty: r.amazon_fulfillable,
          diff, value_diff: valDiff,
        })
      }
      deltas.sort((a, b) => Math.abs(b.value_diff) - Math.abs(a.value_diff))
      history = {
        previous_date: previousDate,
        delta_units,
        delta_value,
        nb_degraded,
        nb_improved,
        nb_changed: deltas.length,
        top_deltas: deltas.slice(0, 20),
      }
    }

    // Date de la dernière sync Traction (pour afficher la fraîcheur côté client)
    const { data: lastSyncRow } = await supabaseAdmin
      .from('traction_amazon_lignes')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
    const tractionSyncedAt = lastSyncRow && lastSyncRow[0]?.synced_at || null

    return NextResponse.json({
      snapshot_date: latestDate,
      previous_snapshot_date: previousDate,
      traction_synced_at: tractionSyncedAt,
      rows,
      totals,
      dashboard,
      history,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
