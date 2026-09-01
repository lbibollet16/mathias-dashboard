// Parseur du rapport Traction 2891 « Analyse de vente de pièces ».
//
// Structure du fichier (une feuille, en-tête sur la 1re ligne) :
//   A  Code
//   B  Description
//   C..H  BLOC 1 : Qte | Revenus | Couts | Total $ | % | Unitaire   ← MOIS EN COURS
//   I..N  BLOC 2 : mêmes colonnes                                   ← comparatif, non utilisé
//   O..P  colonnes de synthèse du rapport
//
// Deux pièges vérifiés sur un vrai fichier :
//
//  1. UN MÊME CODE APPARAÎT PLUSIEURS FOIS. Sur le fichier de référence,
//     94 codes sur 1 602 sont sur 2 lignes ou plus (prix ou client différents,
//     retours en négatif). Ce ne sont PAS des doublons : chaque ligne est une
//     vente réelle. On les ADDITIONNE. L'ancien import les insérait telles
//     quelles, ce qui a laissé 2 275 groupes (code, mois) en double dans
//     historique_ventes.
//
//  2. Les dernières lignes sont « Total general : » et « 1 / 1 » (pied de page
//     du rapport), à écarter — sinon elles créent une pièce fantôme qui pèse à
//     elle seule tout le chiffre d'affaires du mois.
//
// Identité de contrôle : Revenus − Total $ = Couts. Elle est vérifiée ligne à
// ligne ; si elle casse, c'est que le format du rapport a changé.

import * as XLSX from 'xlsx'

export interface LigneVente2891 {
  code: string
  description: string
  quantite: number
  revenus: number
  couts: number
  profit: number
}

export interface Resultat2891 {
  lignes: LigneVente2891[]
  avertissements: string[]
  totaux: { nb_lignes: number; nb_codes: number; quantite: number; revenus: number; couts: number; profit: number }
  /** Totaux du bloc comparatif, affichés à titre indicatif seulement. */
  totaux_bloc2: { quantite: number; revenus: number; profit: number }
  /** Total lu sur la ligne « Total general » du rapport, pour recoupement. */
  total_rapport: { quantite: number; revenus: number; profit: number } | null
}

const toNum = (v: any): number => {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).replace(/[\s$ %]/g, '').replace(',', '.')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

