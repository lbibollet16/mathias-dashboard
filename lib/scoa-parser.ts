// Parser des rapports SCOA (Analyse des Ventes) en PDF, via unpdf.
// On reconstruit les lignes en groupant les text items par coordonnée Y,
// puis on les trie par X pour avoir les colonnes dans l'ordre naturel.

import { extractTextItems } from 'unpdf'

export interface ParsedSale {
  date_vente: string
  client: string | null
  stock_num: string
  marque: string
  modele: string
  annee: number
  num_contrat: string
  vendeur_id: string | null
  vendeur_nom: string | null
  prix_vente: number
  profit_vehicule: number
  pct_brut_vehicule: number
  ventes_fni: number
  profit_fni: number
  pct_brut_fni: number
  ventes_totales: number
  profit_net_total: number
  pct_profit: number
  nb_jours: number
}

export interface ParseResult {
  success: boolean
  ventes: ParsedSale[]
  periode_debut: string | null
  periode_fin: string | null
  erreur?: string
  warnings: string[]
}

const MOIS_FR: Record<string, number> = {
  'janvier': 1, 'février': 2, 'fevrier': 2, 'mars': 3, 'avril': 4, 'mai': 5,
  'juin': 6, 'juillet': 7, 'août': 8, 'aout': 8, 'septembre': 9,
  'octobre': 10, 'novembre': 11, 'décembre': 12, 'decembre': 12,
}

const MARQUES_DOUBLES = new Set(['CF MOTO', 'CAN AM', 'SEA DOO', 'SKI DOO'])
// Stock # SCOA — formats observés :
//   "22-0980"     neuf
//   "23-1140D"    neuf vendu en occasion (suffixe lettre)
//   "P22-0980"    PS
//   "C23-0006A"   occasion (préfixe 1-3 lettres + suffixe lettre)
//   "AC25-0331"   occasion (préfixe alphanumérique)
//   "25-0457AB"   double suffixe (AB)
//   "ACP26-0002"  préfixe 3 lettres
const STOCK_RE = /^[A-Z]{0,3}\d{2}-\d{4}[A-Z]{0,2}$/
const NUM_RE = /^-?\d+(?:[.,]\d+)?$/

function parseNum(t: string): number {
  const n = parseFloat(t.replace(',', '.'))
  return isNaN(n) ? 0 : n
}
function isNum(t: string): boolean { return NUM_RE.test(t) }

function parsePeriode(line: string): { debut: string | null, fin: string | null } {
  const m = /Du\s+(\d+)\s+(\w+)\s+(\d{4})\s+au\s+(\d+)\s+(\w+)\s+(\d{4})/i.exec(line.trim())
  if (!m) return { debut: null, fin: null }
  const moisDebut = MOIS_FR[m[2].toLowerCase()]
  const moisFin = MOIS_FR[m[5].toLowerCase()]
  if (!moisDebut || !moisFin) return { debut: null, fin: null }
  const debut = `${m[3]}-${String(moisDebut).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`
  const fin = `${m[6]}-${String(moisFin).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`
  return { debut, fin }
}

