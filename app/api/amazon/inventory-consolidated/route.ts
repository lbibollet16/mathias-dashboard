import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant, Location } from '@/lib/amazon-inventory'

// GET — vue consolidée par "base product":
//   - regroupe toutes les variantes Traction HUB/FBA/FBM/sans-préfixe
//     d'un même produit
//   - joint avec le dernier snapshot FBA Amazon pour montrer "réalité Amazon"
//   - flag les oublis (pièces sur code_ligne AMA/FBA/FBM sans préfixe)
//   - classe les écarts pour révélateur audit

export async function GET(req: NextRequest) {
  try {
    const search = (req.nextUrl.searchParams.get('search') || '').trim().toLowerCase()

    // 1) Charger TOUTES les lignes Traction AMA/FBA/FBM (paginé)
    const tractionRows: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, pk_fournisseur, code_ligne, qty, qty_minus_reserved, prix_coutant, desc_fra')
        .in('code_ligne', ['AMA', 'FBA', 'FBM'])
        .range(from, from + 999)
      if (error) throw error
      tractionRows.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // 2) Dernier snapshot FBA Amazon
    const { data: snapshotDates } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const latestSnapshot = snapshotDates && snapshotDates[0]?.snapshot_date

    const fbaRows: any[] = []
    if (latestSnapshot) {
      let f = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, afn_fulfillable_quantity, afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity, afn_reserved_quantity, afn_unsellable_quantity, mfn_fulfillable_quantity, product_name, your_price, traction_code')
          .eq('snapshot_date', latestSnapshot)
          .range(f, f + 999)
        if (!data) break
        fbaRows.push(...data)
        if (data.length < 1000) break
        f += 1000
      }
    }

    // 3) Indexer les données Amazon FBA par traction_code (après résolution)
    //    Pour les SKU avec traction_code connu, on peut les lier à la base
    const amazonByBase = new Map<string, {
      afn_fulfillable: number; afn_inbound: number; afn_reserved: number;
      afn_unsellable: number; mfn_fulfillable: number;
      amazon_sku: string; asin_product_name: string | null; your_price: number;
    }>()
    for (const f of fbaRows) {
      // Résoudre le base code: utiliser traction_code si dispo, sinon parser le sku Amazon
      let base: string
      if (f.traction_code) {
        base = detectVariant(f.traction_code).base
      } else {
        base = detectVariant(f.sku).base
      }
      if (!base) continue
      const ex = amazonByBase.get(base) || {
        afn_fulfillable: 0, afn_inbound: 0, afn_reserved: 0,
        afn_unsellable: 0, mfn_fulfillable: 0,
        amazon_sku: f.sku, asin_product_name: f.product_name, your_price: Number(f.your_price || 0),
      }
      ex.afn_fulfillable += Number(f.afn_fulfillable_quantity || 0)
      ex.afn_inbound += Number(f.afn_inbound_working_quantity || 0) + Number(f.afn_inbound_shipped_quantity || 0) + Number(f.afn_inbound_receiving_quantity || 0)
      ex.afn_reserved += Number(f.afn_reserved_quantity || 0)
      ex.afn_unsellable += Number(f.afn_unsellable_quantity || 0)
      ex.mfn_fulfillable += Number(f.mfn_fulfillable_quantity || 0)
      amazonByBase.set(base, ex)
    }

    // 4) Grouper les variantes Traction par base code
    type VariantDetail = {
      pk_code: string
      pk_fournisseur: string
      code_ligne: string
      location: Location
      qty: number
      qty_dispo: number
      prix_coutant: number
      desc_fra: string | null
    }
    type BaseProduct = {
      base: string
      description: string | null
      coutant: number
      // Quantités Traction par location
      hub_qty: number
      fba_qty_traction: number
      fbm_qty_traction: number
      sans_prefix_qty: number
      traction_total: number
      // Quantités Amazon (snapshot)
      fba_qty_amazon: number
      fba_inbound: number
      fba_reserved: number
      fba_unsellable: number
      fbm_qty_amazon: number
      // Écarts
      ecart_fba: number
      ecart_fbm: number
      valeur_ecart_fba: number
      valeur_ecart_fbm: number
      // Liste détaillée des variants
      variants: VariantDetail[]
      has_oubli: boolean
      // Alerts
      action: string
    }
    const products = new Map<string, BaseProduct>()

    for (const t of tractionRows) {
      const v = detectVariant(t.pk_code)
      const qtyDispo = Number(t.qty_minus_reserved || 0)
      const qty = Number(t.qty || 0)
      if (!products.has(v.base)) {
        products.set(v.base, {
          base: v.base,
          description: t.desc_fra || null,
          coutant: Number(t.prix_coutant || 0),
          hub_qty: 0,
          fba_qty_traction: 0,
          fbm_qty_traction: 0,
          sans_prefix_qty: 0,
          traction_total: 0,
          fba_qty_amazon: 0,
          fba_inbound: 0,
          fba_reserved: 0,
          fba_unsellable: 0,
          fbm_qty_amazon: 0,
          ecart_fba: 0,
          ecart_fbm: 0,
          valeur_ecart_fba: 0,
          valeur_ecart_fbm: 0,
          variants: [],
          has_oubli: false,
          action: 'ok',
        })
      }
      const p = products.get(v.base)!
      if (!p.description && t.desc_fra) p.description = t.desc_fra
      if (p.coutant === 0 && Number(t.prix_coutant || 0) > 0) p.coutant = Number(t.prix_coutant)

      if (v.location === 'HUB')          p.hub_qty += qtyDispo
      else if (v.location === 'FBA')     p.fba_qty_traction += qtyDispo
      else if (v.location === 'FBM')     p.fbm_qty_traction += qtyDispo
      else {
        p.sans_prefix_qty += qtyDispo
        if (qty !== 0) p.has_oubli = true
      }
      p.traction_total += qtyDispo

      p.variants.push({
        pk_code: t.pk_code,
        pk_fournisseur: t.pk_fournisseur,
        code_ligne: t.code_ligne,
        location: v.location,
        qty,
        qty_dispo: qtyDispo,
        prix_coutant: Number(t.prix_coutant || 0),
        desc_fra: t.desc_fra,
      })
    }

    // 5) Joindre les données Amazon (via base code)
    for (const [base, p] of products) {
      const amz = amazonByBase.get(base)
      if (amz) {
        p.fba_qty_amazon = amz.afn_fulfillable + amz.afn_inbound + amz.afn_reserved
        p.fba_inbound = amz.afn_inbound
        p.fba_reserved = amz.afn_reserved
        p.fba_unsellable = amz.afn_unsellable
        p.fbm_qty_amazon = amz.mfn_fulfillable
        if (!p.description && amz.asin_product_name) p.description = amz.asin_product_name
        if (p.coutant === 0 && amz.your_price > 0) p.coutant = amz.your_price
      }
      p.ecart_fba = p.fba_qty_amazon - p.fba_qty_traction
      p.ecart_fbm = p.fbm_qty_amazon - p.fbm_qty_traction
      p.valeur_ecart_fba = p.ecart_fba * p.coutant
      p.valeur_ecart_fbm = p.ecart_fbm * p.coutant

      // Catégorisation d'action
      if (p.fba_unsellable > 0) p.action = 'unsellable'
      else if (p.has_oubli) p.action = 'oubli_sans_prefixe'
      else if (Math.abs(p.ecart_fba) > 0) p.action = p.ecart_fba > 0 ? 'ajuster_traction_fba' : 'reclamation_fba'
      else if (Math.abs(p.ecart_fbm) > 0) p.action = p.ecart_fbm > 0 ? 'ajuster_traction_fbm' : 'ecart_fbm'
      else if (p.traction_total === 0 && p.fba_qty_amazon === 0 && p.fbm_qty_amazon === 0) p.action = 'empty'
      else p.action = 'ok'
    }

    // 6) Filtrer selon recherche
    let results = Array.from(products.values())
    if (search) {
      results = results.filter(p => {
        if (p.base.toLowerCase().includes(search)) return true
        if (p.description && p.description.toLowerCase().includes(search)) return true
        return p.variants.some(v => v.pk_code.toLowerCase().includes(search))
      })
    }

    // 7) Tri : actions critiques en premier puis par valeur écart
    const actionPrio: Record<string, number> = {
      unsellable: 100, oubli_sans_prefixe: 90, reclamation_fba: 80,
      ajuster_traction_fba: 70, ecart_fbm: 60, ajuster_traction_fbm: 50,
      ok: 10, empty: 0,
    }
    results.sort((a, b) => {
      const pa = actionPrio[a.action] || 0
      const pb = actionPrio[b.action] || 0
      if (pa !== pb) return pb - pa
      return Math.abs(b.valeur_ecart_fba) + Math.abs(b.valeur_ecart_fbm) - (Math.abs(a.valeur_ecart_fba) + Math.abs(a.valeur_ecart_fbm))
    })

    // 8) Totaux
    const totals = {
      nb_base_products: results.length,
      nb_oublis: results.filter(r => r.has_oubli).length,
      nb_ecart_fba: results.filter(r => r.ecart_fba !== 0).length,
      nb_ecart_fbm: results.filter(r => r.ecart_fbm !== 0).length,
      total_hub: results.reduce((a, r) => a + r.hub_qty, 0),
      total_fba_traction: results.reduce((a, r) => a + r.fba_qty_traction, 0),
      total_fbm_traction: results.reduce((a, r) => a + r.fbm_qty_traction, 0),
      total_sans_prefix: results.reduce((a, r) => a + r.sans_prefix_qty, 0),
      total_traction: results.reduce((a, r) => a + r.traction_total, 0),
      total_fba_amazon: results.reduce((a, r) => a + r.fba_qty_amazon, 0),
      total_fbm_amazon: results.reduce((a, r) => a + r.fbm_qty_amazon, 0),
      valeur_ecart_fba_abs: results.reduce((a, r) => a + Math.abs(r.valeur_ecart_fba), 0),
      valeur_ecart_fbm_abs: results.reduce((a, r) => a + Math.abs(r.valeur_ecart_fbm), 0),
    }

    return NextResponse.json({
      snapshot_date: latestSnapshot,
      products: results,
      totals,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
