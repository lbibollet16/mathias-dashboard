// Résolution intelligente SKU Amazon → code Traction.
//
// Stratégies (du plus fiable au plus approximatif):
//   1. cache      — mapping déjà appris (manuel ou auto)
//   2. exact      — match littéral
//   3. suffix     — retirer -FBA/-FBM/-AMA (+ numéro optionnel)
//   4. prefix     — retirer FBA-/FBM-/AMA-
//   5. both       — les deux combinés
//   6. normalized — strip tout non-alphanumérique + lowercase
//   7. icase      — match insensible à la casse (sans normalisation)
//   8. fuzzy      — Dice coefficient sur bigrams caractères (≥ 0.95 = auto)
//
// Règles de confiance:
//   • confidence ≥ 0.95 → auto-appliqué aux tables de données
//   • 0.80 ≤ confidence < 0.95 → PROPOSÉ à l'utilisateur (pas appliqué)
//   • confidence < 0.80 → ignoré, SKU reste unresolved

import { supabaseAdmin } from './supabase'

export type ResolutionSource =
  | 'cache' | 'exact' | 'suffix' | 'prefix' | 'both'
  | 'normalized' | 'icase' | 'fuzzy' | 'none'

export interface ResolvedSku {
  traction_code: string | null
  source: ResolutionSource
  confidence: number
}

export interface Suggestion {
  traction_code: string
  score: number
  source: ResolutionSource
}

const SUFFIX_RE = /-(FBA|FBM|AMA)(\d*)$/i
const PREFIX_RE = /^(FBA|FBM|AMA)-/i
const AUTO_APPLY_THRESHOLD = 0.95
const PROPOSE_THRESHOLD = 0.80

function stripSuffix(sku: string) { return sku.replace(SUFFIX_RE, '') }
function stripPrefix(sku: string) { return sku.replace(PREFIX_RE, '') }
function stripBoth(sku: string)   { return stripSuffix(stripPrefix(sku)) }

// Alphanumerique seulement + lowercase
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Dice coefficient sur bigrams de caractères (robuste aux petites variations)
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  if (s.length < 2) { if (s) out.add(s); return out }
  for (let i = 0; i < s.length - 1; i++) out.add(s.substring(i, i + 2))
  return out
}
function dice(aBg: Set<string>, bBg: Set<string>): number {
  if (aBg.size === 0 || bBg.size === 0) return 0
  let inter = 0
  for (const x of aBg) if (bBg.has(x)) inter++
  return (2 * inter) / (aBg.size + bBg.size)
}

export class SkuResolver {
  private cache = new Map<string, string>()             // amazon_sku → traction_code (manuel + auto uniquement)
  private tractionSet = new Set<string>()                // PKCode présents dans traction_amazon_lignes
  private tractionLower = new Map<string, string>()      // lowercase → PKCode
  private tractionNorm = new Map<string, string>()       // normalized → PKCode
  private tractionBigrams: Array<{code: string; normalized: string; bg: Set<string>}> = []
  private pending = new Map<string, { traction_code: string; source: ResolutionSource; confidence: number }>()

  async init() {
    // Cache mapping: seulement 'manuel' et 'auto' (jamais 'proposition')
    const { data: mappings } = await supabaseAdmin
      .from('amazon_sku_mapping')
      .select('amazon_sku, traction_code, source')
      .in('source', ['manuel', 'auto'])
    for (const m of mappings || []) {
      if (m.amazon_sku && m.traction_code) this.cache.set(m.amazon_sku, m.traction_code)
    }

    // Tous les PKCodes disponibles
    let from = 0
    const codes = new Set<string>()
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code')
        .range(from, from + 999)
      if (error) break
      for (const r of data || []) if (r.pk_code) codes.add(r.pk_code)
      if (!data || data.length < 1000) break
      from += 1000
    }