function parseSaleLine(line: string, vendeur: { id: string, nom: string } | null): ParsedSale | null {
  const dm = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line)
  if (!dm) return null
  const date = dm[1]
  const rest = dm[2].trim()

  const tokens = rest.split(/\s+/)
  if (tokens.length < 6) return null

  const peekNum = (off: number) => tokens.length >= off && isNum(tokens[tokens.length - off])

  // NbJours (entier — peut être négatif si vente avant délivrance) — optionnel.
  let nbJours: number | null = null
  if (tokens.length > 0 && /^-?\d+$/.test(tokens[tokens.length - 1])) {
    nbJours = parseInt(tokens.pop()!, 10)
  }

  // %Profit, ProfitNet, Totales (3 numériques) — optionnel, certains
  // PDF affichent une ligne incomplète. Si les 3 sont là, on les prend ;
  // sinon on met à 0 et on continue avec ce qu'on a.
  let pctProfit = 0, profitNetTotal = 0, ventesTotales = 0
  if (peekNum(1) && peekNum(2) && peekNum(3)) {
    pctProfit = parseNum(tokens.pop()!)
    profitNetTotal = parseNum(tokens.pop()!)
    ventesTotales = parseNum(tokens.pop()!)
  }

  // FNI : 3 numériques de plus (avec les 3 véhicule restants au-dessus).
  let ventesFni = 0, profitFni = 0, pctBrutFni = 0
  if (peekNum(1) && peekNum(2) && peekNum(3) && peekNum(4) && peekNum(5) && peekNum(6)) {
    pctBrutFni = parseNum(tokens.pop()!)
    profitFni = parseNum(tokens.pop()!)
    ventesFni = parseNum(tokens.pop()!)
  }

  // %Brut véhicule, Profit véhicule, Prix — au minimum on veut un prix.
  let pctBrut = 0, profitVeh = 0, prixVente = 0
  if (peekNum(1) && peekNum(2) && peekNum(3)) {
    pctBrut = parseNum(tokens.pop()!)
    profitVeh = parseNum(tokens.pop()!)
    prixVente = parseNum(tokens.pop()!)
  } else if (peekNum(1) && peekNum(2)) {
    // Cas ligne tronquée : juste prix + profit_veh
    profitVeh = parseNum(tokens.pop()!)
    prixVente = parseNum(tokens.pop()!)
  } else if (peekNum(1)) {
    prixVente = parseNum(tokens.pop()!)
  } else {
    return null  // pas même un prix → vraiment inutilisable
  }

  // Pop #Contrat (toujours présent)
  if (tokens.length === 0) return null
  const numContrat = tokens.pop()!

  // Pop année — d'abord essayer le dernier token, sinon chercher un token
  // 4 chiffres entre 1990-2100 dans les 6 derniers tokens (cas où le PDF
  // a un layout étrange : deals annulés avec colonnes mélangées).
  let annee: number | null = null
  const lastTok = tokens[tokens.length - 1] || ''
  const pureYear = /^(\d{4})$/.exec(lastTok)
  if (pureYear) {
    const y = parseInt(pureYear[1], 10)
    if (y >= 1990 && y <= 2100) { annee = y; tokens.pop() }
  }
  if (annee === null) {
    const stuck = /^(.+?)(\d{4})$/.exec(lastTok)
    if (stuck) {
      const y = parseInt(stuck[2], 10)
      if (y >= 1990 && y <= 2100) {
        annee = y
        tokens[tokens.length - 1] = stuck[1]
      }
    }
  }
  // Fallback : chercher une année plus profondément (cas malformés)
  if (annee === null) {
    for (let i = tokens.length - 1; i >= Math.max(0, tokens.length - 8); i--) {
      const m = /^(\d{4})$/.exec(tokens[i])
      if (m) {
        const y = parseInt(m[1], 10)
        if (y >= 1990 && y <= 2100) {
          annee = y
          // Retirer ce token (le splice modifie l'array en place)
          tokens.splice(i, 1)
          break
        }
      }
    }
  }
  if (annee === null) return null

  // Restant : [Client..., #Stock, Marque, Modele...]
  // On cherche le DERNIER token qui matche STOCK_RE (et non le premier) car
  // certains noms de clients contiennent des numéros qui ressemblent à des
  // stocks (« Société Auto 24-1234 Inc. ») — le vrai #Stock est toujours
  // juste avant la marque.
  // IMPORTANT : on saute le tout dernier token car la marque DOIT suivre le
  // stock. Sans ça, en cas de duplication de stock en fin de ligne (#Contrat
  // dupliqué quand le PDF a un layout étrange), on attrape la mauvaise.
  let stockIdx = -1
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (STOCK_RE.test(tokens[i])) { stockIdx = i; break }
  }
  // Fallback : si rien trouvé avec « token after stock » requis, on accepte
  // le tout dernier token (cas marginal où la marque manque dans le PDF).
  if (stockIdx < 0) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (STOCK_RE.test(tokens[i])) { stockIdx = i; break }
    }
  }
  if (stockIdx < 0) return null

  const client = tokens.slice(0, stockIdx).join(' ').replace(/[\s,]+$/, '').trim() || null
  const stockNum = tokens[stockIdx]
  const afterStock = tokens.slice(stockIdx + 1)
  if (afterStock.length === 0) return null

  let marque = afterStock[0]
  let modeleStart = 1
  if (afterStock.length >= 2) {
    const twoTok = (afterStock[0] + ' ' + afterStock[1]).toUpperCase()
    if (MARQUES_DOUBLES.has(twoTok)) {
      marque = afterStock[0] + ' ' + afterStock[1]
      modeleStart = 2
    }
  }
  const modele = afterStock.slice(modeleStart).join(' ').trim()

  // Convention SCOA : tout #Stock contenant au moins une lettre = véhicule
  // d'occasion. Ex: "C24-0001B", "AC25-0331", "23-1140D" → OCCASION
  // (regroupés sous une marque virtuelle « OCCASION » pour les agrégats FNI).
  // Le neuf garde sa marque réelle (POLARIS, HONDA, …).
  const isOccasion = /[A-Z]/.test(stockNum)
  const marqueFinal = isOccasion ? 'OCCASION' : marque.trim()

  return {
    date_vente: date,
    client,
    stock_num: stockNum,
    marque: marqueFinal,
    modele,
    annee,
    num_contrat: numContrat,
    vendeur_id: vendeur?.id ?? null,
    vendeur_nom: vendeur?.nom ?? null,
    prix_vente: prixVente,
    profit_vehicule: profitVeh,
    pct_brut_vehicule: pctBrut,
    ventes_fni: ventesFni,
    profit_fni: profitFni,
    pct_brut_fni: pctBrutFni,
    ventes_totales: ventesTotales,
    profit_net_total: profitNetTotal,
    pct_profit: pctProfit,
    nb_jours: nbJours,
  }
}

