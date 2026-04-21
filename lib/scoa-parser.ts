// Parser des rapports SCOA (Analyse des Ventes) en PDF.
//
// Quirk de pdf-parse : pour chaque ligne de vente, le texte est extrait en
// deux morceaux séparés par \t. La section principale contient la plupart
// des colonnes, mais #Contrat, Profit Véhicule et Profit FNI sont tab-séparés
// et apparaissent APRES le reste. Le parser recolle les morceaux.

import { PDFParse } from 'pdf-parse'

export interface ParsedSale {
  date_vente: string        // YYYY-MM-DD
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
  periode_debut: string | null   // YYYY-MM-DD
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
  const m = /^Du\s+(\d+)\s+(\w+)\s+(\d{4})\s+au\s+(\d+)\s+(\w+)\s+(\d{4})/i.exec(line.trim())
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
  const rest = dm[2]

  const parts = rest.split('\t')
  const mainPart = parts[0].trim()
  const extrasStr = parts.slice(1).join(' ').trim()
  const extras = extrasStr.split(/\s+/).filter(Boolean)

  // Extras attendus : [#Contrat, ProfitVeh, (ProfitFNI si FNI)]
  if (extras.length < 2) return null
  const numContrat = extras[0]
  if (!isNum(extras[1])) return null
  const profitVeh = parseNum(extras[1])
  const hasFni = extras.length >= 3 && isNum(extras[2])
  const profitFni = hasFni ? parseNum(extras[2]) : 0

  const tokens = mainPart.split(/\s+/)
  if (tokens.length < 8) return null

  // Pop NbJours
  const nbJoursTok = tokens.pop()!
  if (!/^\d+$/.test(nbJoursTok)) return null
  const nbJours = parseInt(nbJoursTok, 10)

  // Pop %Profit, ProfitNet, Totales
  if (!isNum(tokens[tokens.length - 1])) return null
  const pctProfit = parseNum(tokens.pop()!)
  if (!isNum(tokens[tokens.length - 1])) return null
  const profitNetTotal = parseNum(tokens.pop()!)
  if (!isNum(tokens[tokens.length - 1])) return null
  const ventesTotales = parseNum(tokens.pop()!)

  // Pop FNI (%BrutFNI, VentesFNI) si présent
  let ventesFni = 0, pctBrutFni = 0
  if (hasFni) {
    if (!isNum(tokens[tokens.length - 1])) return null
    pctBrutFni = parseNum(tokens.pop()!)
    if (!isNum(tokens[tokens.length - 1])) return null
    ventesFni = parseNum(tokens.pop()!)
  }

  // Pop %Brut, Prix
  if (!isNum(tokens[tokens.length - 1])) return null
  const pctBrut = parseNum(tokens.pop()!)
  if (!isNum(tokens[tokens.length - 1])) return null
  const prixVente = parseNum(tokens.pop()!)

  // Année : soit token pur '2024', soit collé au modèle 'Premium2026'
  let annee: number | null = null
  const lastTok = tokens[tokens.length - 1]
  const pureYear = /^(\d{4})$/.exec(lastTok)
  if (pureYear) {
    const y = parseInt(pureYear[1], 10)
    if (y >= 1990 && y <= 2100) {
      annee = y
      tokens.pop()
    }
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

export async function parseScoaPdf(buffer: Buffer | Uint8Array): Promise<ParseResult> {
  try {
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    const text = result.text || ''
    const lines = text.split(/\r?\n/)

    let periode_debut: string | null = null
    let periode_fin: string | null = null
    let currentVendeur: { id: string, nom: string } | null = null
    let inExceptions = false
    const ventes: ParsedSale[] = []
    const warnings: string[] = []

    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line) continue

      // On s'arrête aux Exceptions (format différent, lignes quasi vides)
      if (/^Liste des Exceptions/i.test(line)) { inExceptions = true; continue }
      if (inExceptions) continue

      // Période
      if (!periode_debut) {
        const p = parsePeriode(line)
        if (p.debut) { periode_debut = p.debut; periode_fin = p.fin }
      }

      // Vendeur
      const vMatch = /^Vendeur\s*:\s*(\d+)\s+(.+)$/.exec(line)
      if (vMatch) {
        currentVendeur = { id: vMatch[1].trim(), nom: vMatch[2].trim() }
        continue
      }

      // Ligne de vente (ignore le header daté "YYYY-MM-DD HH:MM (52912)")
      if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(line)) continue
      if (/^\d{4}-\d{2}-\d{2}\s/.test(line)) {
        const sale = parseSaleLine(line, currentVendeur)
        if (sale) ventes.push(sale)
        else warnings.push(`Ligne non parsée : ${line.slice(0, 100)}`)
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
