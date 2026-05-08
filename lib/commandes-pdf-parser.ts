// Parser des PDF "Liste des commandes" Traction.
// Mêmes principes que scoa-parser : on extrait les text items via unpdf,
// on les regroupe par coordonnée Y (tolérance ±2pt), on trie par X
// pour reconstruire les lignes du tableau, puis on parse.
//
// Colonnes attendues (dans cet ordre dans le PDF Traction) :
//   #Commande | Statut | Date | #Fourn | Nom | Commandé Par |
//   #Pièce | Qte Comm | Description | Nom Employé
//
// Une ligne = une (#commande, #piece). Une même #commande peut donc
// apparaître plusieurs fois (plusieurs pièces sur la même commande).

import { extractTextItems } from 'unpdf'

export interface ParsedCommande {
  num_commande:     string
  statut:           string
  date_commande:    string | null      // YYYY-MM-DD
  num_fournisseur:  string | null
  nom_fournisseur:  string | null
  commande_par:     string | null
  num_piece:        string
  qte_commandee:    number
  description:      string | null
  nom_employe:      string | null
}

export interface CommandesParseResult {
  success:    boolean
  commandes:  ParsedCommande[]
  rawLines:   string[]                 // pour debug / mode diagnostic
  warnings:   string[]
  erreur?:    string
}

// Format Traction : M1C suivi de chiffres (ex: M1C0036824).
// On reste tolérant : préfixe alphanumérique de 2-4 caractères + chiffres.
const NUM_CMD_RE = /^[A-Z]{1,4}\d{4,}$/i
const DATE_RE    = /^(\d{4})-(\d{2})-(\d{2})$/
const STATUTS    = ['Transmise', 'Fermée', 'Fermee', 'Réception Partielle', 'Reception Partielle', 'Annulée', 'Annulee']

function parseInt0(s: string): number {
  const n = parseInt(s.replace(/[^\d-]/g, ''), 10)
  return isNaN(n) ? 0 : n
}

