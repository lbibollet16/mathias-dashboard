// Moteur supply chain du module « Rotation & Fournisseurs ».
//
// Tout le calcul vit ici, sans accès base : les routes fournissent les données
// brutes (feed Traction, historique de ventes, snapshots, lots, négatifs) et
// récupèrent un résultat prêt à écrire. C'est ce qui rend le moteur testable et
// réutilisable par le cron mensuel comme par le recalcul à la demande.
//
// ── Ce que le moteur calcule ────────────────────────────────────────────
//   Demande     : moyenne et EMA sur une fenêtre de 12 mois, σ, CV, tendance
//   Pareto/ABC  : classement 80/95 sur le COÛT DES VENTES (pas le CA — c'est
//                 le capital qui tourne qui compte, pas le prix de vente)
//   XYZ         : régularité de la demande via le coefficient de variation
//   Wilson      : quantité économique de commande Q* = √(2DS/H)
//   Sécurité    : SS = Z·σ·√L, point de commande = demande×L + SS
//   Rotation    : coût des ventes ÷ stock MOYEN (d'où les snapshots mensuels)
//   Excédent    : ce qui dépasse l'horizon de couverture cible
//
// ── Piège traité : les mois manquants ───────────────────────────────────
// historique_ventes a des trous (2025-06, 2026-03 à 05, 2026-07, 2026-08 au
// moment de l'écriture). Diviser bêtement par 12 sous-évaluerait la demande de
// moitié et déclencherait de faux « surstock » partout. On divise donc par le
// nombre de mois RÉELLEMENT présents dans la fenêtre, et on remonte cette
// couverture à l'écran pour que le chiffre soit lisible avec sa marge d'erreur.

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface ScConfig {
  delai_jours: number
  niveau_service: number
  cout_commande: number
  taux_possession: number
  horizon_surstock_mois: number
  mois_stock_mort: number
  seuil_abc_a: number
  seuil_abc_b: number
  alerte_couverture_mois: number
  alerte_valeur_dollars: number
  alerte_multiple_eoq: number
  alerte_sans_vente_dollars: number
  alerte_qte_min: number
  /**
   * Codes de ligne dont les ventes ne passent PAS par le rapport 2891.
   * AMA / FBA / FBM sont les lignes Amazon : leur stock est bien réel (694 000 $
   * au moment de l'écriture, 25 % de la valeur d'inventaire) mais leurs ventes
   * vivent dans les settlements Amazon. Les laisser dans le périmètre les
   * ferait toutes classer « jamais vendues » et gonflerait le stock mort d'un
   * demi-million de dollars imaginaire.
   */
  lignes_hors_perimetre: string[]
}

export const CONFIG_DEFAUT: ScConfig = {
  delai_jours: 14,
  niveau_service: 0.95,
  cout_commande: 45,
  taux_possession: 0.25,
  horizon_surstock_mois: 12,
  mois_stock_mort: 24,
  seuil_abc_a: 0.80,
  seuil_abc_b: 0.95,
  alerte_couverture_mois: 12,
  alerte_valeur_dollars: 2000,
  alerte_multiple_eoq: 3,
  alerte_sans_vente_dollars: 500,
  alerte_qte_min: 3,
  lignes_hors_perimetre: ['AMA', 'FBA', 'FBM'],
}

export interface TractionPiece {
  pk: string
  desc: string
  idFournisseur: string
  fournisseur: string
  codeLigne: string
  cout: number
  prix: number
  qty: number            // stock physique total
  qtyDispo: number       // QTYMINUSRESERVED
  qteReserve: number
  qteTransit: number
  qteCommande: number
  qteMin: number
  qteMax: number
  localisation: string
}

export interface ParamsFournisseur {
  delai_jours?: number | null
  cout_commande?: number | null
  niveau_service?: number | null
  franco_port?: number | null
  suivi_actif?: boolean
}

export interface AnalysePiece {
  code_piece: string
  description: string
  fournisseur: string
  id_fournisseur: string
  code_ligne: string

  stock: number
  stock_dispo: number
  qte_reserve: number
  qte_transit: number
  qte_commande: number
  qte_min: number
  qte_max: number
  cout_unitaire: number
  prix_vente: number
  valeur_stock: number

  ventes_12m_qte: number
  ventes_12m_ca: number
  ventes_12m_cogs: number
  ventes_24m_qte: number
  mois_actifs_12m: number
  derniere_vente: string | null
  mois_sans_vente: number | null
  demande_mens: number
  demande_ema: number
  ecart_type: number
  cv: number
  tendance_pct: number

  classe_abc: string
  classe_xyz: string
  statut: string

  rotation: number
  dsi_jours: number | null
  couverture_mois: number | null
  stock_securite: number
  point_commande: number
  eoq: number
  qte_a_commander: number
  nb_commandes_an: number
  exces_unites: number
  exces_valeur: number
  valeur_morte: number
  valeur_dormante: number
  score_urgence: number

  serie_12m: number[]
}

export interface AnalyseGroupe {
  dimension: 'fournisseur' | 'ligne'
  cle: string
  id_fournisseur: string | null
  nb_pieces: number
  nb_pieces_stock: number
  qte_totale: number
  valeur_stock: number
  part_valeur: number
  part_cumulee: number
  classe_pareto: string
  ventes_12m_ca: number
  ventes_12m_cogs: number
  marge_pct: number | null
  stock_moyen: number
  valeur_hors_perimetre: number
  nb_snapshots: number
  rotation: number
  dsi_jours: number | null
  couverture_mois: number | null
  nb_rupture: number
  nb_sous_stock: number
  nb_surstock: number
  nb_mort: number
  nb_dormant: number
  nb_hors_perimetre: number
  valeur_exces: number
  valeur_morte: number
  valeur_dormante: number
  valeur_retournable: number
  nb_negatifs: number
  nb_alertes_recep: number
  valeur_mois_prec: number | null
  variation_pct: number | null
  score_sante: number
}

export interface Finding {
  agent: string
  severite: 'critique' | 'attention' | 'info'
  code_piece: string | null
  fournisseur: string | null
  code_ligne: string | null
  titre: string
  detail: string
  action: string
  impact_dollars: number
  donnees: any
}

// ═══════════════════════════════════════════════════════════════════════
// Utilitaires numériques
// ═══════════════════════════════════════════════════════════════════════

/**
 * Inverse de la loi normale centrée réduite (algorithme d'Acklam).
 * Sert à convertir un niveau de service (95 %) en coefficient Z (1.645) sans
 * table figée : l'utilisateur peut régler 90 %, 97 %, 99.5 %… librement.
 */
export function zScore(p: number): number {
  if (!(p > 0 && p < 1)) return 1.645
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00]
  const pLow = 0.02425, pHigh = 1 - pLow
  let q: number, r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }
  q = p - 0.5; r = q * q
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
         (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
}

const JOURS_PAR_MOIS = 30.4375

