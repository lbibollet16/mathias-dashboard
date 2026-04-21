import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/scoa/dashboard?type=ps_neuf&type=ps_usage&date_debut=...&date_fin=...
//
// Retourne :
//   - totaux globaux (nb, prix moyen, profit moyen, attach rate FNI, profit net moyen)
//   - agrégation par marque (avec moyenne profit véhicule + FNI + marge + jours)
//   - agrégation par vendeur
//   - agrégation par modèle (top vendus)
//   - signaux perf : top profits, flops (profit négatif), rotation lente (>365j),
//     FNI attach faible (<30%) par vendeur

const TYPES_VALIDES = new Set(['ps_neuf', 'ps_usage', 'bateau_neuf', 'bateau_usage'])

type Vente = {
  id: number
  type: string
  date_vente: string
  client: string | null
  stock_num: string
  marque: string | null
  modele: string | null
  annee: number | null
  vendeur_id: string | null
  vendeur_nom: string | null
  prix_vente: number
  profit_vehicule: number
  pct_brut_vehicule: number | null
  ventes_fni: number
  profit_fni: number
  pct_brut_fni: number | null
  ventes_totales: number
  profit_net_total: number
  pct_profit: number | null
  nb_jours: number | null
}

type Acc = {
  nb: number
  sum_prix: number
  sum_profit_veh: number
  sum_ventes_fni: number
  sum_profit_fni: number
  sum_profit_net: number
  sum_jours: number
  nb_avec_fni: number
  nb_profit_negatif: number
  sum_jours_count: number
}
function emptyAcc(): Acc {
  return {
    nb: 0, sum_prix: 0, sum_profit_veh: 0, sum_ventes_fni: 0, sum_profit_fni: 0,
    sum_profit_net: 0, sum_jours: 0, nb_avec_fni: 0, nb_profit_negatif: 0, sum_jours_count: 0,
  }
}
function addToAcc(a: Acc, v: Vente) {
  a.nb++
  a.sum_prix += Number(v.prix_vente || 0)
  a.sum_profit_veh += Number(v.profit_vehicule || 0)
  a.sum_ventes_fni += Number(v.ventes_fni || 0)
  a.sum_profit_fni += Number(v.profit_fni || 0)
  a.sum_profit_net += Number(v.profit_net_total || 0)
  if (v.nb_jours != null) { a.sum_jours += Number(v.nb_jours); a.sum_jours_count++ }
  if (Number(v.ventes_fni || 0) > 0) a.nb_avec_fni++
  if (Number(v.profit_net_total || 0) < 0) a.nb_profit_negatif++
}
function finalizeAcc(a: Acc) {
  const moy_prix = a.nb ? a.sum_prix / a.nb : 0
  const moy_profit_veh = a.nb ? a.sum_profit_veh / a.nb : 0
  const moy_profit_net = a.nb ? a.sum_profit_net / a.nb : 0
  const moy_profit_fni_si_present = a.nb_avec_fni ? a.sum_profit_fni / a.nb_avec_fni : 0
  const moy_jours = a.sum_jours_count ? a.sum_jours / a.sum_jours_count : 0
  const attach_fni = a.nb ? a.nb_avec_fni / a.nb : 0
  const marge_brute_pct = a.sum_prix > 0 ? a.sum_profit_veh / a.sum_prix : 0
  return {
    nb: a.nb,
    total_prix: a.sum_prix,
    total_profit_veh: a.sum_profit_veh,
    total_ventes_fni: a.sum_ventes_fni,
    total_profit_fni: a.sum_profit_fni,
    total_profit_net: a.sum_profit_net,
    moy_prix,
    moy_profit_veh,
    moy_profit_net,
    moy_profit_fni_si_present,
    moy_jours,
    attach_fni,
    marge_brute_pct,
    nb_avec_fni: a.nb_avec_fni,
    nb_profit_negatif: a.nb_profit_negatif,
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl
    const types = url.searchParams.getAll('type').filter(t => TYPES_VALIDES.has(t))
    const dateDebut = url.searchParams.get('date_debut')
    const dateFin = url.searchParams.get('date_fin')

    let q = supabaseAdmin.from('scoa_ventes').select('*')
    if (types.length > 0) q = q.in('type', types)
    if (dateDebut) q = q.gte('date_vente', dateDebut)
    if (dateFin) q = q.lte('date_vente', dateFin)
    q = q.order('date_vente', { ascending: false }).limit(20000)

    const { data, error } = await q
    if (error) throw error
    const ventes = (data || []) as Vente[]

    if (ventes.length === 0) {
      return NextResponse.json({
        nb_total: 0,
        filtres: { types, date_debut: dateDebut, date_fin: dateFin },
        global: finalizeAcc(emptyAcc()),
        par_marque: [], par_vendeur: [], par_modele: [], par_type: [],
        signaux: { top_profits: [], flops: [], rotation_lente: [], fni_attach_faible: [] },
      })
    }

    // Global
    const globalAcc = emptyAcc()
    for (const v of ventes) addToAcc(globalAcc, v)

    // Par marque
    const byMarque = new Map<string, Acc>()
    for (const v of ventes) {
      const k = (v.marque || 'Inconnue').trim() || 'Inconnue'
      if (!byMarque.has(k)) byMarque.set(k, emptyAcc())
      addToAcc(byMarque.get(k)!, v)
    }
    const parMarque = [...byMarque.entries()].map(([marque, a]) => ({ marque, ...finalizeAcc(a) }))
      .sort((x, y) => y.total_profit_net - x.total_profit_net)

    // Par vendeur
    const byVendeur = new Map<string, { nom: string, id: string | null, acc: Acc }>()
    for (const v of ventes) {
      const k = (v.vendeur_nom || 'Inconnu').trim() || 'Inconnu'
      if (!byVendeur.has(k)) byVendeur.set(k, { nom: k, id: v.vendeur_id, acc: emptyAcc() })
      addToAcc(byVendeur.get(k)!.acc, v)
    }
    const parVendeur = [...byVendeur.values()].map(({ nom, id, acc }) => ({
      vendeur_nom: nom, vendeur_id: id, ...finalizeAcc(acc),
    })).sort((x, y) => y.total_profit_net - x.total_profit_net)

    // Par type
    const byType = new Map<string, Acc>()
    for (const v of ventes) {
      const k = v.type
      if (!byType.has(k)) byType.set(k, emptyAcc())
      addToAcc(byType.get(k)!, v)
    }
    const parType = [...byType.entries()].map(([type, a]) => ({ type, ...finalizeAcc(a) }))

    // Par modèle (top)
    const byModele = new Map<string, { marque: string, modele: string, acc: Acc }>()
    for (const v of ventes) {
      const marque = (v.marque || 'Inconnue').trim()
      const modele = (v.modele || '(inconnu)').trim()
      const k = `${marque}|${modele}`
      if (!byModele.has(k)) byModele.set(k, { marque, modele, acc: emptyAcc() })
      addToAcc(byModele.get(k)!.acc, v)
    }
    const parModele = [...byModele.values()].map(({ marque, modele, acc }) => ({
      marque, modele, ...finalizeAcc(acc),
    })).sort((x, y) => y.nb - x.nb || y.total_profit_net - x.total_profit_net)

    // Signaux perf
    const ventesTriees = [...ventes].sort((a, b) => Number(b.profit_net_total || 0) - Number(a.profit_net_total || 0))
    const top_profits = ventesTriees.slice(0, 10).map(v => ({
      date: v.date_vente, marque: v.marque, modele: v.modele, stock: v.stock_num,
      vendeur: v.vendeur_nom, profit_net: Number(v.profit_net_total || 0),
      prix: Number(v.prix_vente || 0), pct_profit: Number(v.pct_profit || 0),
    }))
    const flops = [...ventes].filter(v => Number(v.profit_net_total || 0) < 0)
      .sort((a, b) => Number(a.profit_net_total || 0) - Number(b.profit_net_total || 0))
      .slice(0, 10)
      .map(v => ({
        date: v.date_vente, marque: v.marque, modele: v.modele, stock: v.stock_num,
        vendeur: v.vendeur_nom, profit_net: Number(v.profit_net_total || 0),
        prix: Number(v.prix_vente || 0), pct_profit: Number(v.pct_profit || 0),
      }))
    const rotation_lente = [...ventes].filter(v => Number(v.nb_jours || 0) > 365)
      .sort((a, b) => Number(b.nb_jours || 0) - Number(a.nb_jours || 0))
      .slice(0, 15)
      .map(v => ({
        date: v.date_vente, marque: v.marque, modele: v.modele, stock: v.stock_num,
        vendeur: v.vendeur_nom, jours: Number(v.nb_jours || 0),
        profit_net: Number(v.profit_net_total || 0),
      }))
    const fni_attach_faible = parVendeur
      .filter(p => p.nb >= 3 && p.attach_fni < 0.30)
      .map(p => ({
        vendeur_nom: p.vendeur_nom, nb: p.nb,
        attach_fni: p.attach_fni,
        manque_a_gagner_estime: Math.max(0, (0.5 - p.attach_fni) * p.nb * (globalAcc.sum_profit_fni / Math.max(1, globalAcc.nb_avec_fni))),
      }))
      .sort((a, b) => b.manque_a_gagner_estime - a.manque_a_gagner_estime)

    return NextResponse.json({
      nb_total: ventes.length,
      filtres: { types, date_debut: dateDebut, date_fin: dateFin },
      global: finalizeAcc(globalAcc),
      par_marque: parMarque,
      par_vendeur: parVendeur,
      par_modele: parModele,
      par_type: parType,
      signaux: { top_profits, flops, rotation_lente, fni_attach_faible },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
