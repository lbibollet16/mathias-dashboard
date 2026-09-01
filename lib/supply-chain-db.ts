// Accès base du module supply chain : chargement des sources et écriture des
// résultats. Le calcul lui-même est dans lib/supply-chain.ts (sans I/O).

import { supabaseAdmin } from '@/lib/supabase'
import {
  CONFIG_DEFAUT, ScConfig, ParamsFournisseur, TractionPiece,
  parseTractionCSV, parseFournisseursTSV,
  AnalysePiece, AnalyseGroupe, Finding, TractionCharge,
} from '@/lib/supply-chain'

/**
 * Lecture paginée : Supabase plafonne à 1000 lignes par requête et le module
 * lit des tables de 130 000 lignes. Toute lecture passe par ici.
 */
export async function lireTout<T = any>(
  table: string,
  colonnes: string,
  affiner?: (q: any) => any,
  tailleLot = 1000,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  // Garde-fou : au-delà de 500 000 lignes, c'est qu'un filtre a sauté.
  while (from < 500_000) {
    let q = supabaseAdmin.from(table).select(colonnes)
    if (affiner) q = affiner(q)
    const { data, error } = await q.range(from, from + tailleLot - 1)
    if (error) throw new Error(`${table} : ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...(data as T[]))
    if (data.length < tailleLot) break
    from += tailleLot
  }
  return out
}

/** Insertion par lots. Supabase refuse les très gros payloads d'un coup. */
export async function insererParLots(table: string, rows: any[], taille = 500) {
  for (let i = 0; i < rows.length; i += taille) {
    const { error } = await supabaseAdmin.from(table).insert(rows.slice(i, i + taille))
    if (error) throw new Error(`Insertion ${table} : ${error.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Chargement des sources
// ═══════════════════════════════════════════════════════════════════════

export async function chargerConfig(): Promise<ScConfig> {
  const { data } = await supabaseAdmin.from('sc_config').select('*').eq('id', 1).maybeSingle()
  if (!data) return { ...CONFIG_DEFAUT }
  const n = (v: any, d: number) => (v === null || v === undefined || v === '' ? d : Number(v))
  return {
    delai_jours: n(data.delai_jours, CONFIG_DEFAUT.delai_jours),
    niveau_service: n(data.niveau_service, CONFIG_DEFAUT.niveau_service),
    cout_commande: n(data.cout_commande, CONFIG_DEFAUT.cout_commande),
    cout_ligne_commande: n(data.cout_ligne_commande, CONFIG_DEFAUT.cout_ligne_commande),
    max_commandes_an: n(data.max_commandes_an, CONFIG_DEFAUT.max_commandes_an),
    taux_possession: n(data.taux_possession, CONFIG_DEFAUT.taux_possession),
    horizon_surstock_mois: n(data.horizon_surstock_mois, CONFIG_DEFAUT.horizon_surstock_mois),
    mois_stock_mort: n(data.mois_stock_mort, CONFIG_DEFAUT.mois_stock_mort),
    seuil_abc_a: n(data.seuil_abc_a, CONFIG_DEFAUT.seuil_abc_a),
    seuil_abc_b: n(data.seuil_abc_b, CONFIG_DEFAUT.seuil_abc_b),
    alerte_couverture_mois: n(data.alerte_couverture_mois, CONFIG_DEFAUT.alerte_couverture_mois),
    alerte_valeur_dollars: n(data.alerte_valeur_dollars, CONFIG_DEFAUT.alerte_valeur_dollars),
    alerte_multiple_eoq: n(data.alerte_multiple_eoq, CONFIG_DEFAUT.alerte_multiple_eoq),
    alerte_sans_vente_dollars: n(data.alerte_sans_vente_dollars, CONFIG_DEFAUT.alerte_sans_vente_dollars),
    alerte_qte_min: n(data.alerte_qte_min, CONFIG_DEFAUT.alerte_qte_min),
    // Stocké en texte « AMA,FBA,FBM » côté base pour rester éditable dans un
    // simple champ de saisie.
    lignes_hors_perimetre: typeof data.lignes_hors_perimetre === 'string'
      ? data.lignes_hors_perimetre.split(',').map((x: string) => x.trim().toUpperCase()).filter(Boolean)
      : CONFIG_DEFAUT.lignes_hors_perimetre,
    saison_active: data.saison_active === undefined || data.saison_active === null
      ? CONFIG_DEFAUT.saison_active : !!data.saison_active,
    saison_horizon_mois: n(data.saison_horizon_mois, CONFIG_DEFAUT.saison_horizon_mois),
  }
}

export async function chargerParamsFournisseurs(): Promise<Map<string, ParamsFournisseur>> {
  const rows = await lireTout<any>('sc_fournisseurs_params', '*')
  const m = new Map<string, ParamsFournisseur>()
  for (const r of rows) {
    m.set(r.fournisseur, {
      delai_jours: r.delai_jours === null ? null : Number(r.delai_jours),
      cout_commande: r.cout_commande === null ? null : Number(r.cout_commande),
      niveau_service: r.niveau_service === null ? null : Number(r.niveau_service),
      franco_port: r.franco_port === null ? null : Number(r.franco_port),
      suivi_actif: r.suivi_actif !== false,
    })
  }
  return m
}

/**
 * Feed Traction + table de correspondance des fournisseurs.
 *
 * Le garde-fou anti-troncature reprend celui du sync ERP : un feed partiel
 * (incident réseau côté Traction) produirait un « inventaire » amputé qu'on
 * archiverait ensuite pour toujours dans un snapshot mensuel.
 */
export async function chargerTraction(minAttendu = 0, exclureLignes: string[] = []): Promise<TractionCharge> {
  const [tRes, fRes] = await Promise.all([
    fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(120_000) }),
    fetch(process.env.FOURNISSEURS_URL!, { signal: AbortSignal.timeout(60_000) }),
  ])
  if (!tRes.ok) throw new Error(`Traction HTTP ${tRes.status}`)
  if (!fRes.ok) throw new Error(`Fournisseurs HTTP ${fRes.status}`)

  const dictFourn = parseFournisseursTSV(await fRes.text())
  const charge = parseTractionCSV(await tRes.text(), dictFourn, exclureLignes)

  // Le garde-fou compte les lignes RETENUES + les écartées : un feed tronqué
  // doit être détecté même si la troncature tombe sur les lignes exclues.
  const total = charge.pieces.size + charge.exclusion.nb_catalogue
  if (total < 1000) {
    throw new Error(`Feed Traction suspect : ${total} pièces seulement`)
  }
  if (minAttendu > 0 && total < 0.8 * minAttendu) {
    throw new Error(
      `Feed Traction tronqué : ${total} pièces vs ${minAttendu} attendues (< 80 %). ` +
      `Opération annulée pour ne pas archiver un inventaire incomplet.`)
  }
  return charge
}

export interface VentesChargees {
  ventes: Map<string, Record<string, { qte: number; ca: number; cogs: number }>>
  moisDisponibles: Set<string>
}

/**
 * historique_ventes → demande par pièce et par mois.
 *
 * Le rapport Traction 2891 émet plusieurs lignes pour un même code dans un même
 * mois (prix ou client différents, retours en négatif). On ADDITIONNE : chaque
 * ligne est une vente réelle, pas un doublon. Le coût des ventes se déduit de
 * `revenus − profit` (le rapport ne donne pas le coût directement en base).
 */
export async function chargerVentes(): Promise<VentesChargees> {
  const rows = await lireTout<any>('historique_ventes', 'code_piece, mois, quantite, revenus, profit')
  const ventes = new Map<string, Record<string, { qte: number; ca: number; cogs: number }>>()
  const moisDisponibles = new Set<string>()

  for (const r of rows) {
    const code = String(r.code_piece || '').trim()
    const mois = String(r.mois || '').trim()
    if (!code || !/^\d{4}-\d{2}$/.test(mois)) continue
    moisDisponibles.add(mois)

    let h = ventes.get(code)
    if (!h) { h = {}; ventes.set(code, h) }
    const cell = h[mois] || (h[mois] = { qte: 0, ca: 0, cogs: 0 })
    const revenus = Number(r.revenus) || 0
    const profit = Number(r.profit) || 0
    cell.qte += Number(r.quantite) || 0
    cell.ca += revenus
    cell.cogs += revenus - profit
  }
  return { ventes, moisDisponibles }
}

export interface SnapshotsCharges {
  /** `${dimension}|${cle}|${mois}` → valeur de stock. */
  snapshots: Map<string, number>
  moisSnapshots: string[]
}

export async function chargerSnapshots(): Promise<SnapshotsCharges> {
  const rows = await lireTout<any>('sc_snapshot_agregats', 'mois, dimension, cle, valeur_totale')
  const snapshots = new Map<string, number>()
  const mois = new Set<string>()
  for (const r of rows) {
    snapshots.set(`${r.dimension}|${r.cle}|${r.mois}`, Number(r.valeur_totale) || 0)
    mois.add(r.mois)
  }
  return { snapshots, moisSnapshots: [...mois].sort() }
}

/** fournisseur → $ encore retournables (lots actifs, date limite non dépassée). */
export async function chargerRetournables(): Promise<Map<string, number>> {
  const auj = new Date().toISOString().split('T')[0]
  const rows = await lireTout<any>(
    'lots_retournables', 'fournisseur, qte_restante, cout_unitaire',
    q => q.gt('qte_restante', 0).gte('date_limite', auj))
  const m = new Map<string, number>()
  for (const r of rows) {
    const f = r.fournisseur || 'Non assigné'
    m.set(f, (m.get(f) || 0) + (Number(r.qte_restante) || 0) * (Number(r.cout_unitaire) || 0))
  }
  return m
}

export async function chargerNegatifs(): Promise<Map<string, number>> {
  const rows = await lireTout<any>('memoire_negatifs', 'fournisseur')
  const m = new Map<string, number>()
  for (const r of rows) {
    const f = r.fournisseur || 'Non assigné'
    m.set(f, (m.get(f) || 0) + 1)
  }
  return m
}

export async function chargerAlertesRecep(): Promise<Map<string, number>> {
  const rows = await lireTout<any>(
    'sc_receptions', 'fournisseur',
    q => q.eq('alerte', true).in('statut', ['nouveau', 'vu']))
  const m = new Map<string, number>()
  for (const r of rows) {
    const f = r.fournisseur || 'Non assigné'
    m.set(f, (m.get(f) || 0) + 1)
  }
  return m
}

// ═══════════════════════════════════════════════════════════════════════
// Runs d'analyse
// ═══════════════════════════════════════════════════════════════════════

/** Le run servi à l'écran : le dernier terminé avec succès. */
export async function dernierRun(): Promise<any | null> {
  const { data } = await supabaseAdmin
    .from('sc_runs').select('*')
    .eq('statut', 'termine')
    .order('termine_le', { ascending: false })
    .limit(1).maybeSingle()
  return data || null
}

export async function ouvrirRun(declencheur: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('sc_runs').insert({ declencheur, statut: 'en_cours' })
    .select('run_id').single()
  if (error) throw new Error(`Ouverture du run : ${error.message}`)
  return data.run_id
}

/**
 * Écrit les résultats sous le nouveau run_id, marque le run terminé, PUIS purge
 * les anciens. Cet ordre est délibéré : à aucun instant l'écran ne voit une
 * table vide, contrairement au DELETE+INSERT utilisé ailleurs dans le projet
 * (qui a laissé 190 000 lignes dans stock_aujourdhui pour 130 000 pièces).
 */
export async function ecrireResultats(args: {
  runId: string
  pieces: AnalysePiece[]
  groupes: AnalyseGroupe[]
  findings: Finding[]
  kpis: Record<string, any>
  log: string[]
  debut: number
}) {
  const { runId, pieces, groupes, findings, kpis, log, debut } = args

  await insererParLots('sc_analyse_pieces', pieces.map(p => ({ run_id: runId, ...p })), 500)
  await insererParLots('sc_analyse_groupes', groupes.map(g => ({ run_id: runId, ...g })), 500)
  await insererParLots('sc_findings', findings.map((f, i) => ({ run_id: runId, rang: i, ...f })), 500)

  await supabaseAdmin.from('sc_runs').update({
    statut: 'termine',
    termine_le: new Date().toISOString(),
    nb_pieces: pieces.length,
    nb_findings: findings.length,
    duree_ms: Date.now() - debut,
    kpis,
    log,
  }).eq('run_id', runId)

  await purgerAnciensRuns(runId)
}

/** Ne conserve que le run courant et l'avant-dernier (filet de sécurité). */
export async function purgerAnciensRuns(runIdCourant: string) {
  const { data: runs } = await supabaseAdmin
    .from('sc_runs').select('run_id, termine_le')
    .eq('statut', 'termine')
    .order('termine_le', { ascending: false })
  const aGarder = new Set([runIdCourant, ...(runs || []).slice(0, 2).map(r => r.run_id)])
  const aPurger = (runs || []).map(r => r.run_id).filter(id => !aGarder.has(id))

  // Les runs restés « en_cours » (timeout, crash) n'ont pas de termine_le et
  // n'apparaissent pas ci-dessus : on les nettoie séparément, sinon leurs
  // lignes d'analyse resteraient orphelines indéfiniment.
  const { data: zombies } = await supabaseAdmin
    .from('sc_runs').select('run_id')
    .eq('statut', 'en_cours')
    .lt('demarre_le', new Date(Date.now() - 3 * 3600_000).toISOString())
  for (const z of zombies || []) if (!aGarder.has(z.run_id)) aPurger.push(z.run_id)

  for (const id of aPurger) {
    await supabaseAdmin.from('sc_analyse_pieces').delete().eq('run_id', id)
    await supabaseAdmin.from('sc_analyse_groupes').delete().eq('run_id', id)
    await supabaseAdmin.from('sc_findings').delete().eq('run_id', id)
    await supabaseAdmin.from('sc_runs').delete().eq('run_id', id)
  }
}
