// Résolution intelligente SKU Amazon → code Traction.
//
// Ordre des stratégies:
//   1. Cache amazon_sku_mapping (exact)
//   2. Match exact dans traction_amazon_lignes.pk_code
//   3. Retirer suffixes (-FBA, -FBM, -AMA, -FBA1, -FBA2...)
//   4. Retirer préfixes (FBA-, FBM-, AMA-)
//   5. Les deux combinés
//   6. Match ignore-case en dernier recours
//
// Un échec laisse traction_code=null + resolution_source='none'.

import { supabaseAdmin } from './supabase'

export type ResolutionSource = 'cache' | 'exact' | 'suffix' | 'prefix' | 'both' | 'icase' | 'none'

export interface ResolvedSku {
  traction_code: string | null
  source: ResolutionSource
  confidence: number
}

const SUFFIX_RE = /-(FBA|FBM|AMA)(\d*)$/i
const PREFIX_RE = /^(FBA|FBM|AMA)-/i

function stripSuffix(sku: string): string {
  return sku.replace(SUFFIX_RE, '')
}
function stripPrefix(sku: string): string {
  return sku.replace(PREFIX_RE, '')
}
function stripBoth(sku: string): string {
  return stripSuffix(stripPrefix(sku))
}

export class SkuResolver {
  private cache = new Map<string, string>()          // amazon_sku → traction_code (from amazon_sku_mapping)
  private tractionSet = new Set<string>()             // PKCode present in traction_amazon_lignes
  private tractionLowerMap = new Map<string, string>() // lowercase → original PKCode
  private pending = new Map<string, { traction_code: string; source: ResolutionSource; confidence: number }>()

  async init() {
    // Charger le cache de mapping
    const { data: mappings } = await supabaseAdmin
      .from('amazon_sku_mapping')
      .select('amazon_sku, traction_code')
    for (const m of mappings || []) {
      if (m.amazon_sku && m.traction_code) this.cache.set(m.amazon_sku, m.traction_code)
    }
    // Charger les PKCode disponibles dans les lignes Amazon Traction (paginé)
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code')
        .range(from, from + 999)
      if (error) break
      for (const r of data || []) {
        if (r.pk_code) {
          this.tractionSet.add(r.pk_code)
          this.tractionLowerMap.set(r.pk_code.toLowerCase(), r.pk_code)
        }
      }
      if (!data || data.length < 1000) break
      from += 1000
    }
  }

  resolve(amazonSku: string | null | undefined): ResolvedSku {
    if (!amazonSku) return { traction_code: null, source: 'none', confidence: 0 }
    const sku = amazonSku.trim()
    if (!sku) return { traction_code: null, source: 'none', confidence: 0 }

    // 1. cache
    const cached = this.cache.get(sku)
    if (cached) return { traction_code: cached, source: 'cache', confidence: 1 }

    // 2. exact
    if (this.tractionSet.has(sku)) {
      return this.learn(sku, sku, 'exact', 1)
    }

    // 3. suffix
    const noSuffix = stripSuffix(sku)
    if (noSuffix !== sku && this.tractionSet.has(noSuffix)) {
      return this.learn(sku, noSuffix, 'suffix', 0.95)
    }

    // 4. prefix
    const noPrefix = stripPrefix(sku)
    if (noPrefix !== sku && this.tractionSet.has(noPrefix)) {
      return this.learn(sku, noPrefix, 'prefix', 0.95)
    }

    // 5. both
    const noBoth = stripBoth(sku)
    if (noBoth !== sku && noBoth !== noSuffix && noBoth !== noPrefix && this.tractionSet.has(noBoth)) {
      return this.learn(sku, noBoth, 'both', 0.9)
    }

    // 6. case-insensitive exact + stripped
    const tryLower = (candidate: string): string | null => {
      return this.tractionLowerMap.get(candidate.toLowerCase()) || null
    }
    const ic1 = tryLower(sku)
    if (ic1) return this.learn(sku, ic1, 'icase', 0.85)
    if (noSuffix !== sku) { const x = tryLower(noSuffix); if (x) return this.learn(sku, x, 'icase', 0.85) }
    if (noPrefix !== sku) { const x = tryLower(noPrefix); if (x) return this.learn(sku, x, 'icase', 0.85) }
    if (noBoth !== sku)   { const x = tryLower(noBoth);   if (x) return this.learn(sku, x, 'icase', 0.8) }

    return { traction_code: null, source: 'none', confidence: 0 }
  }

  private learn(amazonSku: string, tractionCode: string, source: ResolutionSource, confidence: number): ResolvedSku {
    this.cache.set(amazonSku, tractionCode)
    this.pending.set(amazonSku, { traction_code: tractionCode, source, confidence })
    return { traction_code: tractionCode, source, confidence }
  }

  // Sauvegarde les mappings appris automatiquement pour accélérer les prochains imports
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