/** Clé YYYY-MM du mois précédant `date`. */
export function moisPrecedent(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Les `n` clés YYYY-MM se terminant à `moisFin` inclus, ordre chronologique. */
export function fenetreMois(moisFin: string, n: number): string[] {
  const [a, m] = moisFin.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(a, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

/** Nb de mois entre deux clés YYYY-MM (b − a). */
export function ecartMois(a: string, b: string): number {
  const [a1, m1] = a.split('-').map(Number)
  const [a2, m2] = b.split('-').map(Number)
  return (a2 - a1) * 12 + (m2 - m1)
}

const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

// ═══════════════════════════════════════════════════════════════════════
// Parsing des sources
// ═══════════════════════════════════════════════════════════════════════

/** TSV Google Sheets « id fournisseur → nom ». */
export function parseFournisseursTSV(tsv: string): Map<string, string> {
  const dict = new Map<string, string>()
  for (const line of tsv.split(/\r?\n/).slice(1)) {
    const cols = line.split('\t')
    const id = cols[0]?.replace(/['"]/g, '').trim()
    const nom = cols[1]?.replace(/['"]/g, '').trim()
    if (id && nom) dict.set(id, nom)
  }
  return dict
}

/**
 * Feed Traction (CSV `;`). On lit tout ce que le feed offre — QteTransit,
 * QteCommande, QteMin/QteMax servent aux agents et n'étaient exploités nulle
 * part ailleurs dans le dashboard.
 */
export function parseTractionCSV(csv: string, dictFourn: Map<string, string>): Map<string, TractionPiece> {
  const lines = csv.split(/\r?\n/)
  const hdrs = (lines[0] || '').split(';')
  const idx = (n: string) => hdrs.findIndex(h => h.trim().toLowerCase() === n.toLowerCase())

  const iP = idx('PKCode'), iF = idx('PKFournisseur'), iC = idx('PrixCoutant')
  const iPrix = idx('PrixListe1'), iQ = idx('QTY'), iD = idx('QTYMINUSRESERVED')
  const iR = idx('QteReserveEnStock'), iL = idx('CodeLigne'), iDesc = idx('DescFra')
  const iT = idx('QteTransit'), iCmd = idx('QteCommande')
  const iMin = idx('QteMin'), iMax = idx('QteMax'), iLoc = idx('Location1')

  if (iP < 0) throw new Error('Feed Traction : colonne PKCode introuvable')

  const out = new Map<string, TractionPiece>()
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw?.trim()) continue
    const cols = raw.split(';')
    if (cols.length < 5) continue
    const pk = cols[iP]?.replace(/['"]/g, '').trim()
    if (!pk) continue
    const clean = (j: number) => j >= 0 ? (cols[j] || '').replace(/['"]/g, '').trim() : ''
    const idF = clean(iF)
    const qtyDispo = num(clean(iD))
    const qteReserve = num(clean(iR))
    out.set(pk, {
      pk,
      desc: clean(iDesc),
      idFournisseur: idF,
      fournisseur: idF ? (dictFourn.get(idF) || `ID:${idF}`) : 'Non assigné',
      codeLigne: clean(iL) || 'N/A',
      cout: num(clean(iC)),
      prix: num(clean(iPrix)),
      qty: iQ >= 0 ? num(clean(iQ)) : qtyDispo + qteReserve,
      qtyDispo,
      qteReserve,
      qteTransit: num(clean(iT)),
      qteCommande: num(clean(iCmd)),
      qteMin: num(clean(iMin)),
      qteMax: num(clean(iMax)),
      localisation: clean(iLoc),
    })
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════
// Alerte « réception trop importante »
// ═══════════════════════════════════════════════════════════════════════

export interface EvalReception {
  alerte: boolean
  severite: 'critique' | 'attention' | null
  motifs: string[]
  exces_unites: number
  exces_valeur: number
  couverture_avant: number | null
  couverture_apres: number | null
  eoq: number
}

/**
 * Les 4 déclencheurs demandés, évalués ensemble. Une réception qui n'en coche
 * aucun est enregistrée quand même (traçabilité) mais sans alerte.
 *
 * Sévérité : « critique » dès que la réception coche 2 déclencheurs ou immobilise
 * plus de 3× le seuil en dollars — c'est ce qui mérite un appel au fournisseur.
 */
export function evaluerReception(args: {
  qteRecue: number
  coutUnitaire: number
  stockAvant: number
  stockApres: number
  demandeMens: number
  aVenduSur12m: boolean
  eoq: number
  cfg: ScConfig
}): EvalReception {
  const { qteRecue, coutUnitaire, stockAvant, stockApres, demandeMens, aVenduSur12m, eoq, cfg } = args
  const valeur = qteRecue * coutUnitaire
  const motifs: string[] = []

  const couvAvant = demandeMens > 0 ? stockAvant / demandeMens : null
  const couvApres = demandeMens > 0 ? stockApres / demandeMens : null

  // Garde-fou : on n'alerte jamais sur une réception minuscule, quel que soit
  // le déclencheur. Sans ça, une pièce vendue 0,1 u/mois génère une alerte à
  // chaque unité reçue et l'écran devient inutilisable.
  if (qteRecue < cfg.alerte_qte_min) {
    return { alerte: false, severite: null, motifs: [], exces_unites: 0, exces_valeur: 0,
             couverture_avant: couvAvant, couverture_apres: couvApres, eoq }
  }

  // 1. Couverture après réception au-delà de l'horizon cible
  if (couvApres !== null && couvApres > cfg.alerte_couverture_mois) motifs.push('couverture')

  // 2. Valeur de la réception
  if (valeur > cfg.alerte_valeur_dollars) motifs.push('valeur')

  // 3. Multiple de la quantité économique de Wilson
  if (eoq > 0 && qteRecue > cfg.alerte_multiple_eoq * eoq) motifs.push('eoq')

  // 4. Pièce sans historique de vente sur 12 mois
  if (!aVenduSur12m && valeur > cfg.alerte_sans_vente_dollars) motifs.push('sans_vente')

  // Excédent : ce qui dépasse l'horizon cible. Sans demande, tout le stock
  // reçu est excédentaire par définition (rien ne va le consommer).
  const cible = demandeMens > 0 ? demandeMens * cfg.alerte_couverture_mois : 0
  const excesUnites = Math.max(0, stockApres - cible)
  const excesValeur = excesUnites * coutUnitaire

  const alerte = motifs.length > 0
  const severite: 'critique' | 'attention' | null = !alerte
    ? null
    : (motifs.length >= 2 || valeur > 3 * cfg.alerte_valeur_dollars) ? 'critique' : 'attention'

  return {
    alerte, severite, motifs,
    exces_unites: alerte ? excesUnites : 0,
    exces_valeur: alerte ? excesValeur : 0,
    couverture_avant: couvAvant,
    couverture_apres: couvApres,
    eoq,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Analyse complète
// ═══════════════════════════════════════════════════════════════════════

export interface EntreeAnalyse {
  traction: Map<string, TractionPiece>
  /** code_piece → { 'YYYY-MM': { qte, ca, cogs } } */
  ventes: Map<string, Record<string, { qte: number; ca: number; cogs: number }>>
  /** Tous les mois présents dans historique_ventes (pour détecter les trous). */
  moisDisponibles: Set<string>
  cfg: ScConfig
  paramsFournisseur: Map<string, ParamsFournisseur>
  /** Agrégats de snapshots : `${dimension}|${cle}|${mois}` → valeur. */
  snapshots: Map<string, number>
  /** Mois de snapshot disponibles, ordre chronologique. */
  moisSnapshots: string[]
  /** fournisseur → $ encore retournables (lots_retournables actifs). */
  retournables: Map<string, number>
  /** fournisseur → nb de pièces en stock négatif. */
  negatifs: Map<string, number>
  /** fournisseur → nb d'alertes de réception ouvertes. */
  alertesRecep: Map<string, number>
  /** Mois de référence (fin de fenêtre). Défaut : mois précédent. */
  moisFin?: string
}

export interface ResultatAnalyse {
  pieces: AnalysePiece[]
  groupes: AnalyseGroupe[]
  findings: Finding[]
  kpis: Record<string, any>
  log: string[]
}

export function analyser(e: EntreeAnalyse): ResultatAnalyse {
  const log: string[] = []
  const cfg = e.cfg

  // ── Fenêtre de calcul ────────────────────────────────────────────────
  const moisFin = e.moisFin || moisPrecedent(new Date())
  const fenetre12 = fenetreMois(moisFin, 12)
  const fenetre24 = fenetreMois(moisFin, 24)
  const moisPresents12 = fenetre12.filter(m => e.moisDisponibles.has(m))
  const moisManquants12 = fenetre12.filter(m => !e.moisDisponibles.has(m))
  // Diviseur = mois réellement importés. Diviser par 12 avec des trous
  // diviserait la demande par deux et ferait apparaître du faux surstock.
  const nbMois12 = Math.max(1, moisPresents12.length)

  log.push(`Fenêtre ${fenetre12[0]} → ${moisFin} : ${moisPresents12.length}/12 mois importés`)
  if (moisManquants12.length) log.push(`Mois manquants : ${moisManquants12.join(', ')}`)

  const Z_GLOBAL = zScore(cfg.niveau_service)

  // Lignes dont les ventes ne transitent pas par le rapport 2891 (Amazon).
  const horsPerimetre = new Set((cfg.lignes_hors_perimetre || []).map(l => l.trim().toUpperCase()).filter(Boolean))

  // Profondeur réelle de l'historique : sert à qualifier « jamais vendue ».
  // Une pièce absente de 24 mois de rapports n'est pas « jamais vendue dans
  // l'absolu » — elle est invendue sur la période dont on dispose. La nuance
  // change ce qu'on peut affirmer devant un fournisseur.
  const moisConnus = [...e.moisDisponibles].sort()
  const debutHistorique = moisConnus[0] || moisFin

  // ── 1er passage : demande, stock, classification brute ───────────────
  interface Brut extends AnalysePiece { _cogsAnnualise: number }
  const bruts: Brut[] = []

  // On part de l'union « pièces Traction » ∪ « pièces vendues » : une pièce
  // vendue puis disparue du feed doit rester visible (c'est un signal), et une
  // pièce en stock jamais vendue est justement ce qu'on cherche à débusquer.
  const codes = new Set<string>([...e.traction.keys(), ...e.ventes.keys()])

  for (const code of codes) {
    const t = e.traction.get(code)
    const hist = e.ventes.get(code) || {}

    const stock = t?.qty ?? 0
    const qteCommande = t?.qteCommande ?? 0
    const qteTransit = t?.qteTransit ?? 0

    // Série mensuelle sur la fenêtre, limitée aux mois réellement importés :
    // un mois absent n'est pas un mois à zéro.
    const serie = moisPresents12.map(m => hist[m]?.qte ?? 0)
    const ventes12Qte = serie.reduce((s, v) => s + v, 0)
    const ventes12Ca = moisPresents12.reduce((s, m) => s + (hist[m]?.ca ?? 0), 0)
    const ventes12Cogs = moisPresents12.reduce((s, m) => s + (hist[m]?.cogs ?? 0), 0)
    const ventes24Qte = fenetre24
      .filter(m => e.moisDisponibles.has(m))
      .reduce((s, m) => s + (hist[m]?.qte ?? 0), 0)

    // Écarter le bruit : ni stock, ni vente, ni commande en cours → hors suivi.
    if (stock === 0 && ventes24Qte === 0 && qteCommande === 0 && qteTransit === 0) continue

    const moisAvecVente = Object.keys(hist).filter(m => (hist[m]?.qte ?? 0) > 0).sort()
    const derniereVente = moisAvecVente.length ? moisAvecVente[moisAvecVente.length - 1] : null
    const moisSansVente = derniereVente ? ecartMois(derniereVente, moisFin) : null
    const moisActifs12 = serie.filter(v => v > 0).length

    // Demande : moyenne sur les mois présents, pas sur 12.
    const demandeMens = ventes12Qte / nbMois12
    // EMA α = 0.3 — donne du poids au récent sans sur-réagir à un pic.
    let ema: number | null = null
    for (const v of serie) ema = ema === null ? v : 0.3 * v + 0.7 * ema
    const demandeEma = Math.max(0, ema ?? 0)

    // σ sur la fenêtre, mois à zéro INCLUS : la rupture de demande fait partie
    // de la variabilité que le stock de sécurité doit absorber.
    const n = serie.length
    const moy = n ? serie.reduce((s, v) => s + v, 0) / n : 0
    const variance = n > 1 ? serie.reduce((s, v) => s + (v - moy) ** 2, 0) / (n - 1) : 0
    const ecartType = Math.sqrt(variance)
    const cv = moy > 0 ? ecartType / moy : 0

    // Tendance : 3 derniers mois de la fenêtre vs les 3 précédents.
    let tendance = 0
    if (serie.length >= 6) {
      const r = serie.slice(-3).reduce((s, v) => s + v, 0) / 3
      const p = serie.slice(-6, -3).reduce((s, v) => s + v, 0) / 3
      tendance = p > 0 ? (r - p) / p : (r > 0 ? 1 : 0)
    }

    const cout = t?.cout ?? 0
    const valeurStock = stock * cout

    // Paramètres du fournisseur, avec repli sur la config globale.
    const pf = t ? e.paramsFournisseur.get(t.fournisseur) : undefined
    const delaiJours = pf?.delai_jours ?? cfg.delai_jours
    const delaiMois = delaiJours / JOURS_PAR_MOIS
    const coutCommande = pf?.cout_commande ?? cfg.cout_commande
    const Z = pf?.niveau_service != null ? zScore(pf.niveau_service) : Z_GLOBAL

    // Stock de sécurité : SS = Z · σ · √L (σ mensuel, L en mois).
    const stockSecurite = Math.ceil(Z * ecartType * Math.sqrt(delaiMois))
    const pointCommande = Math.ceil(demandeEma * delaiMois + stockSecurite)

    // Wilson : Q* = √(2·D·S/H). H = taux de possession × coût unitaire.
    // Sans coût unitaire ou sans demande, la formule n'a pas de sens : 0.
    const D = demandeMens * 12
    const H = cfg.taux_possession * cout
    let eoq = 0
    if (D > 0 && H > 0) {
      eoq = Math.sqrt((2 * D * coutCommande) / H)
      // Borne haute : commander plus d'un an de demande d'un coup n'est jamais
      // « économique » en pratique, même si la formule le dit (elle ignore
      // l'obsolescence et la place en entrepôt).
      eoq = Math.min(eoq, D)
      eoq = Math.max(1, Math.round(eoq))
    }
    const nbCommandesAn = eoq > 0 ? D / eoq : 0

    // Rotation par pièce : coût des ventes annualisé ÷ valeur du stock.
    const cogsAnnualise = ventes12Cogs * (12 / nbMois12)
    const rotation = valeurStock > 0 ? cogsAnnualise / valeurStock : 0
    const dsi = rotation > 0 ? 365 / rotation : null
    const couverture = demandeMens > 0 ? stock / demandeMens : null

    // ── Statut ────────────────────────────────────────────────────────
    // Une pièce n'est « en rupture » que si elle est censée être TENUE en
    // stock. Un article commandé à la pièce pour un client (vendu une seule
    // fois, sans min/max au système) tombe à zéro par construction : le
    // signaler en rupture noierait les vraies ruptures — 5 300 fausses alertes
    // sur les données réelles.
    const estStockee = moisActifs12 >= 2 || (t?.qteMin ?? 0) > 0 || (t?.qteMax ?? 0) > 0
    const estHorsPerimetre = horsPerimetre.has((t?.codeLigne ?? '').toUpperCase())

    const cibleHaute = demandeMens * cfg.horizon_surstock_mois + stockSecurite
    let statut = 'ok'
    let exces = 0, valeurMorte = 0, valeurDormante = 0
    if (estHorsPerimetre) {
      // Stock réel, mais dont les ventes sont suivies ailleurs : on l'affiche
      // sans porter de jugement dessus.
      statut = 'hors_perimetre'
    } else if (stock > 0 && derniereVente === null) {
      statut = 'jamais_vendue'; valeurMorte = valeurStock
    } else if (stock > 0 && moisSansVente !== null && moisSansVente >= cfg.mois_stock_mort) {
      statut = 'mort'; valeurMorte = valeurStock
    } else if (stock > 0 && ventes12Qte === 0) {
      // Vendue dans les 24 mois mais pas dans les 12 derniers. Ce n'est PAS du
      // stock mort : la fenêtre de 12 mois n'est couverte qu'à 7/12 par les
      // rapports importés, et un mois manquant suffit à faire basculer une
      // pièce ici. On la compte à part pour ne pas gonfler le stock mort.
      statut = 'dormant'; valeurDormante = valeurStock
    } else if (demandeMens > 0 && stock <= 0) {
      statut = estStockee ? 'rupture' : 'sur_commande'
    } else if (demandeMens > 0 && stock <= pointCommande && estStockee) {
      statut = 'sous_stock'
    } else if (demandeMens > 0 && stock > cibleHaute) {
      statut = 'surstock'; exces = stock - cibleHaute
    }

    // Quantité à commander : viser le point de commande, en respectant le lot
    // économique, et en tenant compte de ce qui est déjà en route.
    let qteACommander = 0
    if (statut === 'rupture' || statut === 'sous_stock') {
      const enRoute = qteTransit + qteCommande
      const manque = pointCommande + Math.max(eoq, 1) - (stock + enRoute)
      qteACommander = Math.max(0, Math.ceil(manque))
    }

    // Score d'urgence : sert à trier « quoi traiter en premier ».
    const scoreUrgence =
      (statut === 'rupture' ? 40 : statut === 'sous_stock' ? 25 : 0) +
      (tendance > 0.15 ? 10 : tendance < -0.15 ? -5 : 0) +
      (cv <= 0.5 ? 10 : cv <= 1 ? 5 : 0) +
      Math.min(30, cogsAnnualise / 500)

    bruts.push({
      code_piece: code,
      description: t?.desc ?? '',
      fournisseur: t?.fournisseur ?? 'Non assigné',
      id_fournisseur: t?.idFournisseur ?? '',
      code_ligne: t?.codeLigne ?? 'N/A',
      stock,
      stock_dispo: t?.qtyDispo ?? 0,
      qte_reserve: t?.qteReserve ?? 0,
      qte_transit: qteTransit,
      qte_commande: qteCommande,
      qte_min: t?.qteMin ?? 0,
      qte_max: t?.qteMax ?? 0,
      cout_unitaire: cout,
      prix_vente: t?.prix ?? 0,
      valeur_stock: valeurStock,
      ventes_12m_qte: ventes12Qte,
      ventes_12m_ca: ventes12Ca,
      ventes_12m_cogs: ventes12Cogs,
      ventes_24m_qte: ventes24Qte,
      mois_actifs_12m: moisActifs12,
      derniere_vente: derniereVente,
      mois_sans_vente: moisSansVente,
      demande_mens: demandeMens,
      demande_ema: demandeEma,
      ecart_type: ecartType,
      cv,
      tendance_pct: Math.round(tendance * 100),
      classe_abc: 'C',
      classe_xyz: cv === 0 && moy === 0 ? 'Z' : cv <= 0.5 ? 'X' : cv <= 1 ? 'Y' : 'Z',
      statut,
      rotation,
      dsi_jours: dsi,
      couverture_mois: couverture,
      stock_securite: stockSecurite,
      point_commande: pointCommande,
      eoq,
      qte_a_commander: qteACommander,
      nb_commandes_an: nbCommandesAn,
      exces_unites: exces,
      exces_valeur: exces * cout,
      valeur_morte: valeurMorte,
      valeur_dormante: valeurDormante,
      score_urgence: scoreUrgence,
      serie_12m: serie,
      _cogsAnnualise: cogsAnnualise,
    })
  }

  log.push(`${bruts.length} pièces suivies (sur ${e.traction.size} au catalogue)`)

  // ── Pareto / ABC sur le coût des ventes ──────────────────────────────
  // Loi de Pareto appliquée à la CONSOMMATION (coût des ventes annualisé) :
  // les pièces A sont celles qui font tourner le capital, pas les plus chères
  // ni les plus vendues en volume.
  const avecConso = bruts.filter(p => p._cogsAnnualise > 0).sort((a, b) => b._cogsAnnualise - a._cogsAnnualise)
  const consoTotale = avecConso.reduce((s, p) => s + p._cogsAnnualise, 0)
  let cumul = 0
  for (const p of avecConso) {
    cumul += p._cogsAnnualise
    const part = consoTotale > 0 ? cumul / consoTotale : 1
    p.classe_abc = part <= cfg.seuil_abc_a ? 'A' : part <= cfg.seuil_abc_b ? 'B' : 'C'
  }
  const nbA = avecConso.filter(p => p.classe_abc === 'A').length
  log.push(`ABC : ${nbA} pièces A portent ${Math.round(cfg.seuil_abc_a * 100)} % du coût des ventes`)

  const pieces: AnalysePiece[] = bruts.map(({ _cogsAnnualise, ...rest }) => rest)

  // ── Agrégats par fournisseur et par code de ligne ────────────────────
  const groupes: AnalyseGroupe[] = []
  for (const dimension of ['fournisseur', 'ligne'] as const) {
    const par = new Map<string, AnalysePiece[]>()
    for (const p of pieces) {
      const cle = dimension === 'fournisseur' ? p.fournisseur : p.code_ligne
      const arr = par.get(cle)
      if (arr) arr.push(p); else par.set(cle, [p])
    }

    const lignes: AnalyseGroupe[] = []
    for (const [cle, list] of par) {
      // Le stock hors périmètre (Amazon) compte dans la VALEUR d'inventaire —
      // il est bien là — mais pas dans la rotation ni le score de santé, dont
      // le dénominateur serait sinon gonflé par du stock dont on ne voit pas
      // les ventes.
      const dansPerimetre = list.filter(p => p.statut !== 'hors_perimetre')
      const valeurHorsPerimetre = list.reduce((s, p) => s + (p.statut === 'hors_perimetre' ? p.valeur_stock : 0), 0)

      const valeurStock = list.reduce((s, p) => s + p.valeur_stock, 0)
      const valeurSuivie = dansPerimetre.reduce((s, p) => s + p.valeur_stock, 0)
      const cogs12 = list.reduce((s, p) => s + p.ventes_12m_cogs, 0)
      const ca12 = list.reduce((s, p) => s + p.ventes_12m_ca, 0)
      const cogsAnnualise = cogs12 * (12 / nbMois12)
      const caAnnualise = ca12 * (12 / nbMois12)

      // Stock moyen : moyenne des photos mensuelles disponibles + la valeur
      // actuelle comme point le plus récent. C'est la seule façon d'avoir une
      // rotation honnête — sans snapshots, on se rabat sur le stock instantané
      // et on le signale via nb_snapshots.
      const valeursSnap: number[] = []
      for (const m of e.moisSnapshots) {
        if (!fenetre12.includes(m)) continue
        const v = e.snapshots.get(`${dimension}|${cle}|${m}`)
        if (v !== undefined) valeursSnap.push(v)
      }
      const stockMoyen = valeursSnap.length > 0
        ? (valeursSnap.reduce((s, v) => s + v, 0) + valeurStock) / (valeursSnap.length + 1)
        : valeurStock
      // Le stock moyen issu des snapshots inclut le hors-périmètre : on en
      // retire la part pour que la rotation reste comparable au coût des ventes.
      const partSuivie = valeurStock > 0 ? valeurSuivie / valeurStock : 1
      const stockMoyenSuivi = stockMoyen * partSuivie

      const rotation = stockMoyenSuivi > 0 ? cogsAnnualise / stockMoyenSuivi : 0
      const moisPrec = e.moisSnapshots.length ? e.moisSnapshots[e.moisSnapshots.length - 1] : null
      const valeurPrec = moisPrec ? (e.snapshots.get(`${dimension}|${cle}|${moisPrec}`) ?? null) : null

      const valeurMorte = list.reduce((s, p) => s + p.valeur_morte, 0)
      const valeurDormante = list.reduce((s, p) => s + p.valeur_dormante, 0)
      const valeurExces = list.reduce((s, p) => s + p.exces_valeur, 0)
      const nbRupture = list.filter(p => p.statut === 'rupture').length
      const nbPiecesStock = list.filter(p => p.stock > 0).length

      // Score de santé 0-100 : rotation (35 %), absence de stock mort (25 %),
      // absence d'excédent (25 %), absence de rupture (15 %). Un fournisseur à
      // 100 fait tourner tout son stock sans rien immobiliser ni manquer.
      const pctMort = valeurSuivie > 0 ? (valeurMorte + valeurDormante * 0.5) / valeurSuivie : 0
      const pctExces = valeurSuivie > 0 ? valeurExces / valeurSuivie : 0
      const pctRupture = dansPerimetre.length > 0 ? nbRupture / dansPerimetre.length : 0
      const scoreRot = Math.min(1, rotation / 4)
      const score = 100 * (0.35 * scoreRot + 0.25 * (1 - pctMort) + 0.25 * (1 - pctExces) + 0.15 * (1 - pctRupture))

      lignes.push({
        dimension, cle,
        id_fournisseur: dimension === 'fournisseur' ? (list[0]?.id_fournisseur || null) : null,
        nb_pieces: list.length,
        nb_pieces_stock: nbPiecesStock,
        qte_totale: list.reduce((s, p) => s + p.stock, 0),
        valeur_stock: valeurStock,
        part_valeur: 0,
        part_cumulee: 0,
        classe_pareto: 'C',
        ventes_12m_ca: caAnnualise,
        ventes_12m_cogs: cogsAnnualise,
        marge_pct: caAnnualise > 0 ? ((caAnnualise - cogsAnnualise) / caAnnualise) * 100 : null,
        stock_moyen: stockMoyenSuivi,
        valeur_hors_perimetre: valeurHorsPerimetre,
        nb_snapshots: valeursSnap.length,
        rotation,
        dsi_jours: rotation > 0 ? 365 / rotation : null,
        couverture_mois: cogsAnnualise > 0 ? valeurSuivie / (cogsAnnualise / 12) : null,
        nb_rupture: nbRupture,
        nb_sous_stock: list.filter(p => p.statut === 'sous_stock').length,
        nb_surstock: list.filter(p => p.statut === 'surstock').length,
        nb_mort: list.filter(p => ['mort', 'jamais_vendue'].includes(p.statut)).length,
        nb_dormant: list.filter(p => p.statut === 'dormant').length,
        nb_hors_perimetre: list.filter(p => p.statut === 'hors_perimetre').length,
        valeur_exces: valeurExces,
        valeur_morte: valeurMorte,
        valeur_dormante: valeurDormante,
        valeur_retournable: dimension === 'fournisseur' ? (e.retournables.get(cle) ?? 0) : 0,
        nb_negatifs: dimension === 'fournisseur' ? (e.negatifs.get(cle) ?? 0) : 0,
        nb_alertes_recep: dimension === 'fournisseur' ? (e.alertesRecep.get(cle) ?? 0) : 0,
        valeur_mois_prec: valeurPrec,
        variation_pct: valeurPrec && valeurPrec > 0 ? ((valeurStock - valeurPrec) / valeurPrec) * 100 : null,
        score_sante: Math.max(0, Math.min(100, score)),
      })
    }

    // Pareto sur la VALEUR DE STOCK du groupe : quels fournisseurs immobilisent
    // le capital. C'est la question posée par « stock par fournisseur ».
    lignes.sort((a, b) => b.valeur_stock - a.valeur_stock)
    const total = lignes.reduce((s, g) => s + g.valeur_stock, 0)
    let cum = 0
    for (const g of lignes) {
      g.part_valeur = total > 0 ? (g.valeur_stock / total) * 100 : 0
      cum += g.valeur_stock
      g.part_cumulee = total > 0 ? (cum / total) * 100 : 100
      g.classe_pareto = g.part_cumulee <= cfg.seuil_abc_a * 100 ? 'A'
        : g.part_cumulee <= cfg.seuil_abc_b * 100 ? 'B' : 'C'
    }
    groupes.push(...lignes)
  }

  // ── Agents ───────────────────────────────────────────────────────────
  const findings = lancerAgents(pieces, groupes, cfg, {
    moisFin, moisPresents12, moisManquants12, nbMois12, debutHistorique,
  }, log)

  // ── KPIs d'en-tête ───────────────────────────────────────────────────
  const valeurTotale = pieces.reduce((s, p) => s + p.valeur_stock, 0)
  const valeurHorsPerimetre = pieces.reduce((s, p) => s + (p.statut === 'hors_perimetre' ? p.valeur_stock : 0), 0)
  const cogsTotal = pieces.reduce((s, p) => s + p.ventes_12m_cogs, 0) * (12 / nbMois12)
  const fournGroupes = groupes.filter(g => g.dimension === 'fournisseur')
  const stockMoyenGlobal = fournGroupes.reduce((s, g) => s + g.stock_moyen, 0)

  const kpis = {
    mois_fin: moisFin,
    mois_presents: moisPresents12,
    mois_manquants: moisManquants12,
    couverture_donnees: `${moisPresents12.length}/12`,
    nb_pieces: pieces.length,
    nb_pieces_stock: pieces.filter(p => p.stock > 0).length,
    nb_fournisseurs: fournGroupes.length,
    nb_lignes: groupes.filter(g => g.dimension === 'ligne').length,
    valeur_stock: valeurTotale,
    valeur_hors_perimetre: valeurHorsPerimetre,
    valeur_suivie: valeurTotale - valeurHorsPerimetre,
    lignes_hors_perimetre: cfg.lignes_hors_perimetre,
    profondeur_historique: debutHistorique,
    cogs_annualise: cogsTotal,
    stock_moyen: stockMoyenGlobal,
    rotation_globale: stockMoyenGlobal > 0 ? cogsTotal / stockMoyenGlobal : 0,
    dsi_global: stockMoyenGlobal > 0 && cogsTotal > 0 ? 365 / (cogsTotal / stockMoyenGlobal) : null,
    nb_snapshots: e.moisSnapshots.length,
    valeur_morte: pieces.reduce((s, p) => s + p.valeur_morte, 0),
    valeur_dormante: pieces.reduce((s, p) => s + p.valeur_dormante, 0),
    valeur_exces: pieces.reduce((s, p) => s + p.exces_valeur, 0),
    nb_rupture: pieces.filter(p => p.statut === 'rupture').length,
    nb_sur_commande: pieces.filter(p => p.statut === 'sur_commande').length,
    nb_hors_perimetre: pieces.filter(p => p.statut === 'hors_perimetre').length,
    nb_sous_stock: pieces.filter(p => p.statut === 'sous_stock').length,
    nb_surstock: pieces.filter(p => p.statut === 'surstock').length,
    nb_mort: pieces.filter(p => ['mort', 'jamais_vendue'].includes(p.statut)).length,
    nb_dormant: pieces.filter(p => p.statut === 'dormant').length,
    impact_total: findings.reduce((s, f) => s + f.impact_dollars, 0),
  }

  return { pieces, groupes, findings, kpis, log }
}

// ═══════════════════════════════════════════════════════════════════════
// Les agents supply chain
// ═══════════════════════════════════════════════════════════════════════

const arg = (v: number) => Math.round(v).toLocaleString('fr-CA') + ' $'
const nb = (v: number, d = 1) => v.toLocaleString('fr-CA', { maximumFractionDigits: d })

interface CtxAgents {
  moisFin: string
  moisPresents12: string[]
  moisManquants12: string[]
  nbMois12: number
  debutHistorique: string
}

/**
 * Chaque agent est un point de vue autonome sur le même jeu de données. Il ne
 * sort pas une liste brute : il sort des CONSTATS — ce qu'il voit, pourquoi
 * c'est un problème, ce que ça coûte, et quoi faire. Les constats sont triés
 * par impact en dollars, tous agents confondus, pour que le premier écran
 * montre l'argent le plus vite récupérable.
 */
function lancerAgents(
  pieces: AnalysePiece[],
  groupes: AnalyseGroupe[],
  cfg: ScConfig,
  ctx: CtxAgents,
  log: string[],
): Finding[] {
  const out: Finding[] = []
  const fournisseurs = groupes.filter(g => g.dimension === 'fournisseur')
  const valeurTotale = pieces.reduce((s, p) => s + p.valeur_stock, 0)

  const push = (f: Finding) => out.push(f)
  const topN = <T,>(arr: T[], n: number, cmp: (a: T, b: T) => number) => [...arr].sort(cmp).slice(0, n)

  // ─── AGENT PARETO ────────────────────────────────────────────────────
  // Vérifie que l'effort de gestion suit la concentration réelle du capital.
  {
    const pA = pieces.filter(p => p.classe_abc === 'A')
    const partA = pieces.length ? (pA.length / pieces.length) * 100 : 0
    const valA = pA.reduce((s, p) => s + p.valeur_stock, 0)

    push({
      agent: 'pareto', severite: 'info', code_piece: null, fournisseur: null, code_ligne: null,
      titre: `${pA.length} pièces (${nb(partA)} % du catalogue suivi) portent 80 % de la consommation`,
      detail: `Classement ABC sur le coût des ventes annualisé. Ces pièces A immobilisent ${arg(valA)} `
        + `soit ${nb(valeurTotale > 0 ? (valA / valeurTotale) * 100 : 0)} % de la valeur d'inventaire. `
        + `Les pièces C représentent le reste du catalogue pour 5 % de la consommation.`,
      action: `Concentrer les comptages cycliques et les révisions de min/max sur les ${pA.length} pièces A `
        + `(comptage mensuel), B au trimestre, C à l'année.`,
      impact_dollars: 0,
      donnees: { nb_a: pA.length, nb_b: pieces.filter(p => p.classe_abc === 'B').length, valeur_a: valA },
    })

    // Fournisseurs qui immobilisent beaucoup sans faire tourner : le croisement
    // « part du stock » vs « part de la consommation » est le vrai signal.
    const consoTotale = fournisseurs.reduce((s, g) => s + g.ventes_12m_cogs, 0)
    const desequilibres = fournisseurs.filter(g => {
      if (g.valeur_stock < 10000) return false
      const partStock = valeurTotale > 0 ? g.valeur_stock / valeurTotale : 0
      const partConso = consoTotale > 0 ? g.ventes_12m_cogs / consoTotale : 0
      return partStock > 2 * Math.max(partConso, 0.0001)
    })
    for (const g of topN(desequilibres, 10, (a, b) => b.valeur_stock - a.valeur_stock)) {
      const partStock = valeurTotale > 0 ? (g.valeur_stock / valeurTotale) * 100 : 0
      const partConso = consoTotale > 0 ? (g.ventes_12m_cogs / consoTotale) * 100 : 0
      push({
        agent: 'pareto', severite: 'attention', code_piece: null, fournisseur: g.cle, code_ligne: null,
        titre: `${g.cle} : ${nb(partStock)} % du stock pour ${nb(partConso)} % de la consommation`,
        detail: `${arg(g.valeur_stock)} immobilisés chez ce fournisseur alors qu'il ne représente que `
          + `${arg(g.ventes_12m_cogs)} de coût des ventes sur 12 mois (rotation ${nb(g.rotation, 2)}).`,
        action: `Renégocier les quantités minimales de commande, ou étaler les achats. `
          + `Cible : ramener la part de stock au niveau de la part de consommation.`,
        impact_dollars: g.valeur_stock - (consoTotale > 0 ? (g.ventes_12m_cogs / consoTotale) * valeurTotale : 0),
        donnees: { part_stock: partStock, part_conso: partConso, rotation: g.rotation },
      })
    }
  }

  // ─── AGENT ROTATION ──────────────────────────────────────────────────
  // Le roulement : combien de fois le stock se renouvelle par an.
  {
    const sansSnapshot = fournisseurs.every(g => g.nb_snapshots === 0)
    if (sansSnapshot) {
      push({
        agent: 'rotation', severite: 'info', code_piece: null, fournisseur: null, code_ligne: null,
        titre: 'Rotation calculée sur le stock instantané (aucun snapshot mensuel encore archivé)',
        detail: `Le vrai roulement se calcule sur le stock MOYEN de la période. Tant qu'il n'y a pas `
          + `plusieurs photos mensuelles, on utilise le stock du jour : le chiffre est correct en ordre `
          + `de grandeur mais sensible aux réceptions récentes.`,
        action: `Le snapshot du 1er du mois est automatique. Après 3 mois, la rotation devient fiable ; `
          + `après 12, elle est exacte.`,
        impact_dollars: 0, donnees: {},
      })
    }

    // Rotation < 1 = plus d'un an pour écouler le stock.
    const lents = fournisseurs.filter(g => g.valeur_stock >= 5000 && g.rotation < 1 && g.ventes_12m_cogs > 0)
    for (const g of topN(lents, 15, (a, b) => b.valeur_stock - a.valeur_stock)) {
      const capitalLibere = g.valeur_stock - g.ventes_12m_cogs / 4 // cible : rotation 4
      push({
        agent: 'rotation', severite: g.rotation < 0.5 ? 'critique' : 'attention',
        code_piece: null, fournisseur: g.cle, code_ligne: null,
        titre: `${g.cle} : rotation ${nb(g.rotation, 2)}×/an — ${g.dsi_jours ? Math.round(g.dsi_jours) : '∞'} jours de stock`,
        detail: `${arg(g.valeur_stock)} de stock pour ${arg(g.ventes_12m_cogs)} de coût des ventes annuel `
          + `(${g.nb_pieces_stock} pièces). Le stock met plus d'un an à s'écouler.`,
        action: `Passer à une rotation cible de 4×/an libérerait ${arg(Math.max(0, capitalLibere))} de trésorerie. `
          + `Commencer par les ${g.nb_surstock} pièces en surstock et les ${g.nb_mort} pièces sans mouvement.`,
        impact_dollars: Math.max(0, capitalLibere),
        donnees: { rotation: g.rotation, dsi: g.dsi_jours, valeur: g.valeur_stock },
      })
    }

    // Codes de ligne les plus lents — l'autre angle demandé.
    const lignesLentes = groupes.filter(g => g.dimension === 'ligne' && g.valeur_stock >= 10000 && g.rotation < 1.5)
    for (const g of topN(lignesLentes, 8, (a, b) => b.valeur_stock - a.valeur_stock)) {
      push({
        agent: 'rotation', severite: 'attention', code_piece: null, fournisseur: null, code_ligne: g.cle,
        titre: `Code de ligne ${g.cle} : rotation ${nb(g.rotation, 2)}×/an sur ${arg(g.valeur_stock)}`,
        detail: `${g.nb_pieces_stock} pièces en stock, ${g.nb_mort} sans mouvement, ${g.nb_surstock} en surstock.`,
        action: `Revoir la politique d'achat de cette famille : min/max, quantité minimale imposée par le fournisseur.`,
        impact_dollars: Math.max(0, g.valeur_stock - g.ventes_12m_cogs / 4),
        donnees: { rotation: g.rotation, valeur: g.valeur_stock },
      })
    }
  }

  // ─── AGENT WILSON (quantité économique de commande) ───────────────────
  {
    // Pièces où la pratique actuelle (min/max Traction) s'écarte fortement de
    // l'optimum économique. Le coût d'un écart = surcoût de possession OU
    // surcoût de passation selon le sens.
    const candidats = pieces.filter(p =>
      p.eoq > 0 && p.classe_abc !== 'C' && p.cout_unitaire > 0 && p.qte_max > 0)

    const ecarts = candidats.map(p => {
      // Coût total annuel = (D/Q)·S + (Q/2)·H, évalué à la pratique vs à l'optimum.
      const D = p.demande_mens * 12
      const H = cfg.taux_possession * p.cout_unitaire
      const S = cfg.cout_commande
      const coutTotal = (Q: number) => Q > 0 ? (D / Q) * S + (Q / 2) * H : Infinity
      const qPratique = p.qte_max
      const surcout = coutTotal(qPratique) - coutTotal(p.eoq)
      return { p, surcout, qPratique }
    }).filter(x => Number.isFinite(x.surcout) && x.surcout > 25)

    for (const { p, surcout, qPratique } of topN(ecarts, 25, (a, b) => b.surcout - a.surcout)) {
      const sens = qPratique > p.eoq ? 'trop grosses' : 'trop petites'
      push({
        agent: 'wilson', severite: surcout > 200 ? 'attention' : 'info',
        code_piece: p.code_piece, fournisseur: p.fournisseur, code_ligne: p.code_ligne,
        titre: `${p.code_piece} : commandes ${sens} — optimum ${p.eoq} u au lieu de ${qPratique}`,
        detail: `Demande ${nb(p.demande_mens * 12, 0)} u/an, coût unitaire ${arg(p.cout_unitaire)}. `
          + `Wilson : Q* = √(2 × ${nb(p.demande_mens * 12, 0)} × ${cfg.cout_commande} ÷ `
          + `(${nb(cfg.taux_possession * 100, 0)} % × ${nb(p.cout_unitaire, 2)})) = ${p.eoq} u, `
          + `soit ${nb(p.nb_commandes_an, 1)} commandes/an.`,
        action: qPratique > p.eoq
          ? `Baisser le max Traction à ${p.eoq} : ${arg(surcout)}/an de frais de possession en moins.`
          : `Monter le max Traction à ${p.eoq} : ${arg(surcout)}/an de frais de commande en moins.`,
        impact_dollars: surcout,
        donnees: { eoq: p.eoq, qte_max: qPratique, surcout_annuel: surcout },
      })
    }

    // Pièces A sans min/max paramétré : le pilotage est fait à l'œil.
    const sansParam = pieces.filter(p => p.classe_abc === 'A' && p.qte_max === 0 && p.qte_min === 0)
    if (sansParam.length > 0) {
      const val = sansParam.reduce((s, p) => s + p.ventes_12m_cogs, 0)
      push({
        agent: 'wilson', severite: 'attention', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${sansParam.length} pièces de classe A sans min/max dans Traction`,
        detail: `Ces pièces portent ${arg(val)} de coût des ventes sur la fenêtre et sont réapprovisionnées `
          + `sans seuil paramétré — donc au jugé, avec un risque de rupture ou de surcommande.`,
        action: `Saisir le point de commande calculé (colonne « PC ») comme min et l'EOQ comme quantité de commande.`,
        impact_dollars: 0,
        donnees: { codes: sansParam.slice(0, 50).map(p => p.code_piece) },
      })
    }
  }

  // ─── AGENT SERVICE (stock de sécurité / réappro) ──────────────────────
  {
    const aCommander = pieces.filter(p => p.qte_a_commander > 0)
    const valeurACommander = aCommander.reduce((s, p) => s + p.qte_a_commander * p.cout_unitaire, 0)
    if (aCommander.length > 0) {
      push({
        agent: 'service', severite: 'info', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${aCommander.length} pièces sous leur point de commande`,
        detail: `Réapprovisionnement suggéré : ${arg(valeurACommander)} pour tenir un niveau de service de `
          + `${nb(cfg.niveau_service * 100, 0)} % (Z = ${nb(zScore(cfg.niveau_service), 2)}) avec un délai `
          + `fournisseur de ${cfg.delai_jours} jours.`,
        action: `Trier par fournisseur pour regrouper les commandes et atteindre les francos de port.`,
        impact_dollars: 0,
        donnees: { nb: aCommander.length, valeur: valeurACommander },
      })
    }

    // Pièces A/X (forte consommation, demande régulière) en dessous du seuil :
    // la combinaison la plus coûteuse en ventes perdues.
    const critiques = pieces.filter(p =>
      p.classe_abc === 'A' && (p.statut === 'rupture' || p.statut === 'sous_stock'))
    for (const p of topN(critiques, 30, (a, b) => b.score_urgence - a.score_urgence)) {
      const margeUnitaire = Math.max(0, p.prix_vente - p.cout_unitaire)
      const perteMens = margeUnitaire * p.demande_mens
      push({
        agent: 'service', severite: p.statut === 'rupture' ? 'critique' : 'attention',
        code_piece: p.code_piece, fournisseur: p.fournisseur, code_ligne: p.code_ligne,
        titre: `${p.code_piece} (A/${p.classe_xyz}) — ${p.statut === 'rupture' ? 'EN RUPTURE' : `stock ${nb(p.stock, 0)} sous le seuil ${p.point_commande}`}`,
        detail: `${p.description || 'sans description'} · demande ${nb(p.demande_mens, 1)} u/mois, `
          + `stock de sécurité ${p.stock_securite} u, point de commande ${p.point_commande} u. `
          + (p.qte_commande + p.qte_transit > 0
              ? `${nb(p.qte_commande + p.qte_transit, 0)} u déjà en commande/transit.`
              : `Rien en commande.`),
        action: `Commander ${p.qte_a_commander} u chez ${p.fournisseur}.`
          + (perteMens > 0 ? ` Marge exposée : ${arg(perteMens)}/mois de ventes manquées.` : ''),
        impact_dollars: perteMens * 3, // exposition sur un trimestre
        donnees: { stock: p.stock, pc: p.point_commande, ss: p.stock_securite, a_commander: p.qte_a_commander },
      })
    }
  }

  // ─── AGENT SURSTOCK (excédent / E&O) ─────────────────────────────────
  {
    const surstock = pieces.filter(p => p.exces_valeur > 0)
    const totalExces = surstock.reduce((s, p) => s + p.exces_valeur, 0)
    if (surstock.length > 0) {
      push({
        agent: 'surstock', severite: totalExces > 100000 ? 'critique' : 'attention',
        code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${arg(totalExces)} de stock au-delà de ${cfg.horizon_surstock_mois} mois de couverture`,
        detail: `${surstock.length} pièces dépassent l'horizon cible. Au taux de possession de `
          + `${nb(cfg.taux_possession * 100, 0)} %/an, cet excédent coûte `
          + `${arg(totalExces * cfg.taux_possession)}/an rien qu'à être entreposé.`,
        action: `Suspendre le réapprovisionnement de ces pièces, vérifier ce qui est encore retournable, `
          + `et cibler les plus grosses lignes pour une liquidation.`,
        impact_dollars: totalExces,
        donnees: { nb: surstock.length, cout_possession_annuel: totalExces * cfg.taux_possession },
      })
    }
    for (const p of topN(surstock, 40, (a, b) => b.exces_valeur - a.exces_valeur)) {
      push({
        agent: 'surstock', severite: p.exces_valeur > 5000 ? 'critique' : 'attention',
        code_piece: p.code_piece, fournisseur: p.fournisseur, code_ligne: p.code_ligne,
        titre: `${p.code_piece} : ${nb(p.exces_unites, 0)} u en trop (${arg(p.exces_valeur)})`,
        detail: `Stock ${nb(p.stock, 0)} u pour une demande de ${nb(p.demande_mens, 1)} u/mois `
          + `→ ${p.couverture_mois ? nb(p.couverture_mois, 0) : '∞'} mois de couverture. `
          + `Cible : ${nb(p.demande_mens * cfg.horizon_surstock_mois + p.stock_securite, 0)} u.`,
        action: `Ne plus commander. Retour fournisseur ou liquidation de ${nb(p.exces_unites, 0)} u.`,
        impact_dollars: p.exces_valeur,
        donnees: { stock: p.stock, couverture: p.couverture_mois, exces: p.exces_unites },
      })
    }
  }

  // ─── AGENT STOCK MORT ────────────────────────────────────────────────
  {
    const morts = pieces.filter(p => p.statut === 'mort' || p.statut === 'jamais_vendue')
    const dormants = pieces.filter(p => p.statut === 'dormant')
    const valMort = morts.reduce((s, p) => s + p.valeur_stock, 0)
    const valDormant = dormants.reduce((s, p) => s + p.valeur_stock, 0)

    if (morts.length > 0) {
      const nbJamais = morts.filter(p => p.statut === 'jamais_vendue').length
      push({
        agent: 'stock_mort', severite: 'critique', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${arg(valMort)} de stock sans aucune vente depuis ${cfg.mois_stock_mort} mois`,
        detail: `${morts.length} pièces, dont ${nbJamais} qui n'apparaissent dans AUCUN rapport de vente `
          + `depuis ${ctx.debutHistorique} — c'est la profondeur de l'historique importé, pas une preuve `
          + `qu'elles n'ont jamais été vendues avant. Ce capital ne tourne pas et coûte `
          + `${arg(valMort * cfg.taux_possession)}/an de possession.`,
        action: `Décision à prendre pièce par pièce : retour fournisseur, liquidation, ou radiation comptable. `
          + `Regrouper par fournisseur pour négocier un retour en bloc.`,
        impact_dollars: valMort,
        donnees: { nb: morts.length, nb_jamais_vendues: nbJamais, valeur: valMort, historique_depuis: ctx.debutHistorique },
      })
    }
    if (dormants.length > 0) {
      push({
        agent: 'stock_mort', severite: 'attention', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${arg(valDormant)} dormant — aucune vente sur 12 mois mais mouvement il y a moins de 24 mois`,
        detail: `${dormants.length} pièces. Elles ne sont pas encore mortes, mais elles y vont.`,
        action: `Les surveiller : si rien ne bouge d'ici ${cfg.mois_stock_mort - 12} mois, elles basculeront en stock mort.`,
        impact_dollars: valDormant * 0.5,
        donnees: { nb: dormants.length, valeur: valDormant },
      })
    }

    // Par fournisseur — pour pouvoir décrocher le téléphone.
    const parFourn = new Map<string, { val: number; nb: number }>()
    for (const p of morts) {
      const e = parFourn.get(p.fournisseur) || { val: 0, nb: 0 }
      e.val += p.valeur_stock; e.nb++
      parFourn.set(p.fournisseur, e)
    }
    for (const [f, v] of topN([...parFourn.entries()], 15, (a, b) => b[1].val - a[1].val)) {
      if (v.val < 2000) continue
      push({
        agent: 'stock_mort', severite: 'attention', code_piece: null, fournisseur: f, code_ligne: null,
        titre: `${f} : ${arg(v.val)} de stock mort sur ${v.nb} pièces`,
        detail: `Aucune vente depuis au moins ${cfg.mois_stock_mort} mois sur ces références.`,
        action: `Négocier un retour groupé ou un échange de marchandise avec ${f}.`,
        impact_dollars: v.val,
        donnees: { nb: v.nb, valeur: v.val },
      })
    }
  }

  // ─── AGENT RUPTURE ───────────────────────────────────────────────────
  {
    const ruptures = pieces.filter(p => p.statut === 'rupture')
    const surCommande = pieces.filter(p => p.statut === 'sur_commande')
    const perteMens = ruptures.reduce((s, p) =>
      s + Math.max(0, p.prix_vente - p.cout_unitaire) * p.demande_mens, 0)
    if (ruptures.length > 0) {
      push({
        agent: 'rupture', severite: 'critique', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${ruptures.length} pièces tenues en stock sont tombées à zéro`,
        detail: `Marge exposée estimée : ${arg(perteMens)}/mois (marge unitaire × demande mensuelle). `
          + `${ruptures.filter(p => p.qte_commande + p.qte_transit > 0).length} ont déjà une commande en cours. `
          + `${surCommande.length} autres pièces sont à zéro mais vendues une seule fois et sans min/max : `
          + `traitées comme des commandes spéciales, pas comme des ruptures.`,
        action: `Traiter en priorité les ${ruptures.filter(p => p.classe_abc === 'A').length} pièces de classe A `
          + `sans commande en cours.`,
        impact_dollars: perteMens * 12,
        donnees: { nb: ruptures.length, nb_sur_commande: surCommande.length, perte_mensuelle: perteMens },
      })
    }
  }

  // ─── AGENT FIABILITÉ (qualité des données) ───────────────────────────
  {
    if (ctx.moisManquants12.length > 0) {
      push({
        agent: 'fiabilite', severite: ctx.moisManquants12.length > 3 ? 'critique' : 'attention',
        code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${ctx.moisManquants12.length} mois de ventes manquants sur les 12 de la fenêtre`,
        detail: `Manquants : ${ctx.moisManquants12.join(', ')}. La demande est calculée sur les `
          + `${ctx.nbMois12} mois réellement importés (et non divisée par 12), donc elle reste juste en `
          + `moyenne — mais la saisonnalité et l'écart-type sont estimés sur moins de points.`,
        action: `Importer les rapports 2891 manquants depuis l'onglet, un fichier par mois.`,
        impact_dollars: 0,
        donnees: { manquants: ctx.moisManquants12 },
      })
    }

    const hors = pieces.filter(p => p.statut === 'hors_perimetre')
    if (hors.length > 0) {
      const val = hors.reduce((s, p) => s + p.valeur_stock, 0)
      push({
        agent: 'fiabilite', severite: 'info', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${arg(val)} de stock exclu de l'analyse (lignes ${cfg.lignes_hors_perimetre.join(', ')})`,
        detail: `${hors.length} pièces sur ces codes de ligne. Leur stock est bien réel et compte dans la `
          + `valeur d'inventaire, mais leurs ventes passent par Amazon et non par le rapport 2891 : les `
          + `inclure les ferait toutes classer « jamais vendues » et gonflerait le stock mort d'autant.`,
        action: `Suivre la rotation de ces pièces dans l'onglet Amazon. La liste des lignes exclues se règle `
          + `dans les paramètres du module.`,
        impact_dollars: 0,
        donnees: { nb: hors.length, valeur: val, lignes: cfg.lignes_hors_perimetre },
      })
    }

    const sansCout = pieces.filter(p => p.stock > 0 && p.cout_unitaire <= 0)
    if (sansCout.length > 0) {
      push({
        agent: 'fiabilite', severite: 'attention', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${sansCout.length} pièces en stock avec un coût unitaire à 0 $`,
        detail: `Ces pièces (${nb(sansCout.reduce((s, p) => s + p.stock, 0), 0)} unités) ne comptent pour rien `
          + `dans la valeur d'inventaire ni dans le calcul de rotation. La valeur réelle du stock est sous-évaluée.`,
        action: `Corriger le PrixCoutant dans Traction. Sans coût, ni Wilson ni la rotation ne peuvent être calculés.`,
        impact_dollars: 0,
        donnees: { codes: sansCout.slice(0, 50).map(p => p.code_piece) },
      })
    }

    const sansFournisseur = pieces.filter(p => p.stock > 0 && p.fournisseur === 'Non assigné')
    if (sansFournisseur.length > 0) {
      const val = sansFournisseur.reduce((s, p) => s + p.valeur_stock, 0)
      push({
        agent: 'fiabilite', severite: 'attention', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${sansFournisseur.length} pièces en stock sans fournisseur (${arg(val)})`,
        detail: `Impossible de les rattacher à une politique d'achat, à un délai de livraison ou à un retour.`,
        action: `Assigner un PKFournisseur dans Traction, ou compléter la table de correspondance des fournisseurs.`,
        impact_dollars: 0,
        donnees: { nb: sansFournisseur.length, valeur: val },
      })
    }

    const negatifs = pieces.filter(p => p.stock < 0)
    if (negatifs.length > 0) {
      push({
        agent: 'fiabilite', severite: 'attention', code_piece: null, fournisseur: null, code_ligne: null,
        titre: `${negatifs.length} pièces en stock négatif`,
        detail: `Un stock négatif fausse la valeur d'inventaire et rend la couverture ininterprétable. `
          + `Ces pièces sont exclues des calculs d'excédent.`,
        action: `Voir l'onglet Pièces Négatives — chaque négatif est un écart d'inventaire à corriger.`,
        impact_dollars: 0,
        donnees: { nb: negatifs.length },
      })
    }
  }

  out.sort((a, b) => {
    const rang = { critique: 0, attention: 1, info: 2 }
    return rang[a.severite] - rang[b.severite] || b.impact_dollars - a.impact_dollars
  })
  log.push(`${out.length} constats produits par les agents`)
  return out
}
