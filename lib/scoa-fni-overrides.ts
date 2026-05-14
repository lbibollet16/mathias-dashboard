// Helper : applique les attributions FNI (scoa_fni_assignments) aux ventes.
// Pour chaque vente, si le « core » de son stock_num matche une attribution,
// le vendeur_nom est remplacé par le vendeur FNI assigné.
//
// Match par « core » = la partie YY-NNNN extraite, indépendamment du préfixe
// (« P22-0980 », « C24-0001 », « AC25-0331 » → core « 22-0980 », « 24-0001 »,
// « 25-0331 »). Permet à une attribution Excel « 24-2300 » de couvrir aussi
// « 24-2300A », « C24-2300 », etc.

import { supabaseAdmin } from '@/lib/supabase'

// Extrait la partie centrale YY-NNNN (4 chiffres séparés par un dash).
export function stockCore(s: string): string {
  if (!s) return ''
  const m = /(\d{2}-\d{4})/.exec(s)
  return m ? m[1] : s.trim()
}

export type FniAssignment = { stock_num: string, fni_vendeur_nom: string }

let _cache: { ts: number, map: Map<string, string> } | null = null
const CACHE_TTL_MS = 60_000   // 1 minute

// Récupère les attributions et construit la map (stockCore → fni_vendeur_nom).
// Mise en cache 60 s pour éviter de lire la table sur chaque requête dashboard.
export async function chargerFniMap(): Promise<Map<string, string>> {
  const now = Date.now()
  if (_cache && (now - _cache.ts) < CACHE_TTL_MS) return _cache.map

  const { data, error } = await supabaseAdmin
    .from('scoa_fni_assignments')
    .select('stock_num, fni_vendeur_nom')
  if (error) {
    console.error('[scoa-fni-overrides] erreur chargement :', error)
    return new Map()
  }
  const map = new Map<string, string>()
  for (const a of (data || [])) {
    const core = stockCore(a.stock_num)
    if (core) map.set(core, a.fni_vendeur_nom)
  }
  _cache = { ts: now, map }
  return map
}

// Applique l'override sur un tableau de ventes. Retourne une copie modifiée.
export async function appliquerOverridesFni<T extends { stock_num: string, vendeur_nom?: string | null, vendeur_id?: string | null }>(ventes: T[]): Promise<T[]> {
  if (!ventes || ventes.length === 0) return ventes
  const map = await chargerFniMap()
  if (map.size === 0) return ventes
  return ventes.map(v => {
    const override = map.get(stockCore(v.stock_num))
    if (!override) return v
    return { ...v, vendeur_nom: override, vendeur_id: null }
  })
}

// Permet d'invalider le cache (ex: après import d'un nouveau fichier).
export function invaliderCacheFni() {
  _cache = null
}
