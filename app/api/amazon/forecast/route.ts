import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { loadManualMappings } from '@/lib/amazon-mapping'
import { detectVariant } from '@/lib/amazon-inventory'

// GET /api/amazon/forecast
// Calcule un prévisionnel de vente par PKCode basé sur l'historique des
// settlements importés. Plus il y a d'historique, plus le calcul est fiable.
//
// Méthode :
//   1. Pour chaque PKCode : compter les ventes (Order Principal qty) par
//      settlement, en appliquant les multi-mappings (× multiplier).
//   2. Calculer la durée totale d'historique en jours.
//   3. Vente moyenne par jour = total ventes historique / nb jours.
//   4. Prévision 30/60/90 jours = vente moyenne × 30/60/90.
//   5. Niveau de confiance :
//        - low    : < 30 jours d'historique
//        - medium : 30-90 jours
//        - high   : 90+ jours (~3 mois)
//        - very-high : 180+ jours (saisonnalité possible)
//
// Pour la saisonnalité (à venir quand 12+ mois d'historique), on pourra
// ajuster avec le multiplicateur du même mois l'année dernière.

export async function GET(req: NextRequest) {
  const pkCodeFiltre = req.nextUrl.searchParams.get('pk_code')

  try {
    // Charger les settlements (les plus récents en premier)
    const { data: settlements } = await supabaseAdmin
      .from('amazon_settlements')
      .select('settlement_id, settlement_start, settlement_end')
      .order('settlement_end', { ascending: false })
      .limit(20)
    if (!settlements || settlements.length === 0) {
      return NextResponse.json({
        nb_settlements: 0,
        jours_historique: 0,
        confiance: 'aucune',
        message: 'Aucun settlement importé. Importe au moins 1 settlement pour avoir un prévisionnel.',
        lignes: [],
      })
    }

    // Calculer la fenêtre temporelle
    const dates = settlements.map((s: any) => ({
      start: s.settlement_start ? new Date(s.settlement_start) : null,
      end: s.settlement_end ? new Date(s.settlement_end) : null,
    })).filter(d => d.start && d.end)
    const minDate = new Date(Math.min(...dates.map(d => d.start!.getTime())))
    const maxDate = new Date(Math.max(...dates.map(d => d.end!.getTime())))
    const joursHistorique = Math.max(1, Math.round((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)))

    // Niveau de confiance
    let confiance: string
    if (joursHistorique < 30) confiance = 'low'
    else if (joursHistorique < 90) confiance = 'medium'
    else if (joursHistorique < 180) confiance = 'high'
    else confiance = 'very-high'

    // Charger toutes les Order Principal de ces settlements
    const settlementIds = settlements.map((s: any) => s.settlement_id)
    const tx: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_transactions')
        .select('settlement_id, sku, traction_code, quantity_purchased, amount, posted_date')
        .in('settlement_id', settlementIds)
        .eq('transaction_type', 'Order')
        .eq('amount_description', 'Principal')
        .range(from, from + 999)
      if (error) throw error
      tx.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // Agréger par PKCode
    const manualMappings = await loadManualMappings()
    function resolvePk(sku: string, tc: string | null): { pk_code: string; multiplier: number } {
      const manual = manualMappings.get(sku)
      if (manual && manual.length > 0) return { pk_code: manual[0].pk_code, multiplier: manual[0].multiplier }
      return { pk_code: tc || sku, multiplier: 1 }
    }

    interface AggPk {
      pk_code: string
      qty_total: number              // qty Traction physique (avec multiplier)
      revenu_total: number
      ventes_par_settlement: Map<string, number>  // pour la stabilité
      product_name: string | null
    }
    const byPk = new Map<string, AggPk>()
    for (const t of tx) {
      if (!t.sku) continue
      const { pk_code, multiplier } = resolvePk(t.sku, t.traction_code || null)
      if (pkCodeFiltre && pk_code !== pkCodeFiltre) continue
      let ex = byPk.get(pk_code)
      if (!ex) {
        ex = { pk_code, qty_total: 0, revenu_total: 0, ventes_par_settlement: new Map(), product_name: null }
        byPk.set(pk_code, ex)
      }
      const qtyAmz = Number(t.quantity_purchased || 0)
      const qtyPhy = qtyAmz * multiplier
      ex.qty_total += qtyPhy
      ex.revenu_total += Number(t.amount || 0)
      ex.ventes_par_settlement.set(t.settlement_id, (ex.ventes_par_settlement.get(t.settlement_id) || 0) + qtyPhy)
    }

    // Compléter avec les noms produit + coutant
    const allPks = [...byPk.keys()]
    if (allPks.length > 0) {
      // Charger descriptions Traction
      const { data: tract } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, desc_fra')
        .in('pk_code', allPks)
      for (const r of tract || []) {
        const ex = byPk.get(r.pk_code)
        if (ex && !ex.product_name && r.desc_fra) ex.product_name = r.desc_fra
      }
      // Fallback FBA inventory product_name (par traction_code matchant)
      const { data: fbaInv } = await supabaseAdmin
        .from('amazon_fba_inventory')
        .select('traction_code, product_name')
        .in('traction_code', allPks)
        .limit(allPks.length * 2)
      for (const r of fbaInv || []) {
        const ex = byPk.get(r.traction_code)
        if (ex && !ex.product_name && r.product_name) ex.product_name = r.product_name
      }
    }

    // Calcul prévisionnel
    const lignes = [...byPk.values()].map(p => {
      const venteParJour = p.qty_total / joursHistorique
      const stabilite = (() => {
        // Coefficient de variation des ventes entre settlements (lower = plus stable)
        const vals = [...p.ventes_par_settlement.values()]
        if (vals.length < 2) return null
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length
        if (mean === 0) return null
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
        const stddev = Math.sqrt(variance)
        return Number((stddev / mean).toFixed(2))
      })()
      return {
        pk_code: p.pk_code,
        product_name: p.product_name,
        qty_historique: p.qty_total,
        revenu_historique: Number(p.revenu_total.toFixed(2)),
        nb_settlements_avec_ventes: p.ventes_par_settlement.size,
        vente_moy_par_jour: Number(venteParJour.toFixed(2)),
        prevision_30j: Math.round(venteParJour * 30),
        prevision_60j: Math.round(venteParJour * 60),
        prevision_90j: Math.round(venteParJour * 90),
        coefficient_variation: stabilite,    // null si <2 settlements
      }
    }).sort((a, b) => b.prevision_30j - a.prevision_30j)

    return NextResponse.json({
      nb_settlements: settlements.length,
      jours_historique: joursHistorique,
      periode: { debut: minDate.toISOString(), fin: maxDate.toISOString() },
      confiance,
      lignes,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
