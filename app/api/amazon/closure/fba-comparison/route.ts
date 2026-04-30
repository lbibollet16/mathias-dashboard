import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant } from '@/lib/amazon-inventory'
import { loadManualMappings, distributeToBases } from '@/lib/amazon-mapping'

// GET /api/amazon/closure/fba-comparison?id=XXX
//
// Audit FBA automatique : compare ce qu'Amazon dit avoir physiquement
// (snapshot FBA Inventory le plus récent ≤ settlement_end) avec ce que
// Traction LAUTOPAK dit avoir au FBA (somme des pk_codes FBA-xxx).
//
// Pas de comptage manuel — Amazon est la source de vérité physique.
// Tout écart > 1 unité = à réclamer Amazon.

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

  try {
    const { data: s } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end')
      .eq('settlement_id', id)
      .maybeSingle()
    if (!s) return NextResponse.json({ erreur: 'Settlement introuvable' }, { status: 404 })

    const endDate = s.settlement_end ? String(s.settlement_end).split('T')[0] : null
    if (!endDate) return NextResponse.json({ erreur: 'settlement_end manquant' }, { status: 400 })

    // 1) Dernier snapshot FBA ≤ settlement_end
    const { data: snapDates } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .lte('snapshot_date', endDate)
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const snapshotDate = snapDates && snapDates[0]?.snapshot_date
    if (!snapshotDate) {
      return NextResponse.json({
        settlement_id: s.settlement_id,
        snapshot_date: null,
        erreur_avertissement: 'Aucun snapshot FBA Inventory disponible. Importe-en un.',
        ecarts: [],
      })
    }

    // 2) Snapshot FBA Amazon (qty totale par SKU)
    const fbaAmzRows: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('sku, fnsku, product_name, your_price, traction_code, afn_fulfillable_quantity, afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity, afn_reserved_quantity, afn_unsellable_quantity')
        .eq('snapshot_date', snapshotDate)
        .range(from, from + 999)
      if (error) throw error
      fbaAmzRows.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // 3) Distribution des qty Amazon vers les pk_codes Traction (avec multipliers)
    const manualMappings = await loadManualMappings()
    const fbaAmzByPk = new Map<string, { qty: number; sku: string; product_name: string | null; your_price: number }>()
    for (const r of fbaAmzRows) {
      const totalAmazon = Number(r.afn_fulfillable_quantity || 0)
        + Number(r.afn_inbound_working_quantity || 0)
        + Number(r.afn_inbound_shipped_quantity || 0)
        + Number(r.afn_inbound_receiving_quantity || 0)
        + Number(r.afn_reserved_quantity || 0)
      if (totalAmazon === 0) continue
      const dist = distributeToBases(r.sku, r.traction_code, totalAmazon, manualMappings)
      for (const d of dist) {
        if (!d.base) continue
        // Le pk_code Traction correspondant à FBA est "FBA-{base}"
        const pk = `FBA-${d.base}`
        const ex = fbaAmzByPk.get(pk) || { qty: 0, sku: r.sku, product_name: r.product_name, your_price: Number(r.your_price || 0) }
        ex.qty += d.physical_qty
        if (!ex.product_name && r.product_name) ex.product_name = r.product_name
        fbaAmzByPk.set(pk, ex)
      }
    }

    // 4) Stock FBA Traction (somme par pk_code)
    const tractionRows: any[] = []
    let f = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, qty_minus_reserved, prix_coutant, desc_fra')
        .eq('code_ligne', 'AMA')
        .range(f, f + 999)
      if (error) throw error
      tractionRows.push(...(data || []))
      if (!data || data.length < 1000) break
      f += 1000
    }
    const fbaTractionByPk = new Map<string, { qty: number; coutant: number; desc: string | null }>()
    for (const t of tractionRows) {
      const v = detectVariant(t.pk_code)
      if (v.location !== 'FBA') continue
      const pk = `FBA-${v.base}`
      const ex = fbaTractionByPk.get(pk) || { qty: 0, coutant: 0, desc: null }
      ex.qty += Number(t.qty_minus_reserved || 0)
      if (ex.coutant === 0 && Number(t.prix_coutant || 0) > 0) ex.coutant = Number(t.prix_coutant)
      if (!ex.desc && t.desc_fra) ex.desc = t.desc_fra
      fbaTractionByPk.set(pk, ex)
    }

    // 5) Croisement et calcul des écarts
    const allPks = new Set([...fbaAmzByPk.keys(), ...fbaTractionByPk.keys()])
    const ecarts: any[] = []
    let totalEcartUnits = 0
    let totalEcartValeurAbs = 0
    for (const pk of allPks) {
      const amz = fbaAmzByPk.get(pk)
      const trc = fbaTractionByPk.get(pk)
      const qtyAmz = amz?.qty || 0
      const qtyTrc = trc?.qty || 0
      const ecartUnits = qtyAmz - qtyTrc                // + = Amazon dit avoir plus que Traction (probable mauvais sync ou pack splitting)
                                                          // − = Amazon dit avoir moins (perte/dommage non encore reimbursé)
      if (Math.abs(ecartUnits) <= 1) continue           // tolérance 1 u (arrondi packs/splitting)
      const coutant = trc?.coutant || amz?.your_price || 0
      const valeurEcart = Number((ecartUnits * coutant).toFixed(2))
      totalEcartUnits += Math.abs(ecartUnits)
      totalEcartValeurAbs += Math.abs(valeurEcart)
      ecarts.push({
        pk_code: pk,
        sku_amazon: amz?.sku || null,
        product_name: amz?.product_name || trc?.desc || null,
        qty_amazon: qtyAmz,
        qty_traction: qtyTrc,
        ecart_units: ecartUnits,
        coutant,
        valeur_ecart: valeurEcart,
        action_recommandee: ecartUnits < 0 ? 'Réclamer Amazon (manque de stock)' : 'Vérifier Traction (surplus, possible pack non-mappé)',
      })
    }
    ecarts.sort((a, b) => Math.abs(b.valeur_ecart) - Math.abs(a.valeur_ecart))

    return NextResponse.json({
      settlement_id: s.settlement_id,
      snapshot_date: snapshotDate,
      nb_pk_codes_compares: allPks.size,
      nb_ecarts: ecarts.length,
      total_ecart_units_abs: totalEcartUnits,
      total_ecart_valeur_abs: totalEcartValeurAbs,
      ecarts,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
