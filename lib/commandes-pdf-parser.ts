// Parser des PDF "Liste des Pièces sur la commande" Traction.
//
// Format réel du PDF (vu via diagnostic) :
//   - Rapport multi-pages, UNE commande par page
//   - Header de commande sur une ligne :
//       <#Cmd> <Statut> <Date> [<Date Réception>] <#Fourn> <Nom Fourn...>
//       <Type> <Commandé Par "Nom, Prénom"> <Autorisé Par "Nom, Prénom">
//   - 0..N lignes de pièces :
//       <#Pièce> <#Fourn> <Qte> [colonnes optionnelles] <Description...> <Coût>
//   - Bloc "Commande" ou "Réservation" qui contient le nom de l'employé suiveur
//
// On extrait UNE LIGNE PAR PIÈCE. Les commandes sans pièces sont ignorées
// (rien à suivre).

import { extractTextItems } from 'unpdf'

export interface ParsedCommande {
  num_commande:     string
  statut:           string
  date_commande:    string | null
  num_fournisseur:  string | null
  nom_fournisseur:  string | null
  commande_par:     string | null
  num_piece:        string
  qte_commandee:    number
  description:      string | null
  nom_employe:      string | null
  num_facture:      string | null
}

export interface CommandesParseResult {
  success:    boolean
  commandes:  ParsedCommande[]
  rawLines:   string[]
  warnings:   string[]
  erreur?:    string
}

// Statuts connus (peuvent être combinés avec un slash : "Transmise/Fermée")
const STATUT_RE = /^(Transmise(?:\/Fermée)?|Fermée|Réception Partielle|Annulée|Annulee)$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Types de commande Traction (entre nom_fourn et commandé_par)
const TYPE_RE = /^(Stock|Retour au Fournisseur|Réception|Réception Partielle|Garantie|Spécial|Special|Vente|Achat|Transfert)$/
// Format "Nom, Prénom" (avec accents)
const NOM_PRENOM_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+,\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\- ]+$/

function parseInt0(s: string): number {
  const n = parseInt(s.replace(/[^\d-]/g, ''), 10)
  return isNaN(n) ? 0 : n
}