// Regroupe les text items par Y (tolérance ±2), trie chaque ligne par X,
// puis joint les tokens avec un espace simple.
function buildLines(pageItems: any[]): { text: string, items: any[] }[] {
  const rowsByY = new Map<number, any[]>()
  for (const it of pageItems) {
    if (!it || typeof it.str !== 'string') continue
    const y = Math.round(it.y)
    let bucket: number | null = null
    for (const ky of rowsByY.keys()) {
      if (Math.abs(ky - y) <= 2) { bucket = ky; break }
    }
    const key = bucket ?? y
    if (!rowsByY.has(key)) rowsByY.set(key, [])
    rowsByY.get(key)!.push(it)
  }
  const sortedYs = [...rowsByY.keys()].sort((a, b) => b - a) // haut → bas
  const out: { text: string, items: any[] }[] = []
  for (const y of sortedYs) {
    const row = rowsByY.get(y)!.sort((a, b) => a.x - b.x)
    const text = row.map(r => String(r.str).trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    if (text) out.push({ text, items: row })
  }
  return out
}

// Parse une ligne en repérant les ancres :
//   - num_commande (premier token alphanumérique en début OU dans la ligne)
//   - statut (Transmise / Fermée / Réception Partielle…)
//   - date YYYY-MM-DD
//   - #fournisseur (entier 4-6 chiffres)
//   - #piece (entier ou alphanumérique)
//   - qte (entier petit)
// Le reste est texte.
function parseCommandeLine(line: string, items: any[]): ParsedCommande | null {
  // On utilise les items triés par X pour avoir un découpage colonnaire
  // plus robuste qu'un simple split(' ') (utile quand un nom contient
  // des espaces).
  const tokens = items
    .map(i => ({ s: String(i.str).trim(), x: i.x }))
    .filter(t => t.s.length > 0)

  if (tokens.length < 6) return null

  const firstTok = tokens[0].s
  if (!NUM_CMD_RE.test(firstTok)) return null
  const num_commande = firstTok

  // Statut : on cherche le 1er match d'un statut connu dans les tokens 1..6
  let statutIdx = -1
  let statut = ''
  for (let i = 1; i < Math.min(tokens.length, 8); i++) {
    for (const st of STATUTS) {
      // Le statut peut s'étaler sur plusieurs tokens (ex: "Réception Partielle")
      const joined2 = tokens.slice(i, i + 2).map(t => t.s).join(' ')
      const joined1 = tokens[i].s
      if (joined1.toLowerCase() === st.toLowerCase()) { statut = joined1; statutIdx = i; break }
      if (joined2.toLowerCase() === st.toLowerCase()) { statut = joined2; statutIdx = i; break }
    }
    if (statutIdx >= 0) break
  }
  if (statutIdx < 0) return null

  // Date : 1er token après le statut qui matche YYYY-MM-DD
  const afterStatutStart = statutIdx + (statut.includes(' ') ? 2 : 1)
  let dateIdx = -1
  let date_commande: string | null = null
  for (let i = afterStatutStart; i < Math.min(tokens.length, afterStatutStart + 4); i++) {
    if (DATE_RE.test(tokens[i].s)) { date_commande = tokens[i].s; dateIdx = i; break }
  }
  if (dateIdx < 0) return null

  // #Fournisseur : 1er entier 4-6 chiffres après la date
  let fournIdx = -1
  let num_fournisseur: string | null = null
  for (let i = dateIdx + 1; i < Math.min(tokens.length, dateIdx + 4); i++) {
    if (/^\d{4,6}$/.test(tokens[i].s)) { num_fournisseur = tokens[i].s; fournIdx = i; break }
  }
  if (fournIdx < 0) return null

  // À partir d'ici, on a besoin de repérer #Pièce + Qte.
  // Stratégie : on parcourt les tokens depuis la fin pour trouver
  // le premier couple (alphanum_piece, entier_qte) plausible, sachant
  // que le nom employé suit (et peut contenir une virgule).
  //
  // Le layout Traction typique est :
  //   ... #Fourn  Nom Fournisseur (long)  Commandé Par (Nom, Prénom)
  //       #Pièce  Qte  Description (long)  Nom Employé (Nom, Prénom)
  //
  // Mais parfois tout est sur une seule ligne. On utilise donc
  // les coordonnées X pour découper en blocs.
  //
  // On scanne après fournIdx et on cherche un token qui ressemble à
  // un #pièce suivi d'un petit entier (qte).
  let pieceIdx = -1
  let num_piece = ''
  let qte_commandee = 0
  for (let i = fournIdx + 1; i < tokens.length - 1; i++) {
    const a = tokens[i].s
    const b = tokens[i + 1].s
    const aIsPiece = /^[A-Z0-9][A-Z0-9\-_.\/]{1,30}$/i.test(a) && /\d/.test(a)
    const bIsQte = /^\d{1,5}$/.test(b)
    if (aIsPiece && bIsQte) {
      pieceIdx = i
      num_piece = a
      qte_commandee = parseInt0(b)
      break
    }
  }
  if (pieceIdx < 0) return null

  // Bloc fournisseur + commandé par : entre fournIdx+1 et pieceIdx-1
  const blocFourn = tokens.slice(fournIdx + 1, pieceIdx).map(t => t.s).join(' ').trim()
  // Heuristique : "Nom, Prénom" en fin = commandé par
  let nom_fournisseur: string | null = blocFourn || null
  let commande_par:    string | null = null
  const cpMatch = /(.*?)\s+([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'\-]+,\s+[A-Za-zÀ-ÿ'\-]+)\s*$/.exec(blocFourn)
  if (cpMatch) {
    nom_fournisseur = cpMatch[1].trim() || null
    commande_par = cpMatch[2].trim()
  }

  // Bloc description + employé : après qte
  const blocAfter = tokens.slice(pieceIdx + 2).map(t => t.s).join(' ').trim()
  let description: string | null = blocAfter || null
  let nom_employe: string | null = null
  const emMatch = /(.*?)\s+([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'\-]+,\s+[A-Za-zÀ-ÿ'\-]+)\s*$/.exec(blocAfter)
  if (emMatch) {
    description = emMatch[1].trim() || null
    nom_employe = emMatch[2].trim()
  }

  return {
    num_commande,
    statut,
    date_commande,
    num_fournisseur,
    nom_fournisseur,
    commande_par,
    num_piece,
    qte_commandee,
    description,
    nom_employe,
  }
}

export async function parseCommandesPdf(buffer: Buffer | Uint8Array): Promise<CommandesParseResult> {
  try {
    // unpdf veut un Uint8Array dont .buffer est un ArrayBuffer "pur"
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as any)
    const ab = new ArrayBuffer(src.byteLength)
    const data = new Uint8Array(ab)
    data.set(src)
    const r = await extractTextItems(data)

    const commandes: ParsedCommande[] = []
    const rawLines: string[] = []
    const warnings: string[] = []

    for (let p = 0; p < r.items.length; p++) {
      const lines = buildLines(r.items[p] as any[])
      for (const { text, items } of lines) {
        rawLines.push(text)
        // Skip headers / pieds
        if (/^(#?\s*Commande|Statut|Page\s+\d+|Imprim|Total)/i.test(text)) continue
        const cmd = parseCommandeLine(text, items)
        if (cmd) commandes.push(cmd)
        else if (NUM_CMD_RE.test(text.split(/\s+/)[0] || '')) {
          warnings.push(`Ligne non parsée : ${text.slice(0, 140)}`)
        }
      }
    }

    return { success: true, commandes, rawLines, warnings }
  } catch (e: any) {
    return {
      success: false,
      commandes: [],
      rawLines: [],
      warnings: [],
      erreur: e.message || String(e),
    }
  }
}
