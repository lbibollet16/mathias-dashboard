import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export const parseFrNum = (val: any): number => {
  if (!val && val !== 0) return 0
  if (typeof val === 'number') return val
  let s = String(val).replace(/[\s$,\u00a0]/g, '').replace(',', '.')
  if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1)
  const p = parseFloat(s)
  return isNaN(p) ? 0 : p
}

export interface ItemInventaire {
  pk: string
  desc: string
  // Prévision
  moyMois: number              // EMA - moyenne mensuelle lissée
  ventesMoyParMois: number[]   // [0..11] ventes moyennes réelles par mois calendaire
  totalCA: number              // CA annuel = sum(qte * cout) pour ABC
  // Stock
  stock: number
  fournisseur: string
  ligne: string
  cost: number
  // Classification
  classeABC: string            // A / B / C basé sur Pareto du CA
  cssABC: string
  xyz: string                  // X / Y / Z basé sur CV réel
  cssXYZ: string
  // Saisonnalité
  saison: string
  // Métriques supply chain
  roulement: number
  tendance: number
  iconeTendance: string
  cssTendance: string
  stockSecurite: number        // SS = Z × σ × √(délai)
  pointCommande: number        // PC = demande_moy × délai + SS
  scoreUrgence: number
  alerteReappro: boolean
}