// Regroupe les text items par Y (tolérance ±2pt), trie par X.
function buildLines(pageItems: any[]): string[] {
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
  const out: string[] = []
  for (const y of sortedYs) {
    const row = rowsByY.get(y)!.sort((a, b) => a.x - b.x)
    const text = row.map(r => String(r.str).trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    if (text) out.push(text)
  }
  return out
}

// Détecte une ligne d'en-tête de commande :
//   "#Commande Statut Date Réception #Fourn Nom Type de Commande Commandé Par Autorisé Par Transport. %Esc."
function isHeaderColumnLine(line: string): boolean {
  return /#Commande\s+Statut/i.test(line) && /Commandé\s+Par/i.test(line)
}

// Détecte la ligne d'en-tête des pièces :
//   "# Pièce #Fourn Comm Réserv Local.1 ..."
function isHeaderPieceLine(line: string): boolean {
  return /#\s*Pièce/i.test(line) && /#Fourn/i.test(line) && /(Comm|Retour)\b/i.test(line)
}

// Détecte la ligne d'en-tête du bloc Commande/Réservation :
//   "Date # Employé Nom Employé Qte Remarque:"
function isHeaderEmployeLine(line: string): boolean {
  return /^Date\b.*#?\s*Employé\b.*Nom\s+Employé/i.test(line)
}

// Parse la ligne header d'une commande.
//   "DS05072026 Transmise/Fermée 2026-05-07 100010 Kimpex Stock Pothier, Anthony Pothier, Anthony"
//   "M1C0036138 Réception Partielle 2024-09-19 2024-09-20 48312 HLC-VÉLO Stock Voghel, Cynthia Voghel, Cynthia"
function parseHeaderCommande(line: string): {
  num_commande: string,
  statut: string,
  date_commande: string | null,
  num_fournisseur: string | null,
  nom_fournisseur: string | null,
  commande_par: string | null,
} | null {
  const tokens = line.split(/\s+/)
  if (tokens.length < 6) return null

  const num_commande = tokens[0]
  if (!num_commande || num_commande.length < 4) return null

  // Statut : 1 ou 2 tokens (ex: "Réception Partielle" = 2 tokens)
  let statut = ''
  let i = 1
  if (STATUT_RE.test(tokens[i])) { statut = tokens[i]; i++ }
  else if (i + 1 < tokens.length && STATUT_RE.test(tokens[i] + ' ' + tokens[i + 1])) {
    statut = tokens[i] + ' ' + tokens[i + 1]; i += 2
  }
  else return null

  // Dates : 1 ou 2 dates YYYY-MM-DD
  let date_commande: string | null = null
  if (i < tokens.length && DATE_RE.test(tokens[i])) { date_commande = tokens[i]; i++ }
  else return null
  // Date réception (optionnelle) — on l'ignore
  if (i < tokens.length && DATE_RE.test(tokens[i])) i++

  // #Fourn : entier 4-6 chiffres
  let num_fournisseur: string | null = null
  if (i < tokens.length && /^\d{4,6}$/.test(tokens[i])) { num_fournisseur = tokens[i]; i++ }
  else return null

  // À partir d'ici : <Nom Fourn (1+ tokens)> <Type (1+ tokens)> <Commandé Par "Nom, Prénom"> <Autorisé Par "Nom, Prénom">
  // On parcourt à l'envers depuis la fin pour repérer les 2 paires "Nom, Prénom".
  // "Nom, Prénom" peut occuper 2 tokens (cas usuel) ou plus si le prénom contient
  // des espaces (ex: "Briand, Thierry Albert"). Stratégie : chercher la 1re virgule
  // depuis la droite, puis le couple "Nom, Prénom" (ou plus).
  const tail = tokens.slice(i)
  if (tail.length < 4) return { num_commande, statut, date_commande, num_fournisseur, nom_fournisseur: null, commande_par: null }

  // Trouver le démarrage du dernier "Nom, ..." en cherchant un token finissant par ","
  // puis remonter jusqu'au type connu.
  // Plus simple : trouver TOUTES les positions où un token finit par "," (= Nom, ...)
  const commaIdxs: number[] = []
  for (let k = 0; k < tail.length; k++) {
    if (/,$/.test(tail[k])) commaIdxs.push(k)
  }
  // On s'attend à 2 virgules : Commandé Par et Autorisé Par.
  // S'il n'y en a qu'une, c'est seulement Commandé Par (peut arriver).
  if (commaIdxs.length === 0) {
    return { num_commande, statut, date_commande, num_fournisseur, nom_fournisseur: tail.join(' ') || null, commande_par: null }
  }

  // Le 1er "Nom, ..." commence à commaIdxs[0] (le mot avec la virgule)
  const premiereVirgIdx = commaIdxs[0]
  const commandeParStart = premiereVirgIdx
  // Le type vient juste avant le 1er "Nom,"
  const typeIdx = commandeParStart - 1
  if (typeIdx < 0) {
    return { num_commande, statut, date_commande, num_fournisseur, nom_fournisseur: null, commande_par: null }
  }

  // Reconstruction : nom_fourn = tail[0..typeIdx-1], type = tail[typeIdx] (peut être 1-3 tokens)
  // On vérifie si tail[typeIdx] est un type connu, sinon on essaie typeIdx-1 + typeIdx.
  let typeStart = typeIdx
  if (!TYPE_RE.test(tail[typeStart])) {
    // Essayer 2 tokens : "Retour au" + "Fournisseur" → 3 tokens
    // ou "Réception" + "Partielle" → 2 tokens
    const t2 = (tail[typeStart - 1] + ' ' + tail[typeStart])
    const t3 = typeStart >= 2 ? (tail[typeStart - 2] + ' ' + tail[typeStart - 1] + ' ' + tail[typeStart]) : ''
    if (TYPE_RE.test(t3)) typeStart -= 2
    else if (TYPE_RE.test(t2)) typeStart -= 1
    // Sinon on ne reconnaît pas le type, mais pas grave — on garde tout
  }

  const nom_fournisseur = tail.slice(0, typeStart).join(' ').trim() || null

  // commande_par = du premier "Nom," jusqu'à la 2e virgule (exclue)
  let commande_par: string | null = null
  if (commaIdxs.length >= 2) {
    // Tokens entre la 1re virgule et la 2e virgule (exclusive)
    commande_par = tail.slice(commandeParStart, commaIdxs[1]).join(' ').trim()
  } else {
    // Tout le reste
    commande_par = tail.slice(commandeParStart).join(' ').trim()
  }
  // Nettoyage : si le pattern "Nom, Prénom" n'est pas reconnu, on le laisse tel quel
  return { num_commande, statut, date_commande, num_fournisseur, nom_fournisseur, commande_par }
}

// Parse une ligne de pièce.
//   "365005 100010 1 PS2AA 23 MBTZ10S BATTERIE QUADFLEX MO 87,49 N N 1"
//   "9931-819 44405 1 1 7 DECK LIGHT,WHT10-30V,LED,680 96,52 N N D 1"
function parsePieceLine(line: string): { num_piece: string, qte_commandee: number, description: string | null } | null {
  const tokens = line.split(/\s+/)
  if (tokens.length < 4) return null

  const num_piece = tokens[0]
  // Le #pièce doit contenir au moins un chiffre OU une lettre majuscule
  if (!/[0-9A-Z]/i.test(num_piece) || num_piece.length < 2) return null

  // tokens[1] = #fourn (entier 4-6 chiffres)
  if (!/^\d{4,6}$/.test(tokens[1])) return null

  // tokens[2] = qte_comm (petit entier)
  if (!/^\d{1,5}$/.test(tokens[2])) return null
  const qte_commandee = parseInt0(tokens[2])

  // Le reste : on cherche le coût (nombre avec virgule décimale) qui sépare
  // la description du bloc final (N N <stock>).
  // Format des nombres Traction : "87,49" ou "87.49"
  const COUT_RE = /^-?\d+[,.]\d{1,4}$/
  let coutIdx = -1
  for (let k = tokens.length - 1; k >= 3; k--) {
    if (COUT_RE.test(tokens[k])) { coutIdx = k; break }
  }
  // La description est entre tokens[3..coutIdx-1] (en filtrant les codes
  // de localisation qui sont en début).
  // Stratégie simple : on prend tous les tokens entre 3 et coutIdx-1.
  // Les premiers tokens (codes de localisation) seront inclus dans la
  // description — pas idéal mais pas grave pour le suivi.
  let description: string | null = null
  if (coutIdx > 3) {
    description = tokens.slice(3, coutIdx).join(' ').trim() || null
  } else if (coutIdx === -1) {
    // Pas de coût détecté — prendre tout après tokens[2]
    description = tokens.slice(3).join(' ').trim() || null
  }
  // Nettoyage : enlever des codes de localisation purement alphanumériques
  // courts en début (mais c'est risqué — on laisse tel quel)

  return { num_piece, qte_commandee, description }
}

// Détection laxe d'une ligne qui ressemble à une pièce mais qui pourrait
// avoir été rejetée par parsePieceLine. Sert juste à signaler dans les
// warnings : "il y a probablement des pièces que je rate sur cette ligne".
// Critère : 1er token >= 3 caractères contenant chiffres ou lettres, suivi
// d'au moins un nombre (num_fourn ou qte) ET d'un coût décimal quelque part.
function looksLikePieceLine(line: string): boolean {
  const tokens = line.split(/\s+/)
  if (tokens.length < 4) return false
  const first = tokens[0]
  if (first.length < 3) return false
  if (!/[A-Z0-9]/i.test(first)) return false
  // Au moins un nombre dans les 3 premiers tokens (num_fourn ou qte)
  const aUnNombre = tokens.slice(1, 4).some(t => /^\d+$/.test(t))
  if (!aUnNombre) return false
  // Et un coût décimal quelque part dans la ligne
  const aUnCout = tokens.some(t => /^-?\d+[,.]\d{1,4}$/.test(t))
  return aUnCout
}

// Parse une ligne du bloc Commande/Réservation et retourne nom_employe
// + num_facture (présent uniquement dans le bloc Réservation).
//
// Format : "<date> <num_employe> <Nom, Prénom> [<#Facture>] [<Type>] <Qte> [<remarque>]"
//
// Exemples :
//   "2026-05-07 945 Pothier, Anthony 1"
//      → { nom: "Pothier, Anthony", facture: null }   (pas de #Facture)
//   "2024-12-04 176 Mouralian, Imad 116909 Facture Service 1 #21913 Banville, Carol"
//      → { nom: "Mouralian, Imad", facture: "116909" }
//   "2025-04-09 20714 Briand, Thierry Albert 1"
//      → { nom: "Briand, Thierry Albert", facture: null }
function parseEmployeLine(line: string): { nom: string, facture: string | null } | null {
  // 1) Le préfixe : date + numéro d'employé
  const prefMatch = /^\s*\d{4}-\d{2}-\d{2}\s+\d{1,6}\s+(.+)$/.exec(line)
  if (!prefMatch) return null
  const rest = prefMatch[1]

  // 2) Le 1er "Nom, Prénom [Prénom2 [Prénom3]]"
  const nameMatch = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+,\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+){0,2})(.*)$/.exec(rest)
  if (!nameMatch) return null

  const nom = nameMatch[1].replace(/\s+/g, ' ').trim()
  const apresNom = nameMatch[2]

  // 3) Après le nom, le 1er token de 4-7 chiffres = #Facture (optionnel).
  //    Si le 1er token est un petit entier (1-3 chiffres), c'est la Qte → pas de facture.
  const factMatch = /^\s+(\d{4,7})\b/.exec(apresNom)
  const facture = factMatch ? factMatch[1] : null

  return { nom, facture }
}