    for (const code of codes) {
      this.tractionSet.add(code)
      this.tractionLower.set(code.toLowerCase(), code)
      const n = normalize(code)
      if (n) this.tractionNorm.set(n, code)
      this.tractionBigrams.push({ code, normalized: n, bg: bigrams(n) })
    }
  }

  // Renvoie UNIQUEMENT les matches de haute confiance (≥ 0.95 pour fuzzy, ou déterministe)
  resolve(amazonSku: string | null | undefined): ResolvedSku {
    if (!amazonSku) return { traction_code: null, source: 'none', confidence: 0 }
    const sku = amazonSku.trim()
    if (!sku) return { traction_code: null, source: 'none', confidence: 0 }

    // 1. cache
    const cached = this.cache.get(sku)
    if (cached) return { traction_code: cached, source: 'cache', confidence: 1 }

    // 2. exact
    if (this.tractionSet.has(sku)) return this.learn(sku, sku, 'exact', 1)

    // 3. suffix
    const noSuffix = stripSuffix(sku)
    if (noSuffix !== sku && this.tractionSet.has(noSuffix)) {
      return this.learn(sku, noSuffix, 'suffix', 0.97)
    }

    // 4. prefix
    const noPrefix = stripPrefix(sku)
    if (noPrefix !== sku && this.tractionSet.has(noPrefix)) {
      return this.learn(sku, noPrefix, 'prefix', 0.97)
    }

    // 5. both
    const noBoth = stripBoth(sku)
    if (noBoth !== sku && noBoth !== noSuffix && noBoth !== noPrefix && this.tractionSet.has(noBoth)) {
      return this.learn(sku, noBoth, 'both', 0.96)
    }

    // 6. normalized (strip tout sauf alphanumérique)
    const norm = normalize(sku)
    if (norm) {
      const normMatch = this.tractionNorm.get(norm)
      if (normMatch) return this.learn(sku, normMatch, 'normalized', 0.96)
    }

    // 7. icase match sur les variantes
    const icase = (c: string) => this.tractionLower.get(c.toLowerCase()) || null
    for (const variant of [sku, noSuffix, noPrefix, noBoth]) {
      if (!variant || variant === sku) continue
      const m = icase(variant)
      if (m) return this.learn(sku, m, 'icase', 0.92)
    }
    const icaseExact = icase(sku)
    if (icaseExact && icaseExact !== sku) return this.learn(sku, icaseExact, 'icase', 0.92)

    // 8. fuzzy (Dice bigrams) — seuil élevé pour auto-apply
    const best = this.bestFuzzy(sku)
    if (best && best.score >= AUTO_APPLY_THRESHOLD) {
      return this.learn(sku, best.traction_code, 'fuzzy', best.score)
    }

    return { traction_code: null, source: 'none', confidence: 0 }
  }

  // Renvoie jusqu'à N suggestions triées par score, pour l'UI "propositions à confirmer"
  suggest(amazonSku: string, maxN: number = 5, threshold: number = PROPOSE_THRESHOLD): Suggestion[] {
    if (!amazonSku) return []
    const sku = amazonSku.trim()
    if (!sku) return []

    const results: Suggestion[] = []

    // Ajouter les matches déterministes comme suggestions (avec leur score implicite)
    const addIfNew = (code: string, score: number, source: ResolutionSource) => {
      if (!this.tractionSet.has(code)) return
      if (results.find(r => r.traction_code === code)) return
      results.push({ traction_code: code, score, source })
    }

    if (this.tractionSet.has(sku)) addIfNew(sku, 1, 'exact')
    const noSuffix = stripSuffix(sku); if (noSuffix !== sku) addIfNew(noSuffix, 0.97, 'suffix')
    const noPrefix = stripPrefix(sku); if (noPrefix !== sku) addIfNew(noPrefix, 0.97, 'prefix')
    const noBoth   = stripBoth(sku);   if (noBoth !== sku) addIfNew(noBoth, 0.96, 'both')

    const norm = normalize(sku)
    const normMatch = norm ? this.tractionNorm.get(norm) : null
    if (normMatch) addIfNew(normMatch, 0.96, 'normalized')

    // Toujours lancer le fuzzy pour trouver des candidats supplémentaires
    const fuzzy = this.topFuzzy(sku, maxN * 2)
    for (const f of fuzzy) {
      if (f.score >= threshold) addIfNew(f.traction_code, f.score, 'fuzzy')
    }

    // Trier par score descendant et tronquer
    return results
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxN)
  }

  // Meilleur match fuzzy (single)
  private bestFuzzy(sku: string): { traction_code: string; score: number } | null {
    const targets = this.topFuzzy(sku, 1)
    return targets[0] || null
  }

  // Top N matches fuzzy
  private topFuzzy(sku: string, n: number): Array<{ traction_code: string; score: number }> {
    const needleNorm = normalize(sku)
    if (!needleNorm || needleNorm.length < 2) return []
    const needleBg = bigrams(needleNorm)
    if (needleBg.size === 0) return []

    // Pré-filtre: ne comparer que les candidats dont la longueur est raisonnable
    const minLen = Math.max(2, Math.floor(needleNorm.length * 0.5))
    const maxLen = Math.ceil(needleNorm.length * 2)

    const scored: Array<{ traction_code: string; score: number }> = []
    for (const t of this.tractionBigrams) {
      if (t.normalized.length < minLen || t.normalized.length > maxLen) continue
      const s = dice(needleBg, t.bg)
      if (s >= PROPOSE_THRESHOLD) scored.push({ traction_code: t.code, score: s })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, n)
  }

  private learn(amazonSku: string, tractionCode: string, source: ResolutionSource, confidence: number): ResolvedSku {
    this.cache.set(amazonSku, tractionCode)
    this.pending.set(amazonSku, { traction_code: tractionCode, source, confidence })
    return { traction_code: tractionCode, source, confidence }
  }

  async persistLearned() {
    if (this.pending.size === 0) return
    const rows = Array.from(this.pending.entries()).map(([amazon_sku, r]) => ({
      amazon_sku,
      traction_code: r.traction_code,
      source: 'auto',
      confidence: r.confidence,
    }))
    await supabaseAdmin.from('amazon_sku_mapping').upsert(rows, { onConflict: 'amazon_sku', ignoreDuplicates: true })
    this.pending.clear()
  }
}
