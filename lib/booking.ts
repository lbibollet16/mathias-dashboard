/**
 * Le moteur de booking.
 *
 * Un booking est un arbitrage, pas une liste de courses. Le fournisseur offre
 * un escompte et des termes de paiement ; en echange on immobilise de l'argent
 * et de la place des mois avant que la marchandise se vende. Le pari est bon
 * quand l'escompte plus la valeur du dating depassent le cout de porter ce
 * stock jusqu'a sa vente.
 *
 * Ce fichier ne connait aucun fournisseur en particulier. Il lit la grille
 * saisie dans sc_booking_programmes / _paliers / _bonus et applique la meme
 * mecanique a tous — c'est ce qui permet a KTM (4 paliers en dollars), Parts
 * Canada (22 baremes par categorie) et Mercury (un palier en unites) de passer
 * par le meme code.
 *
 * LE POINT DELICAT : la distinction entre les unites de BESOIN et les unites
 * d'ETIREMENT. Les premieres, on les aurait achetees de toute facon ; les
 * booker n'avance que leur date. Les secondes n'existent que pour franchir un
 * seuil, et ce sont elles, et elles seules, dont le portage doit etre mis en
 * face de l'escompte. Confondre les deux fait dire au modele qu'aucun booking
 * n'est rentable — ou que tous le sont.
 */

import { IndiceSaison, SAISON_NEUTRE } from '@/lib/supply-chain-saison'

const JOURS_PAR_MOIS = 30.44

/**
 * Les statuts qu'on ne booke jamais, quel que soit le programme.
 *
 * `sur_commande` merite l'explication : c'est une piece vendue une seule fois
 * et sans min/max dans Traction — autrement dit une commande speciale passee
 * pour un client precis. Son stock a zero n'est pas une rupture, et sa
 * « demande mensuelle » de 0,17 unite n'annonce rien. Sans ce filtre, les
 * douze plus grosses lignes proposees chez Parts Canada etaient douze pieces
 * a plus de 1 000 $ vendues une fois dans l'annee.
 */
const STATUTS_HORS_BOOKING = new Set(['mort', 'jamais_vendue', 'dormant', 'sur_commande'])

// ═══════════════════════════════════════════════════════════════════════
// Les formes
// ═══════════════════════════════════════════════════════════════════════

export type AxeBareme = 'tout' | 'categorie' | 'marque' | 'ligne' | 'codes'

export interface ProgrammeBooking {
  id: number
  nom: string
  fournisseur: string
  fournisseurs_alt: string[]
  saison: string | null
  ouvre_le: string | null
  ferme_le: string | null
  livraison_debut: string | null
  livraison_fin: string | null
  couvre_debut: string | null
  couvre_fin: string | null
  perimetre_lignes: string[]
  perimetre_marques: string[]
  perimetre_categories: string[]
  perimetre_codes: string[]
  exclus_codes: string[]
  min_commande: number | null
  min_reappro: number | null
  franco_seuil: number | null
  transport_pct: number | null
  retour_pct: number | null
  baremes_exclusifs: boolean
  notes: string | null
  source_fichier: string | null
  actif: boolean
}

export interface PalierBooking {
  id: number
  programme_id: number
  bareme: string
  axe: AxeBareme
  cible: string[]
  rang: number
  niveau: string | null
  seuil_montant: number
  seuil_qte: number | null
  seuil_sur: 'groupe' | 'commande'
  escompte_pct: number
  sous_minimums: SousMinimum[]
  echeancier: Echeance[]
  franco_port: boolean
  notes: string | null
}

export interface SousMinimum {
  axe: AxeBareme
  cible: string[]
  montant: number
  libelle?: string
}

/** Une part de la facture payable au bout de `jours`. Les parts somment a 1. */
export interface Echeance { part: number; jours: number }

export interface BonusBooking {
  id: number
  programme_id: number
  type: 'hatif' | 'paiement_rapide' | 'sous_ensemble' | 'commandes_bonus' | 'transport'
  groupe: string
  libelle: string
  valeur_pct: number
  avant_le: string | null
  jours: number | null
  axe: AxeBareme
  cible: string[]
  notes: string | null
}

/** Ce que le moteur a besoin de savoir d'une piece. Sous-ensemble de sc_analyse_pieces. */
export interface PieceBooking {
  code_piece: string
  description: string | null
  fournisseur: string
  code_ligne: string
  marque: string | null
  categorie_nom: string | null
  categorie_chemin: string | null
  cout_unitaire: number
  prix_vente: number
  stock_dispo: number
  qte_transit: number
  qte_commande: number
  stock_securite: number
  demande_mens: number
  demande_deseason: number
  /** Cout des ventes sur 12 mois : sert a dire quelle part du fournisseur le booking couvre. */
  ventes_12m_cogs: number
  indice_12m: number[] | null
  rotation: number
  classe_abc: string
  statut: string
  discontinue: boolean
  popularite: number | null
}

export interface ConfigBooking {
  taux_possession: number
  cout_capital_annuel: number
  termes_standard_jours: number
}

export type ObjectifBooking = 'optimal' | 'budget' | 'couverture' | 'palier'

export interface DemandeBooking {
  programme: ProgrammeBooking
  paliers: PalierBooking[]
  bonus: BonusBooking[]
  pieces: PieceBooking[]
  config: ConfigBooking
  dateCommande: Date
  objectif: ObjectifBooking
  /** Plafond de depense, quand objectif = 'budget'. */
  budgetMax?: number | null
  /** Duree a couvrir en mois, quand le programme ne dit pas quelle periode il vise. */
  couvertureMois?: number
  /** Niveau vise, quand objectif = 'palier'. */
  palierVise?: string | null
  /** Ne proposer que des pieces deja vendues au moins une fois. */
  exclureJamaisVendues?: boolean

