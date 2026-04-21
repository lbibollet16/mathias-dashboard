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

const MARQUES_DOUBLES = new Set(['CF MOTO'])
const STOCK_RE = /^P?\d{2}-\d{4}[A-Z]?$/
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
  if (tokens.length < 10) return null

  // Pop NbJours (entier)
  const nbJoursTok = tokens.pop()!
  if (!/^\d+$/.test(nbJoursTok)) return null
  const nbJours = parseInt(nbJoursTok, 10)

  // Pop %Profit, ProfitNet, Totales (3 numériques)
  const peekNum = (off: number) => tokens.length >= off && isNum(tokens[tokens.length - off])
  if (!peekNum(1) || !peekNum(2) || !peekNum(3)) return null
  const pctProfit = parseNum(tokens.pop()!)
  const profitNetTotal = parseNum(tokens.pop()!)
  const ventesTotales = parseNum(tokens.pop()!)

  // Détection FNI : si on a encore 6 numériques consécutifs (3 FNI + 3 Véh)
  // alors que sans FNI on n'en a que 3. On regarde si le 4e à partir de la
  // fin est numérique → indique FNI présent.
  let ventesFni = 0, profitFni = 0, pctBrutFni = 0
  if (peekNum(1) && peekNum(2) && peekNum(3) && peekNum(4) && peekNum(5) && peekNum(6)) {
    pctBrutFni = parseNum(tokens.pop()!)
    profitFni = parseNum(tokens.pop()!)
    ventesFni = parseNum(tokens.pop()!)
  }

  // Pop %Brut véhicule, Profit véhicule, Prix
  if (!peekNum(1) || !peekNum(2) || !peekNum(3)) return null
  const pctBrut = parseNum(tokens.pop()!)
  const profitVeh = parseNum(tokens.pop()!)
  const prixVente = parseNum(tokens.pop()!)

  // Pop #Contrat (toujours présent)
  if (tokens.length === 0) return null
  const numContrat = tokens.pop()!

  // Pop année (token pur "2024" ou collé au modèle "Premium2026")
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
  if (annee === null) return null

  // Restant : [Client..., #Stock, Marque, Modele...]
  const stockIdx = tokens.findIndex(t => STOCK_RE.test(t))
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

  return {
    date_vente: date,
    client,
    stock_num: stockNum,
    marque: marque.trim(),
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
