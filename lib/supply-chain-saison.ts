// ═══════════════════════════════════════════════════════════════════════
// Saisonnalité
// ═══════════════════════════════════════════════════════════════════════

/**
 * Indice saisonnier : combien un mois pèse par rapport à un mois moyen.
 * 12 valeurs de moyenne 1 — mai à 1,89 veut dire « on vend 89 % de plus qu'un
 * mois moyen ».
 *
 * Pourquoi c'est indispensable ici : l'activité oscille d'un facteur 4 entre
 * décembre (0,48) et mai (1,89), et les familles ne suivent pas le même
 * calendrier — la ligne 30 culmine en octobre (2,43) quand la ligne TOI culmine
 * en juillet (2,06). Une demande calculée en moyenne plate sur 12 mois donne
 * donc un point de commande trop bas juste avant la saison, et trop haut juste
 * après : exactement l'inverse de ce qu'il faut.
 *
 * ── Le piège : le bruit ────────────────────────────────────────────────
 * Avec 2 à 3 années d'historique, chaque mois calendaire ne compte que 2 ou 3
 * observations. Un indice brut prend alors des valeurs absurdes (0,12 en
 * février pour une ligne, sur une seule mauvaise année) qu'on appliquerait
 * ensuite à tout le réappro.
 *
 * On applique donc un RÉTRÉCISSEMENT (shrinkage) hiérarchique : chaque indice
 * est tiré vers son parent proportionnellement au peu de données qui le
 * soutient. Une ligne avec 3 ans de recul garde l'essentiel de son profil ; une
 * ligne avec 1 an est ramenée près du profil global. Une pièce n'a son propre
 * indice que si elle a du volume ET du recul, sinon elle prend celui de sa
 * ligne. C'est la façon standard de faire parler des séries courtes sans leur
 * faire dire n'importe quoi.
 */
export type IndiceSaison = number[]  // 12 valeurs, moyenne 1

export const SAISON_NEUTRE: IndiceSaison = new Array(12).fill(1)

/** Bornes de sécurité : au-delà, c'est du bruit, pas de la saison. */
const IDX_MIN = 0.25
const IDX_MAX = 3

/**
 * Construit un indice à partir des quantités par mois calendaire, en le tirant
 * vers `parent` d'autant plus fort que les observations sont rares.
 *
 * @param parMoisCal  12 tableaux : les totaux observés pour chaque mois calendaire
 * @param parent      indice de repli (global pour une ligne, ligne pour une pièce)
 * @param k           force du rétrécissement, en « années équivalentes »
 */
export function construireIndice(parMoisCal: number[][], parent: IndiceSaison, k: number): IndiceSaison {
  // Moyenne par mois calendaire, puis normalisation par la moyenne générale.
  const moyennes = parMoisCal.map(v => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null))
  const connues = moyennes.filter((x): x is number => x !== null)
  if (connues.length === 0) return [...parent]
  const niveau = connues.reduce((s, x) => s + x, 0) / connues.length
  if (niveau <= 0) return [...parent]

  const out: IndiceSaison = []
  for (let m = 0; m < 12; m++) {
    const n = parMoisCal[m].length
    if (n === 0 || moyennes[m] === null) { out.push(parent[m]); continue }
    const brut = moyennes[m]! / niveau
    // n observations contre k d'a priori : à n = k, on est à mi-chemin.
    const melange = (n * brut + k * parent[m]) / (n + k)
    out.push(Math.min(IDX_MAX, Math.max(IDX_MIN, melange)))
  }

  // Re-normaliser à moyenne 1 : le rétrécissement et les bornes ont pu décaler
  // le niveau, et un indice de moyenne ≠ 1 biaiserait la demande annuelle.
  const moy = out.reduce((s, x) => s + x, 0) / 12
  return moy > 0 ? out.map(x => x / moy) : [...parent]
}

/**
 * Indice moyen sur une fenêtre de `duree` mois démarrant à `depuis`
 * (mois calendaire 0-11) avec `fraction` du premier mois déjà écoulée.
 *
 * Sert au délai fournisseur : commander le 25 mai avec 14 jours de délai, c'est
 * couvrir surtout début juin — pas « le mois de mai ».
 */
export function indiceSurPeriode(idx: IndiceSaison, depuis: number, fraction: number, duree: number): number {
  if (duree <= 0) return idx[depuis % 12]
  let total = 0, restant = duree, m = depuis % 12
  // Ce qu'il reste du mois courant.
  let part = Math.min(1 - fraction, restant)
  total += idx[m] * part
  restant -= part
  m = (m + 1) % 12
  while (restant > 0) {
    part = Math.min(1, restant)
    total += idx[m] * part
    restant -= part
    m = (m + 1) % 12
  }
  return total / duree
}

/** Somme des indices sur les `duree` prochains mois (pour un besoin cumulé). */
export function sommeIndices(idx: IndiceSaison, depuis: number, duree: number): number {
  let total = 0
  for (let i = 0; i < duree; i++) total += idx[(depuis + i) % 12]
  return total
}

/**
 * Couverture réelle en mois : on consomme le stock au rythme saisonnier des
 * mois à venir, au lieu de diviser par une moyenne plate.
 *
 * « 4 mois de couverture » n'a pas le même sens en novembre (on traverse
 * l'hiver creux) qu'en mars (on entre dans la saison). Cette simulation le dit.
 */
export function couvertureSaisonniere(stock: number, deseason: number, idx: IndiceSaison, moisDepart: number): number | null {
  if (deseason <= 0) return null
  if (stock <= 0) return 0
  let reste = stock, mois = 0, m = moisDepart % 12
  while (mois < 120) {
    const conso = deseason * idx[m]
    if (conso <= 0) { mois += 1; m = (m + 1) % 12; continue }
    if (reste <= conso) return mois + reste / conso
    reste -= conso
    mois += 1
    m = (m + 1) % 12
  }
  return 120
}

export const MOIS_COURTS = ['jan', 'fév', 'mar', 'avr', 'mai', 'jun', 'jul', 'aoû', 'sep', 'oct', 'nov', 'déc']