// Reconstruit les lignes du PDF en groupant les text items par coordonnée Y
// (tolérance 2pt), puis en triant chaque ligne par X ascendant.
function buildLines(pageItems: any[]): string[] {
  const rowsByY = new Map<number, any[]>()
  for (const it of pageItems) {
    if (!it || typeof it.str !== 'string') continue
    const y = Math.round(it.y)
    // Essaye d'agréger avec une ligne existante proche (tolérance ±2)
    let bucket: number | null = null
    for (const ky of rowsByY.keys()) {
      if (Math.abs(ky - y) <= 2) { bucket = ky; break }
    }
    const key = bucket ?? y
    if (!rowsByY.has(key)) rowsByY.set(key, [])
    rowsByY.get(key)!.push(it)
  }
  const sortedYs = [...rowsByY.keys()].sort((a, b) => b - a) // haut → bas
  const lines: string[] = []
  for (const y of sortedYs) {
    const row = rowsByY.get(y)!.sort((a, b) => a.x - b.x)
    const parts: string[] = []
    let lastEnd = -Infinity
    for (const it of row) {
      const s = String(it.str).trim()
      if (!s) continue
      // Séparateur simple (un espace) entre tokens successifs
      if (parts.length > 0 && it.x - lastEnd > 0.5) parts.push(s)
      else parts.push(s)
      lastEnd = it.x + (it.width || 0)
    }
    const line = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (line) lines.push(line)
  }
  return lines
}

export async function parseScoaPdf(buffer: Buffer | Uint8Array): Promise<ParseResult> {
  try {
    // unpdf refuse Buffer directement ; on doit passer un Uint8Array "pur"
    // dont le .buffer est un ArrayBuffer (pas SharedArrayBuffer ni Buffer Node)
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as any)
    const ab = new ArrayBuffer(src.byteLength)
    const data = new Uint8Array(ab)
    data.set(src)
    const r = await extractTextItems(data)
    const warnings: string[] = []
    const ventes: ParsedSale[] = []
    let periode_debut: string | null = null
    let periode_fin: string | null = null
    let currentVendeur: { id: string, nom: string } | null = null
    let inExceptions = false

    for (let p = 0; p < r.items.length; p++) {
      const lines = buildLines(r.items[p] as any[])

      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue

        if (/Liste\s+des\s+Exceptions/i.test(line)) { inExceptions = true; continue }
        if (inExceptions) continue

        if (!periode_debut) {
          const p = parsePeriode(line)
          if (p.debut) { periode_debut = p.debut; periode_fin = p.fin }
        }

        const vMatch = /Vendeur\s*:\s*(\d+)\s+(.+?)(?:\s{2,}|\s*$)/.exec(line)
        if (vMatch && !/^\d{4}-\d{2}-\d{2}/.test(line)) {
          currentVendeur = { id: vMatch[1].trim(), nom: vMatch[2].trim() }
          continue
        }

        if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(line)) continue
        if (/^\d{4}-\d{2}-\d{2}\s/.test(line)) {
          const sale = parseSaleLine(line, currentVendeur)
          if (sale) ventes.push(sale)
          else warnings.push(`Ligne non parsée : ${line.slice(0, 120)}`)
        }
      }
    }

    return {
      success: true,
      ventes,
      periode_debut,
      periode_fin,
      warnings,
    }
  } catch (e: any) {
    return {
      success: false,
      ventes: [],
      periode_debut: null,
      periode_fin: null,
      warnings: [],
      erreur: e.message || String(e),
    }
  }
}