  /**
   * Les references interchangeables, depuis `pieces_alternatives` :
   * code principal -> codes qui peuvent le remplacer.
   */
  alternatives?: Map<string, string[]>
  /**
   * Stock disponible de CHAQUE code du catalogue, alternatives comprises —
   * y compris celles d'un autre fournisseur ou hors du perimetre du
   * programme. Une piece sur la tablette compte, peu importe qui l'a vendue.
   */
  stockParCode?: Map<string, number>
}

export interface LigneBooking {
  code_piece: string
  description: string | null
  fournisseur: string
  code_ligne: string
  marque: string | null
  categorie_nom: string | null
  cout_unitaire: number
  qte: number
  montant: number
  bareme: string
  motif: 'besoin' | 'rupture' | 'palier' | 'minimum'
  qte_besoin: number
  qte_etirement: number
  stock: number
  en_route: number
  demande_periode: number
  couverture_apres: number | null
  classe_abc: string
  statut_piece: string
  rotation: number
  portage_dollars: number
  /** Unites du besoin deja couvertes par une reference interchangeable en stock. */
  alt_couverture: number
  /** Les references qui ont fourni cette couverture. */
  alt_codes: string[]
}

export interface EtatBareme {
  bareme: string
  axe: AxeBareme
  cible: string[]
  montant: number
  qte: number
  nb_pieces: number
  palier_atteint: string | null
  escompte_pct: number
  /** Le palier suivant, et ce qu'il faudrait ajouter pour l'atteindre. */
  prochain_niveau: string | null
  prochain_seuil: number | null
  manque: number | null
  /** Gain net d'un etirement jusqu'au palier suivant. Negatif = ne pas le faire. */
  gain_etirement: number | null
  /** Pourquoi on n'y est pas alle, quand on n'y est pas alle. */
  verdict: string | null
}

export interface ResultatBooking {
  lignes: LigneBooking[]
  baremes: EtatBareme[]
  montant_brut: number
  escompte_pct: number
  escompte_dollars: number
  montant_net: number
  dating_jours: number
  dating_dollars: number
  dating_choisi: 'dating' | 'paiement_rapide' | 'aucun'
  portage_dollars: number
  transport_dollars: number
  gain_net_dollars: number
  nb_lignes: number
  /** Fenetre reellement couverte. */
  couvre_debut: string
  couvre_fin: string
  livraison: string
  /** Tout ce qui doit etre dit a l'ecran plutot que cache dans un chiffre. */
  avertissements: string[]
  detail_bonus: { libelle: string; valeur_pct: number; retenu: boolean; pourquoi?: string }[]
}

// ═══════════════════════════════════════════════════════════════════════
// Comparer des libelles ecrits par des humains
// ═══════════════════════════════════════════════════════════════════════

/**
 * « Pneus » doit attraper « Pneus de Motocyclette », « PLAQUETTES DE FREIN -
 * METAL FRITTE » doit repondre a « FREIN ». Les catalogues fournisseurs
 * melangent majuscules, accents et pluriels : on compare a plat.
 */