// Recherche permissive d'un nom d'employé dans une ligne — utilisée en
// fallback si le format strict ne matche pas. Retourne aussi un éventuel
// numéro de facture trouvé sur la même ligne.
function chercherNomEmploye(line: string): { nom: string, facture: string | null } | null {
  const m = /(?:^|\s)([A-ZÀ-Ÿ][a-zà-ÿA-ZÀ-Ÿ'\-]+,\s+[A-ZÀ-Ÿ][a-zà-ÿA-ZÀ-Ÿ'\-]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿA-ZÀ-Ÿ'\-]+){0,2})(.*)$/.exec(line)
  if (!m) return null
  const nom = m[1].replace(/\s+/g, ' ').trim()
  const factMatch = /^\s+(\d{4,7})\b/.exec(m[2])
  return { nom, facture: factMatch ? factMatch[1] : null }
}

export async function parseCommandesPdf(buffer: Buffer | Uint8Array): Promise<CommandesParseResult> {
  try {
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
      for (const l of lines) rawLines.push(l)

      // Trouver l'index de l'en-tête colonne de commande
      const idxHeaderCmd = lines.findIndex(isHeaderColumnLine)
      if (idxHeaderCmd < 0) continue

      // La ligne juste après contient les valeurs de la commande
      const ligneCmd = lines[idxHeaderCmd + 1]
      if (!ligneCmd) continue
      const header = parseHeaderCommande(ligneCmd)
      if (!header) {
        warnings.push(`Page ${p + 1}: header commande non parsable : ${ligneCmd.slice(0, 120)}`)
        continue
      }

      // Trouver l'index de l'en-tête colonne des pièces
      const idxHeaderPiece = lines.findIndex(isHeaderPieceLine)
      if (idxHeaderPiece < 0) continue  // commande sans pièces

      // Trouver la fin de la zone "pièces" : UNIQUEMENT "Coût Total de la
      // Commande". On NE PEUT PAS s'arrêter à "Commande"/"Réservation" ni au
      // header employé, parce qu'avec plusieurs pièces sur la même page, chaque
      // pièce est suivie de son propre bloc Réservation/Commande, puis vient
      // la pièce suivante. Le seul vrai marqueur de fin = "Coût Total".
      let idxFinPieces = lines.length
      for (let k = idxHeaderPiece + 1; k < lines.length; k++) {
        if (/^Coût\s+Total\s+de\s+la\s+Commande/i.test(lines[k])) { idxFinPieces = k; break }
      }

      // Parser les lignes de pièces + collecter celles rejetées (pour diagnostic).
      // On garde l'index de chaque pièce dans `piecesAvecIdx` pour pouvoir
      // associer ensuite chaque pièce à SON employé/facture (celui du bloc
      // Réservation/Commande qui la suit, avant la pièce suivante).
      const piecesAvecIdx: { idx: number, piece: { num_piece: string, qte_commandee: number, description: string | null } }[] = []
      const lignesRejetees: string[] = []
      for (let k = idxHeaderPiece + 1; k < idxFinPieces; k++) {
        const l = lines[k]
        const piece = parsePieceLine(l)
        if (piece) piecesAvecIdx.push({ idx: k, piece })
        else if (looksLikePieceLine(l)) lignesRejetees.push(l)
      }
      const pieces = piecesAvecIdx.map(x => x.piece)

      // Extraire "Nombre d'Items de la Commande: X" pour comparer au #pièces parsées
      let nbItemsAttendu: number | null = null
      for (let k = idxFinPieces; k < lines.length; k++) {
        const m = /^Nombre\s+d'Items\s+de\s+la\s+Commande\s*:\s*(\d+)/i.exec(lines[k])
        if (m) { nbItemsAttendu = parseInt(m[1], 10); break }
      }
      if (nbItemsAttendu != null && nbItemsAttendu !== pieces.length) {
        const lignesPiecesZone = lines.slice(idxHeaderPiece + 1, idxFinPieces).filter(l => l.trim())
        const detail = lignesRejetees.length > 0
          ? ` | ${lignesRejetees.length} ligne(s) rejetée(s) : ${lignesRejetees.map(l => l.slice(0, 80)).join(' || ')}`
          : lignesPiecesZone.length === 0
            ? ' | aucune ligne de pièce dans le PDF (probablement Traction qui ne les affiche pas)'
            : ` | ${lignesPiecesZone.length} ligne(s) dans la zone pièces non reconnue(s)`
        warnings.push(`${header.num_commande} (p.${p + 1}): ${nbItemsAttendu} attendu(s), ${pieces.length} parsé(s)${detail}`)
      }

      // Pour chaque pièce, on cherche son employé/facture dans le bloc qui la
      // suit IMMÉDIATEMENT (avant la prochaine pièce ou avant "Coût Total").
      // Cas multi-pièces : chaque pièce a son propre bloc Réservation/Commande.
      // Cas mono-pièce : la pièce hérite du bloc du bas de page.
      //
      // Stratégie de fallback global si aucun match par pièce :
      //   - 1er employé trouvé n'importe où sur la page (pour les pages sans
      //     bloc explicite après la pièce).
      let nomEmployeGlobal: string | null = null
      let numFactureGlobal: string | null = null
      for (let k = idxHeaderCmd + 2; k < lines.length; k++) {
        const r = parseEmployeLine(lines[k])
        if (r) { nomEmployeGlobal = r.nom; numFactureGlobal = r.facture; break }
      }
      if (!nomEmployeGlobal && idxHeaderPiece >= 0) {
        for (let k = idxHeaderPiece + 1; k < lines.length; k++) {
          if (parsePieceLine(lines[k])) continue
          if (/^Coût\s+Total|^Déduction|^Montant|^Core|^Coût\s+Net|^Nombre/i.test(lines[k])) continue
          const r = chercherNomEmploye(lines[k])
          if (r) { nomEmployeGlobal = r.nom; numFactureGlobal = r.facture; break }
        }
      }

      function trouverEmployePourPiece(idxPiece: number, idxPieceSuivante: number): { nom: string | null, facture: string | null } {
        for (let k = idxPiece + 1; k < idxPieceSuivante; k++) {
          const r = parseEmployeLine(lines[k])
          if (r) return { nom: r.nom, facture: r.facture }
        }
        // Fallback permissif
        for (let k = idxPiece + 1; k < idxPieceSuivante; k++) {
          if (/^Coût\s+Total|^Déduction|^Montant|^Core|^Coût\s+Net|^Nombre|^Commande$|^Réservation$/i.test(lines[k])) continue
          if (isHeaderEmployeLine(lines[k])) continue
          const r = chercherNomEmploye(lines[k])
          if (r) return { nom: r.nom, facture: r.facture }
        }
        return { nom: null, facture: null }
      }

      // Émettre une entrée par pièce avec son employé/facture spécifique
      for (let i = 0; i < piecesAvecIdx.length; i++) {
        const { idx, piece } = piecesAvecIdx[i]
        const idxSuiv = i + 1 < piecesAvecIdx.length ? piecesAvecIdx[i + 1].idx : idxFinPieces
        let { nom, facture } = trouverEmployePourPiece(idx, idxSuiv)
        if (!nom) { nom = nomEmployeGlobal; facture = numFactureGlobal }
        commandes.push({
          num_commande:    header.num_commande,
          statut:          header.statut,
          date_commande:   header.date_commande,
          num_fournisseur: header.num_fournisseur,
          nom_fournisseur: header.nom_fournisseur,
          commande_par:    header.commande_par,
          num_piece:       piece.num_piece,
          qte_commandee:   piece.qte_commandee,
          description:     piece.description,
          nom_employe:     nom,
          num_facture:     facture,
        })
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