export function parserVente2891(buffer: ArrayBuffer | Buffer): Resultat2891 {
  const wb = XLSX.read(buffer, { type: buffer instanceof Buffer ? 'buffer' : 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) throw new Error('Fichier vide : aucune feuille trouvée')

  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
  if (rows.length < 2) throw new Error('Fichier vide : aucune ligne de données')

  const avertissements: string[] = []

  // ── Repérage de l'en-tête ──────────────────────────────────────────
  // On ne suppose pas que les colonnes sont à une position fixe : on cherche
  // la ligne qui contient « Code » puis on localise le PREMIER bloc
  // Qte/Revenus/Couts/Total $ après elle.
  let iEntete = -1
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i] || []
    if (r.some(c => String(c ?? '').trim().toLowerCase() === 'code')) { iEntete = i; break }
  }
  if (iEntete < 0) throw new Error('En-tête introuvable : aucune colonne « Code ». Ce fichier n\'est pas un rapport 2891.')

  const hdr = (rows[iEntete] || []).map(c => String(c ?? '').trim().toLowerCase())
  const trouver = (nom: string, depuis = 0) => hdr.findIndex((h, i) => i >= depuis && h === nom)

  const iCode = trouver('code')
  const iDesc = trouver('description')
  const iQte = trouver('qte', iCode + 1)
  const iRev = trouver('revenus', iCode + 1)
  const iCout = trouver('couts', iCode + 1)
  const iTot = trouver('total $', iCode + 1)

  if (iQte < 0 || iRev < 0 || iTot < 0) {
    throw new Error(
      `Colonnes du bloc 1 introuvables (Qte=${iQte}, Revenus=${iRev}, Total $=${iTot}). ` +
      `En-tête lu : ${hdr.filter(Boolean).join(' | ')}`)
  }

  // Bloc 2 = deuxième occurrence des mêmes en-têtes. Lu pour information
  // uniquement : c'est le comparatif, il ne doit pas entrer dans l'historique.
  const iQte2 = trouver('qte', iQte + 1)
  const iRev2 = trouver('revenus', iRev + 1)
  const iTot2 = trouver('total $', iTot + 1)

  // ── Lecture des lignes ─────────────────────────────────────────────
  const parCode = new Map<string, LigneVente2891>()
  let nbLignesLues = 0
  let nbIncoherences = 0
  let totalRapport: Resultat2891['total_rapport'] = null
  const t2 = { quantite: 0, revenus: 0, profit: 0 }

  for (let i = iEntete + 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.length === 0) continue
    const brut = r[iCode]
    if (brut === null || brut === undefined || brut === '') continue

    const code = String(brut).trim()
    if (!code) continue

    const bas = code.toLowerCase()
    // Pied de page « Total general : ». Colonnes décalées d'un cran par rapport
    // aux lignes de données (pas de Description) : Qte en B, Revenus en C,
    // Couts en D, Total $ en E. On exige « general » ou un « : » final pour ne
    // pas confondre avec un vrai code de pièce qui commencerait par TOTAL.
    if (/^total\b/.test(bas) && (bas.includes('general') || bas.includes('général') || bas.trim().endsWith(':'))) {
      totalRapport = { quantite: toNum(r[1]), revenus: toNum(r[2]), profit: toNum(r[4]) }
      continue
    }
    if (/^\d+\s*\/\s*\d+$/.test(code)) continue   // « 1 / 1 »

    const quantite = toNum(r[iQte])
    const revenus = toNum(r[iRev])
    const couts = iCout >= 0 ? toNum(r[iCout]) : 0
    const profit = toNum(r[iTot])

    if (iQte2 >= 0) t2.quantite += toNum(r[iQte2])
    if (iRev2 >= 0) t2.revenus += toNum(r[iRev2])
    if (iTot2 >= 0) t2.profit += toNum(r[iTot2])

    // Ligne totalement vide sur le bloc 1 : la pièce figure au rapport mais
    // n'a rien vendu ce mois-ci. On la garde à 0 : c'est une information
    // (le mois EST couvert pour cette pièce), pas un trou de données.
    nbLignesLues++

    // Contrôle d'intégrité du mapping de colonnes.
    if (iCout >= 0 && Math.abs((revenus - profit) - couts) > 0.05) {
      nbIncoherences++
      if (nbIncoherences <= 5) {
        avertissements.push(
          `Ligne ${i + 1} (${code}) : Revenus − Total $ = ${(revenus - profit).toFixed(2)} ` +
          `mais la colonne Couts vaut ${couts.toFixed(2)}.`)
      }
    }

    const dejaVu = parCode.get(code)
    if (dejaVu) {
      dejaVu.quantite += quantite
      dejaVu.revenus += revenus
      dejaVu.couts += couts
      dejaVu.profit += profit
    } else {
      parCode.set(code, {
        code,
        description: iDesc >= 0 ? String(r[iDesc] ?? '').trim() : '',
        quantite, revenus, couts, profit,
      })
    }
  }

  if (nbIncoherences > 5) {
    avertissements.push(`… et ${nbIncoherences - 5} autres lignes incohérentes. Le format du rapport a peut-être changé.`)
  }
  if (parCode.size === 0) {
    throw new Error('Aucune ligne de vente exploitable dans le fichier.')
  }

  const lignes = [...parCode.values()]
  const nbFusionnes = nbLignesLues - lignes.length
  if (nbFusionnes > 0) {
    avertissements.push(
      `${nbFusionnes} lignes portaient un code déjà présent dans le fichier — additionnées ` +
      `(le rapport 2891 sort plusieurs lignes par code quand le prix ou le client diffère).`)
  }

  const totaux = {
    nb_lignes: nbLignesLues,
    nb_codes: lignes.length,
    quantite: lignes.reduce((s, l) => s + l.quantite, 0),
    revenus: lignes.reduce((s, l) => s + l.revenus, 0),
    couts: lignes.reduce((s, l) => s + l.couts, 0),
    profit: lignes.reduce((s, l) => s + l.profit, 0),
  }

  // Recoupement avec le pied de page du rapport : détecte une lecture partielle.
  if (totalRapport && totalRapport.revenus > 0) {
    const ecart = Math.abs(totaux.revenus - totalRapport.revenus)
    if (ecart > Math.max(1, totalRapport.revenus * 0.001)) {
      avertissements.push(
        `Écart avec le total du rapport : ${totaux.revenus.toFixed(2)} $ lus contre ` +
        `${totalRapport.revenus.toFixed(2)} $ annoncés (${ecart.toFixed(2)} $ d'écart).`)
    }
  }

  return { lignes, avertissements, totaux, totaux_bloc2: t2, total_rapport: totalRapport }
}