export function normaliser(s: string | null | undefined): string {
  if (!s) return ''
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function valeurSurAxe(p: PieceBooking, axe: AxeBareme): string {
  switch (axe) {
    case 'marque':    return p.marque || ''
    case 'categorie': return `${p.categorie_nom || ''} ${p.categorie_chemin || ''}`
    case 'ligne':     return p.code_ligne || ''
    case 'codes':     return p.code_piece || ''
    default:          return ''
  }
}

/** La piece tombe-t-elle dans ce (axe, cible) ? Un axe « tout » attrape tout. */
export function correspond(p: PieceBooking, axe: AxeBareme, cible: string[]): boolean {
  if (axe === 'tout') return true
  if (!cible || cible.length === 0) return false
  const v = normaliser(valeurSurAxe(p, axe))
  if (!v) return false
  // 'codes' se compare a l'identique : un code de piece n'est pas un libelle.
  if (axe === 'codes') return cible.some(c => normaliser(c) === v)
  return cible.some(c => { const n = normaliser(c); return n.length > 0 && v.includes(n) })
}

// ═══════════════════════════════════════════════════════════════════════
// La demande sur une fenetre quelconque
// ═══════════════════════════════════════════════════════════════════════

function moisEntre(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (JOURS_PAR_MOIS * 86400000)
}

function ajouterMois(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  r.setMonth(r.getMonth() + n)
  return r
}

/**
 * Demande attendue entre deux dates, au rythme saisonnier de la piece.
 *
 * On ne divise pas une moyenne annuelle par douze : sur une fenetre qui va
 * de novembre a mai, la moyenne plate se trompe d'un facteur quatre. On somme
 * les indices des mois reellement traverses, en tenant compte des fractions
 * de mois aux deux bouts.
 */
export function demandeSurFenetre(
  deseason: number, indice: IndiceSaison, debut: Date, fin: Date,
): number {
  if (deseason <= 0) return 0
  const duree = moisEntre(debut, fin)
  if (duree <= 0) return 0

  let total = 0
  let restant = duree
  let m = debut.getMonth()
  // Ce qu'il reste du mois de depart.
  const joursDansMois = new Date(debut.getFullYear(), m + 1, 0).getDate()
  const fraction = (debut.getDate() - 1) / joursDansMois

  let part = Math.min(1 - fraction, restant)
  total += indice[m % 12] * part
  restant -= part
  m = (m + 1) % 12

  let garde = 0
  while (restant > 0 && garde++ < 240) {
    part = Math.min(1, restant)
    total += indice[m % 12] * part
    restant -= part
    m = (m + 1) % 12
  }
  return deseason * total
}

function indiceDe(p: PieceBooking): IndiceSaison {
  const i = p.indice_12m
  if (Array.isArray(i) && i.length === 12 && i.every(v => typeof v === 'number' && isFinite(v))) {
    return i as IndiceSaison
  }
  return SAISON_NEUTRE
}

/** La demande desaisonnalisee, avec repli sur la moyenne plate si absente. */
function deseasonDe(p: PieceBooking): number {
  if (p.demande_deseason > 0) return p.demande_deseason
  return p.demande_mens > 0 ? p.demande_mens : 0
}

// ═══════════════════════════════════════════════════════════════════════
// Le calcul
// ═══════════════════════════════════════════════════════════════════════

/** Le portage annuel d'un dollar de stock, ramene a une duree en mois. */
function portage(montant: number, mois: number, taux: number): number {
  return montant * taux * (Math.max(0, mois) / 12)
}

export function calculerBooking(d: DemandeBooking): ResultatBooking {
  const { programme: prog, config: cfg } = d
  const avertissements: string[] = []

  // ── La fenetre ────────────────────────────────────────────────────
  const livraison = prog.livraison_debut
    ? new Date(prog.livraison_debut + 'T12:00:00')
    : ajouterMois(d.dateCommande, 1.5)

  const couvreDebut = prog.couvre_debut
    ? new Date(prog.couvre_debut + 'T12:00:00')
    : livraison
  const couvreFin = prog.couvre_fin
    ? new Date(prog.couvre_fin + 'T12:00:00')
    : ajouterMois(couvreDebut, d.couvertureMois ?? 6)

  const nbMoisFenetre = Math.max(0.5, moisEntre(couvreDebut, couvreFin))
  // Le temps mort : la marchandise arrive avant que la periode couverte
  // commence. Chez Polaris remisage, on recoit en juin pour une demande qui
  // demarre en septembre — trois mois de portage que personne ne compte.
  const moisAttente = Math.max(0, moisEntre(livraison, couvreDebut))

  if (prog.ferme_le) {
    const ferme = new Date(prog.ferme_le + 'T12:00:00')
    if (ferme < d.dateCommande) {
      avertissements.push(
        `Le programme est ferme depuis le ${prog.ferme_le}. Les chiffres restent valables comme simulation, ` +
        `mais les dates du bulletin sont a rafraichir avant de commander.`)
    }
  }
  if (moisAttente > 1) {
    avertissements.push(
      `La marchandise arrive ${moisAttente.toFixed(1)} mois avant le debut de la periode couverte : ` +
      `ce delai est compte dans le portage.`)
  }

  // ── Les pieces eligibles ──────────────────────────────────────────
  const fournisseurs = new Set([prog.fournisseur, ...(prog.fournisseurs_alt || [])].map(normaliser))
  const exclus = new Set((prog.exclus_codes || []).map(normaliser))

  let nbHorsPerimetre = 0
  const eligibles = d.pieces.filter(p => {
    if (!fournisseurs.has(normaliser(p.fournisseur))) return false
    if (exclus.has(normaliser(p.code_piece))) return false
    // Une piece que le fournisseur declare discontinuee ne se rebooke jamais.
    if (p.discontinue) return false
    if (p.cout_unitaire <= 0) return false

    const filtres: [string[], AxeBareme][] = [
      [prog.perimetre_lignes, 'ligne'],
      [prog.perimetre_marques, 'marque'],
      [prog.perimetre_categories, 'categorie'],
      [prog.perimetre_codes, 'codes'],
    ]
    for (const [cible, axe] of filtres) {
      if (cible && cible.length > 0 && !correspond(p, axe, cible)) { nbHorsPerimetre++; return false }
    }
    return true
  })

  if (eligibles.length === 0) {
    avertissements.push(
      `Aucune piece ne correspond au perimetre du programme. Verifie que le nom du fournisseur ` +
      `« ${prog.fournisseur} » est bien celui du feed Traction.`)
  }

  // Est-ce que l'enrichissement permet vraiment de calculer des baremes par
  // categorie ? Chez Mercury et Volvo Penta la reponse est non, et il vaut
  // mieux le dire que de sortir un chiffre construit sur du vide.
  const baremesParAxe = new Set(d.paliers.filter(p => p.axe !== 'tout').map(p => p.axe))
  if (baremesParAxe.has('categorie')) {
    const avecCat = eligibles.filter(p => p.categorie_nom || p.categorie_chemin).length
    const part = eligibles.length ? avecCat / eligibles.length : 0
    if (part < 0.5) {
      avertissements.push(
        `Seulement ${Math.round(part * 100)} % des pieces de ce fournisseur ont une categorie ` +
        `(${avecCat} sur ${eligibles.length}). Les baremes par categorie ne portent donc que sur une ` +
        `fraction de la commande — le reste tombe dans le bareme residuel.`)
    }
  }
  if (baremesParAxe.has('marque')) {
    const avecMarque = eligibles.filter(p => p.marque).length
    const part = eligibles.length ? avecMarque / eligibles.length : 0
    if (part < 0.5) {
      avertissements.push(
        `Seulement ${Math.round(part * 100)} % des pieces ont une marque renseignee : ` +
        `les baremes par marque sont sous-estimes.`)
    }
  }

  // ── Le besoin, piece par piece ────────────────────────────────────
  interface Candidat {
    p: PieceBooking
    besoin: number          // unites justifiees par la periode
    demandePeriode: number
    stockAuDebut: number
    deseason: number
    bareme: string          // affecte plus bas
    motif: LigneBooking['motif']
    altCouverture: number   // unites deja couvertes par une reference equivalente
    altCodes: string[]
  }

  const candidats: Candidat[] = []
  let nbEcartesStatut = 0
  let nbEcartesTropPetit = 0
  // On compte l'argent ecarte, pas seulement les references : c'est la seule
  // facon de savoir quelle part du fournisseur un booking peut reellement
  // couvrir. Chez Parts Canada les commandes speciales pesent les deux tiers
  // du cout des ventes annuel — le booking ne mord que sur le tiers restant,
  // et il faut le dire plutot que de laisser croire qu'on optimise le tout.
  let cogsEcarteSpecial = 0
  let cogsEcarteDormant = 0
  let cogsTotal = 0

  for (const p of eligibles) {
    // Un booking n'achete que ce qui tourne. Les quatre statuts ecartes ici
    // sont ceux qui, mis dans une commande de reservation, deviennent le stock
    // mort de l'annee suivante :
    //   sur_commande   vendue une fois, sans min/max — c'est une commande
    //                  speciale client, deja livree. La rebooker, c'est acheter
    //                  une piece a 4 000 $ qui ne se revendra jamais.
    //   mort           aucune vente depuis deux ans
    //   jamais_vendue  jamais sortie
    //   dormant        rien sur douze mois
    cogsTotal += Math.max(0, p.ventes_12m_cogs || 0)
    if (STATUTS_HORS_BOOKING.has(p.statut)) {
      nbEcartesStatut++
      if (p.statut === 'sur_commande') cogsEcarteSpecial += Math.max(0, p.ventes_12m_cogs || 0)
      else cogsEcarteDormant += Math.max(0, p.ventes_12m_cogs || 0)
      continue
    }

    const ds = deseasonDe(p)
    if (d.exclureJamaisVendues && ds <= 0) { nbEcartesStatut++; continue }

    const idx = indiceDe(p)
    const demandePeriode = demandeSurFenetre(ds, idx, couvreDebut, couvreFin)
    // Ce qui part avant meme que la periode commence.
    const demandeAvant = demandeSurFenetre(ds, idx, d.dateCommande, couvreDebut)
    const dispo = p.stock_dispo + p.qte_transit + p.qte_commande
    const stockAuDebut = Math.max(0, dispo - demandeAvant)

    // Le stock de securite protege contre l'alea du DELAI en reappro courant ;
    // il n'a pas a etre reconstitue en entier par un achat de pre-saison. Sur
    // les pieces lentes il vaut plusieurs annees de ventes — l'ajouter tel quel
    // ferait a lui seul 135 000 $ chez Parts Canada, soit plus que le coup des
    // ventes annuel du fournisseur. On le plafonne a la moitie de la demande
    // de la periode : un tampon ne depasse pas ce qu'il tamponne.
    const tampon = Math.min(p.stock_securite, demandePeriode * 0.5)

    const besoinBrut = demandePeriode + tampon - stockAuDebut

    // Arrondi au plus proche, et non au superieur. Sur 1 675 references, le
    // « au moins une de chaque » ajoutait 59 000 $ de pieces dont la periode
    // ne demande qu'une fraction d'unite. L'arrondi au plus proche est sans
    // biais : ce qui manque d'un cote se rattrape de l'autre.
    const besoin = Math.max(0, Math.round(besoinBrut))
    if (besoinBrut > 0 && besoin === 0) nbEcartesTropPetit++

    candidats.push({
      p, besoin, demandePeriode, stockAuDebut, deseason: ds, bareme: 'global',
      motif: (p.stock_dispo <= 0 && ds > 0) ? 'rupture' : 'besoin',
      altCouverture: 0, altCodes: [],
    })
  }

  // ── Les references interchangeables ───────────────────────────────
  //
  // Deux codes qui font le meme travail ne se planifient pas separement :
  // booker un joint dont l'equivalent dort sur la tablette, c'est payer deux
  // fois la meme piece.
  //
  // Le piege est le double comptage. Si A et B sont interchangeables et que
  // les deux ont un besoin, crediter le stock de B a A puis le stock de A a B
  // annulerait les deux besoins alors qu'il n'y a qu'un seul stock. On tient
  // donc un compteur d'unites encore disponibles, et chaque unite ne peut
  // servir qu'une fois — les pieces les plus lourdes passent en premier.
  if (d.alternatives && d.alternatives.size > 0) {
    const restant = new Map<string, number>()
    const dispoDe = (code: string) => d.stockParCode?.get(code) ?? 0

    // Les besoins les plus chers d'abord : c'est la ou une alternative
    // deja en stock economise le plus.
    const parPoids = [...candidats]
      .filter(c => c.besoin > 0)
      .sort((a, b) => (b.besoin * b.p.cout_unitaire) - (a.besoin * a.p.cout_unitaire))

    for (const c of parPoids) {
      const equivalents = d.alternatives.get(c.p.code_piece) || []
      if (!equivalents.length) continue

      for (const alt of equivalents) {
        if (c.besoin <= 0) break
        if (normaliser(alt) === normaliser(c.p.code_piece)) continue
        if (!restant.has(alt)) restant.set(alt, Math.max(0, dispoDe(alt)))
        const libre = restant.get(alt) || 0
        if (libre <= 0) continue

        const pris = Math.min(libre, c.besoin)
        restant.set(alt, libre - pris)
        c.besoin -= pris
        c.altCouverture += pris
        c.altCodes.push(alt)
      }
    }

    const nbAllegees = candidats.filter(c => c.altCouverture > 0).length
    if (nbAllegees > 0) {
      const evite = candidats.reduce((s, c) => s + c.altCouverture * c.p.cout_unitaire, 0)
      avertissements.push(
        `${nbAllegees} pieces ont vu leur besoin reduit parce qu'une reference interchangeable ` +
        `est deja en stock : ${Math.round(evite).toLocaleString('fr-CA')} $ qu'il est inutile de ` +
        `commander. Les equivalences viennent de la table des pieces alternatives.`)
    }
  }

  if (nbEcartesStatut > 0) {
    const A = (v: number) => Math.round(v).toLocaleString('fr-CA') + ' $'
    let phrase = `${nbEcartesStatut} pieces ecartees d'office : stock mort, jamais vendues, ` +
                 `dormantes, ou commandes speciales client. Un booking n'achete que ce qui tourne.`
    if (cogsEcarteSpecial > 0 && cogsTotal > 0) {
      const part = Math.round((cogsEcarteSpecial / cogsTotal) * 100)
      phrase += ` Attention a la lecture du montant : les commandes speciales pesent ` +
                `${A(cogsEcarteSpecial)} de cout des ventes sur douze mois, soit ${part} % de ce ` +
                `fournisseur. Elles ne se prebookent pas — mais si ton programme accorde son escompte ` +
                `sur toute commande passee pendant la fenetre, c'est un volume qui compte pour les paliers.`
    }
    avertissements.push(phrase)
  }
  if (nbEcartesTropPetit > 0) {
    avertissements.push(
      `${nbEcartesTropPetit} pieces demandent moins d'une demi-unite sur la periode : elles ne sont ` +
      `pas bookees. Les commander a l'unite reviendrait a acheter plusieurs annees de couverture.`)
  }

  // ── L'affectation aux baremes ─────────────────────────────────────
  // Les baremes definis, du plus specifique au plus general. Quand ils
  // partitionnent (Parts Canada), une piece va dans le premier qui la reclame ;
  // l'ordre marque > categorie > ligne > tout evite qu'un casque Icon soit
  // compte dans « Casques » plutot que dans « Icon ».
  const ordreAxe: Record<AxeBareme, number> = { codes: 0, marque: 1, categorie: 2, ligne: 3, tout: 4 }
  const groupes = new Map<string, { bareme: string; axe: AxeBareme; cible: string[]; paliers: PalierBooking[] }>()
  for (const pal of d.paliers) {
    const g = groupes.get(pal.bareme)
    if (g) { g.paliers.push(pal); continue }
    groupes.set(pal.bareme, { bareme: pal.bareme, axe: pal.axe, cible: pal.cible || [], paliers: [pal] })
  }
  for (const g of groupes.values()) g.paliers.sort((a, b) => a.seuil_montant - b.seuil_montant || a.rang - b.rang)

  const listeBaremes = [...groupes.values()].sort((a, b) => ordreAxe[a.axe] - ordreAxe[b.axe])

  /** Les baremes auxquels la piece contribue. */
  function baremesDe(p: PieceBooking): typeof listeBaremes {
    const touches = listeBaremes.filter(g => correspond(p, g.axe, g.cible))
    if (!prog.baremes_exclusifs) return touches
    return touches.length ? [touches[0]] : []
  }

  for (const c of candidats) {
    const b = baremesDe(c.p)
    c.bareme = b.length ? b[0].bareme : 'global'
  }

  // ── Le panier de base : uniquement ce que la periode exige ────────
  const retenus = new Map<string, LigneBooking>()

  function moisPortageEtirement(c: Candidat, qteSup: number): number {
    // Les unites d'etirement traversent toute la fenetre, puis s'ecoulent.
    // On compte la moitie de leur propre duree d'ecoulement : la premiere part
    // le jour ou la fenetre se termine, la derniere bien plus tard.
    if (c.deseason <= 0) return 36
    const moisEcoulement = qteSup / c.deseason
    return Math.min(60, moisAttente + nbMoisFenetre + moisEcoulement / 2)
  }

  function ajouter(c: Candidat, qte: number, motif: LigneBooking['motif'], etirement: boolean) {
    if (qte <= 0) return
    const p = c.p
    const cle = p.code_piece
    const l = retenus.get(cle) || {
      code_piece: p.code_piece, description: p.description, fournisseur: p.fournisseur,
      code_ligne: p.code_ligne, marque: p.marque, categorie_nom: p.categorie_nom,
      cout_unitaire: p.cout_unitaire, qte: 0, montant: 0, bareme: c.bareme, motif,
      qte_besoin: 0, qte_etirement: 0,
      stock: p.stock_dispo, en_route: p.qte_transit + p.qte_commande,
      demande_periode: Math.round(c.demandePeriode * 100) / 100,
      couverture_apres: null,
      classe_abc: p.classe_abc, statut_piece: p.statut, rotation: p.rotation,
      portage_dollars: 0,
      alt_couverture: c.altCouverture, alt_codes: c.altCodes,
    }
    l.qte += qte
    l.montant = Math.round(l.qte * p.cout_unitaire * 100) / 100
    if (etirement) { l.qte_etirement += qte; l.motif = l.motif === 'besoin' ? 'palier' : l.motif }
    else l.qte_besoin += qte

    // Portage : les unites de besoin ne coutent que l'attente avant la periode,
    // puisqu'on les aurait achetees de toute facon. Les unites d'etirement
    // coutent leur sejour complet.
    l.portage_dollars = Math.round((
      portage(l.qte_besoin * p.cout_unitaire, moisAttente, cfg.taux_possession) +
      portage(l.qte_etirement * p.cout_unitaire, moisPortageEtirement(c, l.qte_etirement), cfg.taux_possession)
    ) * 100) / 100

    const dispoApres = c.stockAuDebut + l.qte
    l.couverture_apres = c.deseason > 0 ? Math.round((dispoApres / c.deseason) * 10) / 10 : null
    retenus.set(cle, l)
  }

  for (const c of candidats) if (c.besoin > 0) ajouter(c, c.besoin, c.motif, false)

  // ── L'etirement, bareme par bareme ────────────────────────────────
  const parCle = new Map(candidats.map(c => [c.p.code_piece, c]))

  function montantBareme(nom: string): number {
    let s = 0
    for (const l of retenus.values()) {
      const c = parCle.get(l.code_piece)
      if (!c) continue
      const b = baremesDe(c.p)
      if (b.some(g => g.bareme === nom)) s += l.montant
    }
    return s
  }
  function montantTotal(): number {
    let s = 0; for (const l of retenus.values()) s += l.montant; return s
  }
  function qteBareme(nom: string): number {
    let s = 0
    for (const l of retenus.values()) {
      const c = parCle.get(l.code_piece)
      if (!c) continue
      if (baremesDe(c.p).some(g => g.bareme === nom)) s += l.qte
    }
    return s
  }

  /** Le meilleur palier reellement atteint dans ce bareme. */
  function palierAtteint(g: typeof listeBaremes[number]): PalierBooking | null {
    const mBareme = montantBareme(g.bareme)
    const mTotal = montantTotal()
    const qte = qteBareme(g.bareme)
    let best: PalierBooking | null = null
    for (const pal of g.paliers) {
      const base = pal.seuil_sur === 'commande' ? mTotal : mBareme
      const okMontant = base >= pal.seuil_montant
      const okQte = pal.seuil_qte == null || qte >= pal.seuil_qte
      if (!okMontant || !okQte) continue
      if (!sousMinimumsRemplis(pal)) continue
      if (!best || pal.escompte_pct > best.escompte_pct) best = pal
    }
    return best
  }

  function sousMinimumsRemplis(pal: PalierBooking): boolean {
    const sm = pal.sous_minimums
    if (!Array.isArray(sm) || sm.length === 0) return true
    for (const s of sm) {
      let acc = 0
      for (const l of retenus.values()) {
        const c = parCle.get(l.code_piece)
        if (c && correspond(c.p, s.axe, s.cible)) acc += l.montant
      }
      if (acc < s.montant) return false
    }
    return true
  }

  // Les candidats a l'etirement : les pieces qui tournent. Une piece sans
  // demande n'etire rien — c'est elle qui devient le stock mort de l'an
  // prochain. On les classe par cout de portage par dollar ajoute : la moins
  // chere a porter passe en premier.
  function candidatsEtirement(nomBareme: string): Candidat[] {
    return candidats
      .filter(c => c.deseason > 0)
      .filter(c => baremesDe(c.p).some(g => g.bareme === nomBareme))
      .sort((a, b) => {
        // Le portage d'un mois de stock supplementaire, par dollar.
        const ca = 1 / Math.max(a.deseason * a.p.cout_unitaire, 1e-6)
        const cb = 1 / Math.max(b.deseason * b.p.cout_unitaire, 1e-6)
        if (ca !== cb) return ca - cb
        return b.p.rotation - a.p.rotation
      })
  }

  const etatsBaremes: EtatBareme[] = []

  for (const g of listeBaremes) {
    const actuel = palierAtteint(g)
    const escompteActuel = actuel?.escompte_pct ?? 0
    const mAvant = montantBareme(g.bareme)

    // Le palier suivant qui apporte reellement plus.
    const suivant = g.paliers.find(pal =>
      pal.escompte_pct > escompteActuel &&
      (pal.seuil_sur === 'commande' ? montantTotal() : mAvant) < pal.seuil_montant)

    let gainEtirement: number | null = null
    let verdict: string | null = null
    let manque: number | null = null

    if (suivant) {
      const base = suivant.seuil_sur === 'commande' ? montantTotal() : mAvant
      manque = Math.max(0, suivant.seuil_montant - base)

      // Ce que l'etirement rapporte : l'escompte passe de d1 a d2 sur la
      // totalite du bareme, elargi du montant ajoute.
      const gainEscompte =
        (mAvant + manque) * (suivant.escompte_pct / 100) - mAvant * (escompteActuel / 100)

      // Ce qu'il coute : porter `manque` dollars sur les pieces les moins
      // cheres a porter du bareme.
      let reste = manque
      let coutPortage = 0
      for (const c of candidatsEtirement(g.bareme)) {
        if (reste <= 0) break
        const pris = Math.min(reste, c.p.cout_unitaire * Math.max(1, Math.ceil(c.deseason * 6)))
        const qte = pris / c.p.cout_unitaire
        coutPortage += portage(pris, moisPortageEtirement(c, qte), cfg.taux_possession)
        reste -= pris
      }
      if (reste > 0.01) {
        verdict = `Le palier ${suivant.niveau} demande ${Math.round(manque).toLocaleString('fr-CA')} $ de plus ` +
                  `que ce que les pieces qui tournent peuvent absorber. Non retenu.`
        gainEtirement = null
      } else {
        gainEtirement = Math.round((gainEscompte - coutPortage) * 100) / 100
        if (gainEtirement <= 0) {
          verdict = `Monter au palier ${suivant.niveau} rapporterait ${Math.round(gainEscompte).toLocaleString('fr-CA')} $ ` +
                    `d'escompte mais couterait ${Math.round(coutPortage).toLocaleString('fr-CA')} $ de portage. ` +
                    `Perte nette de ${Math.round(-gainEtirement).toLocaleString('fr-CA')} $ — on reste en dessous.`
        }
      }

      // On etire seulement si c'est rentable, et si le budget le permet.
      const budgetOk = d.objectif !== 'budget' || !d.budgetMax ||
        montantTotal() + manque <= d.budgetMax
      const vise = d.objectif === 'palier' && d.palierVise &&
        normaliser(suivant.niveau) === normaliser(d.palierVise)

      if ((gainEtirement !== null && gainEtirement > 0 && budgetOk && d.objectif !== 'couverture') || vise) {
        let aPlacer = manque
        for (const c of candidatsEtirement(g.bareme)) {
          if (aPlacer <= 0.01) break
          // On n'ajoute jamais plus de six mois de demande supplementaire sur
          // une meme piece : au-dela, on fabrique du surstock, pas un escompte.
          const qteMax = Math.max(1, Math.ceil(c.deseason * 6))
          const qte = Math.min(qteMax, Math.ceil(aPlacer / c.p.cout_unitaire))
          ajouter(c, qte, 'palier', true)
          aPlacer -= qte * c.p.cout_unitaire
        }
        verdict = `Etire jusqu'au palier ${suivant.niveau} : ` +
                  `${Math.round(manque).toLocaleString('fr-CA')} $ ajoutes pour un gain net de ` +
                  `${Math.round(gainEtirement ?? 0).toLocaleString('fr-CA')} $.`
      }
    }

    const apres = palierAtteint(g)
    const mApres = montantBareme(g.bareme)
    if (mApres <= 0) continue

    etatsBaremes.push({
      bareme: g.bareme, axe: g.axe, cible: g.cible,
      montant: Math.round(mApres * 100) / 100,
      qte: qteBareme(g.bareme),
      nb_pieces: [...retenus.values()].filter(l => {
        const c = parCle.get(l.code_piece); return c && baremesDe(c.p).some(x => x.bareme === g.bareme)
      }).length,
      palier_atteint: apres?.niveau ?? null,
      escompte_pct: apres?.escompte_pct ?? 0,
      prochain_niveau: suivant?.niveau ?? null,
      prochain_seuil: suivant?.seuil_montant ?? null,
      manque,
      gain_etirement: gainEtirement,
      verdict,
    })
  }

  // ── Le minimum de commande ────────────────────────────────────────
  if (prog.min_commande && montantTotal() > 0 && montantTotal() < prog.min_commande) {
    const manque = prog.min_commande - montantTotal()
    let aPlacer = manque
    for (const c of candidatsEtirement('global').length ? candidatsEtirement('global') : candidats) {
      if (aPlacer <= 0.01) break
      if (c.deseason <= 0) continue
      const qte = Math.min(Math.max(1, Math.ceil(c.deseason * 6)), Math.ceil(aPlacer / c.p.cout_unitaire))
      ajouter(c, qte, 'minimum', true)
      aPlacer -= qte * c.p.cout_unitaire
    }
    if (aPlacer > 0.01) {
      avertissements.push(
        `Le minimum de commande de ${prog.min_commande.toLocaleString('fr-CA')} $ n'est pas atteignable ` +
        `avec les seules pieces qui tournent : il manque ${Math.round(aPlacer).toLocaleString('fr-CA')} $.`)
    } else {
      avertissements.push(
        `${Math.round(manque).toLocaleString('fr-CA')} $ ont ete ajoutes uniquement pour atteindre le ` +
        `minimum de commande de ${prog.min_commande.toLocaleString('fr-CA')} $.`)
    }
  }

  // ── Le budget ─────────────────────────────────────────────────────
  let lignes = [...retenus.values()]
  if (d.objectif === 'budget' && d.budgetMax && montantTotal() > d.budgetMax) {
    // On coupe par la fin : les lignes d'etirement d'abord, puis les besoins
    // les moins urgents (rotation la plus faible).
    lignes.sort((a, b) => {
      if (a.qte_etirement !== b.qte_etirement) return a.qte_etirement - b.qte_etirement
      return b.rotation - a.rotation
    })
    let cumul = 0
    const gardees: LigneBooking[] = []
    for (const l of lignes) {
      if (cumul + l.montant <= d.budgetMax) { gardees.push(l); cumul += l.montant }
    }
    lignes = gardees
    avertissements.push(
      `Commande plafonnee a ${d.budgetMax.toLocaleString('fr-CA')} $ : les lignes d'etirement ont ete ` +
      `retirees en premier, puis les besoins les moins urgents.`)
  }

  // ── Escompte, dating, portage ─────────────────────────────────────
  const montantBrut = lignes.reduce((s, l) => s + l.montant, 0)

  // L'escompte de palier, pondere par ce que chaque bareme represente.
  let escompteDollars = 0
  for (const l of lignes) {
    const c = parCle.get(l.code_piece)
    if (!c) continue
    const siens = baremesDe(c.p)
    // Baremes exclusifs : un seul compte. Sinon ils s'additionnent.
    const pcts = siens.map(g => etatsBaremes.find(e => e.bareme === g.bareme)?.escompte_pct ?? 0)
    const pct = prog.baremes_exclusifs ? (pcts[0] ?? 0) : pcts.reduce((s, v) => s + v, 0)
    escompteDollars += l.montant * (pct / 100)
  }

  // Les bonus. Meme groupe = concurrence, groupes differents = addition.
  const detailBonus: ResultatBooking['detail_bonus'] = []
  const parGroupe = new Map<string, BonusBooking[]>()
  for (const b of d.bonus) {
    if (b.type === 'paiement_rapide' || b.type === 'commandes_bonus' || b.type === 'transport') continue
    const g = b.groupe || 'defaut'
    parGroupe.set(g, [...(parGroupe.get(g) || []), b])
  }
  for (const [, liste] of parGroupe) {
    const applicables = liste.filter(b => {
      if (!b.avant_le) return true
      return new Date(b.avant_le + 'T23:59:59') >= d.dateCommande
    })
    const perimes = liste.filter(b => !applicables.includes(b))
    for (const b of perimes) {
      detailBonus.push({ libelle: b.libelle, valeur_pct: b.valeur_pct, retenu: false,
        pourquoi: `Echu le ${b.avant_le}.` })
    }
    if (!applicables.length) continue
    const best = applicables.reduce((a, b) => (b.valeur_pct > a.valeur_pct ? b : a))
    for (const b of applicables) {
      if (b === best) continue
      detailBonus.push({ libelle: b.libelle, valeur_pct: b.valeur_pct, retenu: false,
        pourquoi: `Remplace par « ${best.libelle} », plus avantageux dans le meme groupe.` })
    }
    // Un bonus 'sous_ensemble' ne porte que sur les lignes qu'il vise.
    let assiette = montantBrut
    if (best.type === 'sous_ensemble') {
      assiette = lignes.reduce((s, l) => {
        const c = parCle.get(l.code_piece)
        return s + (c && correspond(c.p, best.axe, best.cible) ? l.montant : 0)
      }, 0)
    }
    escompteDollars += assiette * (best.valeur_pct / 100)
    detailBonus.push({ libelle: best.libelle, valeur_pct: best.valeur_pct, retenu: true })
  }

  const montantNet = montantBrut - escompteDollars

  // Le dating. On compare l'echeancier du meilleur palier retenu aux termes
  // ordinaires, puis a l'escompte de paiement rapide s'il en existe un — ils
  // sont exclusifs l'un de l'autre.
  const echeanciers = etatsBaremes
    .map(e => d.paliers.find(p => p.bareme === e.bareme && p.niveau === e.palier_atteint))
    .filter((p): p is PalierBooking => !!p && Array.isArray(p.echeancier) && p.echeancier.length > 0)

  let datingJours = 0
  if (echeanciers.length) {
    // Le plus long des echeanciers offerts : c'est celui que porte la commande.
    for (const pal of echeanciers) {
      const moyen = pal.echeancier.reduce((s, e) => s + e.part * e.jours, 0)
      if (moyen > datingJours) datingJours = moyen
    }
  }
  const joursGagnes = Math.max(0, datingJours - cfg.termes_standard_jours)
  const valeurDatingPct = cfg.cout_capital_annuel * (joursGagnes / 365) * 100

  const rapide = d.bonus.find(b => b.type === 'paiement_rapide')
  let datingChoisi: ResultatBooking['dating_choisi'] = 'aucun'
  let datingDollars = 0
  if (rapide && rapide.valeur_pct > valeurDatingPct) {
    datingChoisi = 'paiement_rapide'
    datingDollars = montantNet * (rapide.valeur_pct / 100)
    detailBonus.push({
      libelle: `${rapide.libelle} — retenu`, valeur_pct: rapide.valeur_pct, retenu: true,
      pourquoi: `L'escompte de ${rapide.valeur_pct} % bat le dating, qui ne vaut que ` +
                `${valeurDatingPct.toFixed(2)} % au cout du capital de ${(cfg.cout_capital_annuel * 100).toFixed(1)} %/an.`,
    })
  } else if (valeurDatingPct > 0) {
    datingChoisi = 'dating'
    datingDollars = montantNet * (valeurDatingPct / 100)
    if (rapide) {
      detailBonus.push({
        libelle: `${rapide.libelle} — ecarte`, valeur_pct: rapide.valeur_pct, retenu: false,
        pourquoi: `Le dating gagne ${Math.round(joursGagnes)} jours, soit ${valeurDatingPct.toFixed(2)} % ` +
                  `au cout du capital de ${(cfg.cout_capital_annuel * 100).toFixed(1)} %/an — ` +
                  `mieux que les ${rapide.valeur_pct} % de l'escompte.`,
      })
    }
  }

  const portageDollars = lignes.reduce((s, l) => s + l.portage_dollars, 0)

  // Le transport evite, quand le programme l'offre au-dela d'un seuil.
  let transportDollars = 0
  const francoAtteint = prog.franco_seuil != null && montantNet >= prog.franco_seuil
  if (francoAtteint && prog.transport_pct) transportDollars = montantNet * (prog.transport_pct / 100)

  lignes.sort((a, b) => b.montant - a.montant)
  lignes.forEach((l, i) => { (l as any).rang = i })

  const escomptePct = montantBrut > 0 ? (escompteDollars / montantBrut) * 100 : 0

  return {
    lignes,
    baremes: etatsBaremes.sort((a, b) => b.montant - a.montant),
    montant_brut: Math.round(montantBrut * 100) / 100,
    escompte_pct: Math.round(escomptePct * 100) / 100,
    escompte_dollars: Math.round(escompteDollars * 100) / 100,
    montant_net: Math.round(montantNet * 100) / 100,
    dating_jours: Math.round(joursGagnes),
    dating_dollars: Math.round(datingDollars * 100) / 100,
    dating_choisi: datingChoisi,
    portage_dollars: Math.round(portageDollars * 100) / 100,
    transport_dollars: Math.round(transportDollars * 100) / 100,
    gain_net_dollars: Math.round((escompteDollars + datingDollars + transportDollars - portageDollars) * 100) / 100,
    nb_lignes: lignes.length,
    couvre_debut: couvreDebut.toISOString().slice(0, 10),
    couvre_fin: couvreFin.toISOString().slice(0, 10),
    livraison: livraison.toISOString().slice(0, 10),
    avertissements,
    detail_bonus: detailBonus,
  }
}
