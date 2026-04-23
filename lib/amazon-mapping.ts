// Helper partagé : charge les multi-mappings SKU Amazon → [{pk_code, multiplier}]
// et fournit des utilitaires pour distribuer la quantité Amazon vers les PKCodes
// correspondants en unités physiques Traction (× multiplier).

import { supabaseAdmin } from './supabase'
import { detectVariant } from './amazon-inventory'

export type Mapping = { pk_code: string; multiplier: number }

export async function loadManualMappings(): Promise<Map<string, Mapping[]>> {
  const map = new Map<string, Mapping[]>()
  const { data } = await supabaseAdmin
    .from('amazon_sku_pkcodes')
    .select('amazon_sku, pk_code, multiplier')
  for (const m of data || []) {
    const mult = Number(m.multiplier) > 0 ? Number(m.multiplier) : 1
    const list = map.get(m.amazon_sku) || []
    list.push({ pk_code: m.pk_code, multiplier: mult })
    map.set(m.amazon_sku, list)
  }
  return map
}

// Wide base qui ignore les préfixes A, HUB, FBA, FBM (retrocompat pour auto-detect)
export function wideBase(code: string | null | undefined): string {
  if (!code) return ''
  const narrow = detectVariant(code).base
  const m = /^[Aa](\d.*)$/.exec(narrow)
  return m ? m[1] : narrow
}

// Pour un Amazon FBA row avec qté X, retourne la liste des bases Traction à
// créditer avec la qté physique correspondante (× multiplier si manual mapping).
// Si aucun mapping manuel : fallback wideBase auto.
export function distributeToBases(
  amazonSku: string,
  tractionCode: string | null | undefined,
  amazonQty: number,
  mappings: Map<string, Mapping[]>,
): { base: string; physical_qty: number; pk_code?: string; multiplier?: number }[] {
  const manual = mappings.get(amazonSku)
  if (manual && manual.length > 0) {
    // Crédite chaque pk_code mappé avec amazonQty × multiplier
    // (si l'utilisateur a mappé à plusieurs pk_codes, ils reçoivent tous la même qté physique — cas rare).
    return manual.map(m => ({
      base: detectVariant(m.pk_code).base || m.pk_code,
      physical_qty: amazonQty * m.multiplier,
      pk_code: m.pk_code,
      multiplier: m.multiplier,
    }))
  }
  // Fallback auto : wideBase du traction_code résolu ou du sku Amazon
  const code = tractionCode || amazonSku
  const base = wideBase(code)
  return base ? [{ base, physical_qty: amazonQty }] : []
}