export function calculerInventaire(
  ventesData: any[],
  tractionCSV: string,
  fournisseurTSV: string
): { liste_complete: ItemInventaire[]; fournisseurs: string[]; lignes: string[] } {

  // ── Paramètres supply chain ─────────────────────────────────────────
  const DELAI = 0.25    // 1 semaine = 0.25 mois
  const Z     = 1.28    // Niveau de service 90%
  const ALPHA = 0.3     // EMA - coefficient lissage

  // ── 1. Agréger les ventes par pièce ─────────────────────────────────
  // Structure: pk → { [YYYY-MM]: qte }
  const historiqueMap = new Map<string, Record<string, number>>()
  const anneesParMois: Record<number, Set<string>> = {}
  for (let i = 1; i <= 12; i++) anneesParMois[i] = new Set()

  for (const v of ventesData) {
    const code = v.code_piece
    const mois = String(v.mois || '').trim()
    const qte  = parseFrNum(v.quantite)
    if (!code || !mois) continue
    const pk = String(code).trim()
    if (pk.toLowerCase().includes('total')) continue
    const parts = mois.split('-')
    if (parts.length !== 2) continue
    const annee   = parts[0]
    const moisNum = parseInt(parts[1], 10)
    if (isNaN(moisNum) || moisNum < 1 || moisNum > 12) continue
    anneesParMois[moisNum].add(annee)
    if (!historiqueMap.has(pk)) historiqueMap.set(pk, {})
    const h = historiqueMap.get(pk)!
    h[mois] = (h[mois] || 0) + qte
  }

  // Nb d'années de données par mois calendaire (pour calculer la vraie moyenne)
  const nbAnneesParMois: number[] = []
  for (let i = 1; i <= 12; i++) nbAnneesParMois.push(Math.max(1, anneesParMois[i].size))

  // Nb total de mois de données (pour EMA et CV)
  const tousLesMois = new Set<string>()
  for (const h of historiqueMap.values()) Object.keys(h).forEach(m => tousLesMois.add(m))
  const nbMoisTotal = Math.max(1, tousLesMois.size)

  // ── 2. Parser Traction CSV ───────────────────────────────────────────
  const tractionLines = tractionCSV.split(/\r?\n/)
  const hdrs = (tractionLines[0] || '').split(';')
  const idx  = (n: string) => hdrs.findIndex(h => h.trim().toLowerCase() === n.toLowerCase())
  const iP = idx('PKCode'), iS = idx('QTYMINUSRESERVED'), iF = idx('PKFournisseur')
  const iC = idx('PrixCoutant'), iL = idx('CodeLigne'), iD = idx('DescFra')

  const dictTraction = new Map<string, any>()
  for (let i = 1; i < tractionLines.length; i++) {
    if (!tractionLines[i]?.trim()) continue
    const cols = tractionLines[i].split(';')
    if (cols.length < 5) continue
    const pk = cols[iP]?.replace(/['"]/g, '').trim()
    if (!pk) continue
    dictTraction.set(pk, {
      stock:        parseFrNum(cols[iS]),
      idFournisseur:(cols[iF] || '').replace(/['"]/g, '').trim(),
      codeLigne:    (cols[iL] || '').replace(/['"]/g, '').trim() || 'N/A',
      cost:         parseFrNum(cols[iC]),
      desc:         (cols[iD] || '').replace(/['"]/g, '').trim(),
    })
  }

  // ── 3. Parser Fournisseurs TSV ───────────────────────────────────────
  const fournisseurLines = fournisseurTSV.split(/\r?\n/)
  const dictFournisseur  = new Map<string, string>()
  for (let i = 1; i < fournisseurLines.length; i++) {
    if (!fournisseurLines[i]?.trim()) continue
    const cols = fournisseurLines[i].split('\t')
    const idF  = cols[0]?.replace(/['"]/g, '').trim()
    const nomF = cols[1]?.replace(/['"]/g, '').trim()
    if (idF && nomF) dictFournisseur.set(idF, nomF)
  }

  // ── 4. Pré-calcul ABC : CA total par pièce ──────────────────────────
  // ABC basé sur la loi de Pareto : 80/15/5 du CA total
  const caParPiece = new Map<string, number>()
  for (const [pk, hist] of historiqueMap.entries()) {
    const ti   = dictTraction.get(pk)
    const cout = ti?.cost || 0
    const totalQte = Object.values(hist).reduce((s, v) => s + v, 0)
    caParPiece.set(pk, totalQte * cout)
  }
  const caTotal = Array.from(caParPiece.values()).reduce((s, v) => s + v, 0)
  // Trier par CA décroissant pour Pareto
  const piecesSortees = Array.from(caParPiece.entries())
    .filter(([, ca]) => ca > 0)
    .sort((a, b) => b[1] - a[1])
  const seuilA = caTotal * 0.80
  const seuilB = caTotal * 0.95
  let caCumul  = 0
  const classesABC = new Map<string, string>()
  for (const [pk, ca] of piecesSortees) {
    caCumul += ca
    if      (caCumul <= seuilA) classesABC.set(pk, 'A')
    else if (caCumul <= seuilB) classesABC.set(pk, 'B')
    else                        classesABC.set(pk, 'C')
  }

  // ── 5. Calcul par pièce ──────────────────────────────────────────────
  const validItems: ItemInventaire[] = []
  const setF = new Set<string>()
  const setL = new Set<string>()

  // Calculer le mois le plus récent dans les données (pour filtre récence)
  const tousLesMoisTries = Array.from(tousLesMois).sort()
  const dernierMoisDonnees = tousLesMoisTries[tousLesMoisTries.length - 1] || '2026-01'
  const [anneeRef, moisRef] = dernierMoisDonnees.split('-').map(Number)
  // Mois il y a 6 mois par rapport aux dernières données
  const dateRef = new Date(anneeRef, moisRef - 1, 1)
  dateRef.setMonth(dateRef.getMonth() - 6)
  const moisRecenceMin = `${dateRef.getFullYear()}-${String(dateRef.getMonth() + 1).padStart(2, '0')}`

  for (const [pkClean, historique] of historiqueMap.entries()) {
    const totalQty = Object.values(historique).reduce((s, v) => s + v, 0)
    if (totalQty <= 0) continue

    // ── EMA chronologique ──────────────────────────────────────────
    const moisTries = Object.keys(historique).sort()

    // ── Règles de qualité des données ─────────────────────────────
    // R1: Fréquence minimum — au moins 4 mois distincts avec ventes
    const moisAvecVentes = moisTries.filter(m => (historique[m] || 0) > 0)
    if (moisAvecVentes.length < 4) continue

    // R2: Récence — doit avoir vendu dans les 6 derniers mois
    const derniereMomsVente = moisAvecVentes[moisAvecVentes.length - 1]
    if (derniereMomsVente < moisRecenceMin) continue

    // R3: Volume minimum — moyenne sur mois avec ventes ≥ 3 unités/mois
    const qteTotaleAvecVentes = moisAvecVentes.reduce((s, m) => s + (historique[m] || 0), 0)
    const moyenneSurMoisActifs = qteTotaleAvecVentes / moisAvecVentes.length
    if (moyenneSurMoisActifs < 3) continue
    let ema: number | null = null
    for (const m of moisTries) {
      const v = historique[m]
      ema = ema === null ? v : ALPHA * v + (1 - ALPHA) * ema
    }
    const moyEMA  = ema ?? 0
    const moyMens = totalQty / nbMoisTotal  // moyenne simple sur toute la période

    // ── Tendance : 3 derniers vs 3 précédents ──────────────────────
    const derniersMois = moisTries.slice(-6)
    let tendance = 0, iconeTendance = 'stable', cssTendance = 'stable'
    if (derniersMois.length >= 6) {
      const vR = derniersMois.slice(3).reduce((s, m) => s + (historique[m] || 0), 0) / 3
      const vP = derniersMois.slice(0, 3).reduce((s, m) => s + (historique[m] || 0), 0) / 3
      tendance  = vP > 0 ? (vR - vP) / vP : 0
      if      (tendance >  0.15) { iconeTendance = 'haut'; cssTendance = 'hausse' }
      else if (tendance < -0.15) { iconeTendance = 'bas';  cssTendance = 'baisse' }
    } else if (moisTries.length >= 2) {
      const v1 = historique[moisTries[0]] || 0
      const v2 = historique[moisTries[moisTries.length - 1]] || 0
      tendance  = v1 > 0 ? (v2 - v1) / v1 : 0
      if      (tendance >  0.15) { iconeTendance = 'haut'; cssTendance = 'hausse' }
      else if (tendance < -0.15) { iconeTendance = 'bas';  cssTendance = 'baisse' }
    }

    // ── Ventes moyennes réelles par mois calendaire ─────────────────
    // ventesMoyParMois[0] = moyenne de janvier sur toutes les années
    // RÈGLE COHÉRENCE: si vendu dans 1 seule année pour ce mois → besoin = 0 (commande ponctuelle)
    const ventesTotalesParMois = new Array(12).fill(0)
    const anneesVentesParMoisPiece: Record<number, Set<string>> = {}
    for (let i = 0; i < 12; i++) anneesVentesParMoisPiece[i] = new Set()
    for (const [moisKey, qte] of Object.entries(historique)) {
      const parts = moisKey.split('-')
      const annee = parts[0]
      const mNum = parseInt(parts[1], 10) - 1
      if (mNum >= 0 && mNum < 12 && qte > 0) {
        ventesTotalesParMois[mNum] += qte
        anneesVentesParMoisPiece[mNum].add(annee)
      }
    }
    const ventesMoyParMois = ventesTotalesParMois.map((total, i) => {
      // Si vendu dans 1 seule année pour ce mois = commande ponctuelle → 0
      if (anneesVentesParMoisPiece[i].size < 2) return 0
      return total / nbAnneesParMois[i + 1]
    })

    // ── XYZ : coefficient de variation sur ventes mensuelles ────────
    // CV = écart-type / moyenne sur tous les mois de données
    const ventesListe = moisTries.map(m => historique[m] || 0)
    const n    = ventesListe.length
    const mean = ventesListe.reduce((s, v) => s + v, 0) / Math.max(1, n)
    const variance = n > 1
      ? ventesListe.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (n - 1)  // variance corrigée
      : 0
    const ecartType = Math.sqrt(variance)
    const cv = mean > 0 ? ecartType / mean : 0

    let xyz = 'Z', cssXYZ = 'bg-C'
    if      (cv <= 0.5) { xyz = 'X'; cssXYZ = 'bg-A' }  // stable
    else if (cv <= 1.0) { xyz = 'Y'; cssXYZ = 'bg-B' }  // variable

    // ── ABC Pareto ──────────────────────────────────────────────────
    const classeABC = classesABC.get(pkClean) || 'C'
    const cssABC    = classeABC === 'A' ? 'bg-A' : classeABC === 'B' ? 'bg-B' : 'bg-C'

    // ── Stock sécurité Wilson ───────────────────────────────────────
    // SS = Z × σ_demande × √(délai en mois)
    // σ calculé sur les ventes mensuelles réelles
    const stockSecurite = Math.ceil(Z * ecartType * Math.sqrt(DELAI))

    // ── Point de commande ───────────────────────────────────────────
    // PC = demande_moyenne × délai + SS
    const pointCommande = Math.ceil(moyEMA * DELAI + stockSecurite)

    // ── Saisonnalité ────────────────────────────────────────────────
    const vE = ventesMoyParMois[4] + ventesMoyParMois[5] + ventesMoyParMois[6] + ventesMoyParMois[7]
    const vH = ventesMoyParMois[10] + ventesMoyParMois[11] + ventesMoyParMois[0] + ventesMoyParMois[1]
    let saison = 'Toutes'
    const estStockMort = classeABC === 'C' && xyz === 'Z'
    const estPrudence  = classeABC === 'C' && xyz === 'Y'
    if      (estStockMort)             saison = 'Sur Commande'
    else if (estPrudence)              saison = 'Limite 50%'
    else if (vE > vH * 2)             saison = 'Ete'
    else if (vH > vE * 2)             saison = 'Hiver'
    else if (xyz === 'Y' || xyz === 'Z') saison = 'Variable'

    // ── Croisement Traction ─────────────────────────────────────────
    const ti = dictTraction.get(pkClean) || { stock: 0, idFournisseur: null, codeLigne: 'N/A', cost: 0, desc: '' }
    let nomF = 'Non Assigne'
    if (ti.idFournisseur) nomF = dictFournisseur.get(ti.idFournisseur) || ('ID:' + ti.idFournisseur)

    const vA = moyEMA * 12
    let roulement = ti.stock > 0 ? vA / ti.stock : (vA > 0 ? 99 : 0)

    // ── Score urgence composite ─────────────────────────────────────
    const roulTemp    = moyEMA * 12 / Math.max(1, ti.stock)
    const scoreUrgence =
      (classeABC === 'A' ? 30 : classeABC === 'B' ? 15 : 0) +
      (xyz === 'X' ? 20 : xyz === 'Y' ? 10 : 0) +
      (tendance >  0.15 ? 15 : tendance < -0.15 ? -10 : 0) +
      (roulTemp > 12 ? 20 : roulTemp > 6 ? 10 : 0) +
      (ti.stock <= pointCommande ? 15 : 0)

    const alerteReappro = !estStockMort && ti.stock <= pointCommande && pointCommande > 0

    validItems.push({
      pk: pkClean, desc: ti.desc, moyMois: moyEMA,
      ventesMoyParMois,
      totalCA: caParPiece.get(pkClean) || 0,
      stock: ti.stock, fournisseur: nomF, ligne: ti.codeLigne, cost: ti.cost,
      classeABC, cssABC, xyz, cssXYZ, saison, roulement,
      tendance: Math.round(tendance * 100), iconeTendance, cssTendance,
      stockSecurite, pointCommande, scoreUrgence, alerteReappro
    })

    setF.add(nomF)
    if (ti.codeLigne && ti.codeLigne !== 'N/A') setL.add(ti.codeLigne)
  }

  // Trier par score urgence décroissant, puis CA décroissant
  validItems.sort((a, b) => b.scoreUrgence - a.scoreUrgence || b.totalCA - a.totalCA)

  return {
    liste_complete: validItems,
    fournisseurs: Array.from(setF).sort(),
    lignes: Array.from(setL).sort()
  }
}
