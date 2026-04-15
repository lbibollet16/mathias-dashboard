// Détection du "base code" et de la location à partir d'un PKCode Traction.
//
// Patterns reconnus (seuls les 3 suivants selon confirmation utilisateur):
//   HUB-xxx  ou  xxx-HUB  → location = HUB (entrepôt)
//   FBA-xxx  ou  xxx-FBA[digits]  → location = FBA (chez Amazon)
//   FBM-xxx  ou  xxx-FBM  → location = FBM (chez toi prêt à expédier)
//   (aucun) → location = SANS_PREFIXE (oubli à tagger)
//
// Le "base code" est le pk_code nettoyé des préfixes/suffixes, et sert à
// regrouper les différents emplacements physiques d'un même produit.

export type Location = 'HUB' | 'FBA' | 'FBM' | 'SANS_PREFIXE'

export interface Variant {
  base: string
  location: Location
  pattern: string   // raison de la détection pour le debug
}

const PREFIX_RE = /^(HUB|FBA|FBM)-/i
const SUFFIX_RE = /-(HUB|FBA|FBM)(\d*)$/i

export function detectVariant(pkCode: string): Variant {
  if (!pkCode) return { base: '', location: 'SANS_PREFIXE', pattern: 'vide' }
  const code = pkCode.trim()

  // Test préfixe
  const mPrefix = code.match(PREFIX_RE)
  if (mPrefix) {
    const loc = mPrefix[1].toUpperCase() as Location
    const base = code.replace(PREFIX_RE, '')
    // Vérifier si un suffixe redouble (rare mais possible: FBA-xxx-HUB)
    const baseCleaned = base.replace(SUFFIX_RE, '')
    return { base: baseCleaned, location: loc, pattern: `préfixe ${loc}-` }
  }

  // Test suffixe
  const mSuffix = code.match(SUFFIX_RE)
  if (mSuffix) {
    const loc = mSuffix[1].toUpperCase() as Location
    const base = code.replace(SUFFIX_RE, '')
    return { base, location: loc, pattern: `suffixe -${loc}${mSuffix[2] || ''}` }
  }

  // Aucun préfixe/suffixe reconnu → "oubli"
  return { base: code, location: 'SANS_PREFIXE', pattern: 'aucun préfixe/suffixe' }
}

// Retourne toutes les variantes possibles pour un base code
// (utile pour l'audit: chercher toutes les versions d'un SKU)
export function expandBase(base: string): string[] {
  return [
    base,
    `HUB-${base}`,
    `${base}-HUB`,
    `FBA-${base}`,
    `${base}-FBA`,
    `FBM-${base}`,
    `${base}-FBM`,
  ]
}
