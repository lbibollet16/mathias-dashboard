import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — compare le dernier snapshot FBA Amazon avec le stock Traction
// (toutes lignes AMA/FBA/FBM confondues, somme par pk_code) et retourne
// les écarts.
export async function GET(req: NextRequest) {
  try {
    const mode = req.nextUrl.searchParams.get('mode') || 'latest'

    // 1) Trouver le snapshot_date le plus récent
    const { data: snapshots } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const latestDate = snapshots && snapshots[0]?.snapshot_date

    if (!latestDate) {
      return NextResponse.json({
        snapshot_date: null,
        rows: [],
        totals: { nb_total: 0, nb_ecart: 0, nb_ok: 0, valeur_ecart_abs: 0, valeur_ecart_net: 0 },
        message: 'Aucun snapshot FBA importé',
      })
    }

    // 2) Charger le snapshot complet (paginé)
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

    // 3) Charger tous les PKCodes concernés depuis traction_amazon_lignes
    //    (agréger QTY par pk_code car une même pièce peut avoir plusieurs
    //    fournisseurs et plusieurs lignes AMA/FBA/FBM)
    const tractionCodes = Array.from(new Set(fbaRows.map(r => r.traction_code).filter(Boolean)))
    const tractionStock = new Map<string, { qty: number; qty_dispo: number; coutant: number; desc: string | null }>()
    if (tractionCodes.length > 0) {
      const BATCH = 500
      for (let i = 0; i < tractionCodes.length; i += BATCH) {
        const batch = tractionCodes.slice(i, i + BATCH)
        const { data: tData } = await supabaseAdmin
          .from('traction_amazon_lignes')
          .select('pk_code, qty, qty_minus_reserved, prix_coutant, desc_fra, code_ligne')
          .in('pk_code', batch)
        for (const t of tData || []) {
          const existing = tractionStock.get(t.pk_code) || { qty: 0, qty_dispo: 0, coutant: 0, desc: null }
          existing.qty += Number(t.qty || 0)
          existing.qty_dispo += Number(t.qty_minus_reserved || 0)
          // Garder le premier coutant non-nul
          if (existing.coutant === 0 && Number(t.prix_coutant || 0) > 0) existing.coutant = Number(t.prix_coutant)
          if (!existing.desc && t.desc_fra) existing.desc = t.desc_fra
          tractionStock.set(t.pk_code, existing)
        }
      }
    }

    // 4) Pour chaque ligne FBA, calculer l'écart
    //    amazon_qty = afn_fulfillable + afn_inbound (ce qui est chez Amazon ou en route)
    //    traction_qty = qty_minus_reserved cumulé sur toutes les lignes AMA/FBA/FBM
    //    ecart = amazon_qty - traction_qty
    //      > 0  ⇒ Amazon a plus que ce que dit Traction (Traction sous-déclaré)
    //      < 0  ⇒ Amazon a moins que ce que dit Traction (manque chez Amazon, à investiguer)
    const rows = fbaRows.map((f: any) => {
      const amazonFulfillable = Number(f.afn_fulfillable_quantity || 0)
      const amazonInbound = Number(f.afn_inbound_working_quantity || 0) + Number(f.afn_inbound_shipped_quantity || 0) + Number(f.afn_inbound_receiving_quantity || 0)
      const amazonReserved = Number(f.afn_reserved_quantity || 0)
      const amazonUnsellable = Number(f.afn_unsellable_quantity || 0)
      const amazonTotal = Number(f.afn_total_quantity || 0)
      const amazonDispo = amazonFulfillable + amazonInbound + amazonReserved

      const traction = f.traction_code ? tractionStock.get(f.traction_code) : null
      const tractionQty = traction?.qty_dispo || 0
      const tractionTotal = traction?.qty || 0
      const coutant = traction?.coutant || Number(f.your_price || 0)
      const desc = traction?.desc || f.product_name || null

      const ecart = amazonDispo - tractionQty
      const valeurEcart = ecart * (coutant || 0)

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
        traction_qty: tractionQty,
        traction_total: tractionTotal,
        coutant,
        ecart,
        valeur_ecart: valeurEcart,
      }
    })

    // 5) Tri par valeur absolue de l'écart en valeur $ (le plus coûteux d'abord)
    rows.sort((a, b) => Math.abs(b.valeur_ecart) - Math.abs(a.valeur_ecart))

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

    return NextResponse.json({
      snapshot_date: latestDate,
      rows,
      totals,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
