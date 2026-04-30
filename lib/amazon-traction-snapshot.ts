// Helper : photo figée de traction_amazon_lignes par settlement.
// Garantit que les calculs (lautopak-docs, fba-comparison, audits) ne
// bougent pas si Traction est resync après l'import d'un settlement.

import { supabaseAdmin } from './supabase'

export interface TractionSnapshotRow {
  pk_code: string
  pk_fournisseur: string
  code_ligne: string
  qty: number
  qty_minus_reserved: number
  prix_coutant: number
  desc_fra: string | null
}

// Crée la photo de traction_amazon_lignes pour un settlement donné.
// À appeler à la fin de l'import du settlement.
// Si un snapshot existe déjà pour ce settlement, on ne refait rien
// (idempotent — les ré-imports ne re-snapshottent pas, ce qui préserve
// l'état initial). Pour forcer un nouveau snapshot, supprimer d'abord.
export async function createTractionSnapshot(settlement_id: string): Promise<{ inserted: number; skipped?: boolean }> {
  // Vérifier qu'aucun snapshot n'existe déjà
  const { count } = await supabaseAdmin
    .from('amazon_traction_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('settlement_id', settlement_id)
  if ((count || 0) > 0) {
    return { inserted: 0, skipped: true }
  }

  // Charger toutes les lignes Traction Amazon (AMA + FBA + FBM)
  const allRows: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('traction_amazon_lignes')
      .select('pk_code, pk_fournisseur, code_ligne, qty, qty_minus_reserved, prix_coutant, desc_fra')
      .in('code_ligne', ['AMA', 'FBA', 'FBM'])
      .range(from, from + 999)
    if (error) throw error
    allRows.push(...(data || []))
    if (!data || data.length < 1000) break
    from += 1000
  }

  // Insertion par lots
  const toInsert = allRows.map(r => ({
    settlement_id,
    pk_code: r.pk_code,
    pk_fournisseur: r.pk_fournisseur || '',
    code_ligne: r.code_ligne,
    qty: r.qty,
    qty_minus_reserved: r.qty_minus_reserved,
    prix_coutant: r.prix_coutant,
    desc_fra: r.desc_fra,
  }))
  let inserted = 0
  for (let i = 0; i < toInsert.length; i += 500) {
    const batch = toInsert.slice(i, i + 500)
    const { error } = await supabaseAdmin.from('amazon_traction_snapshots').insert(batch)
    if (error) throw error
    inserted += batch.length
  }
  return { inserted }
}

// Charge l'inventaire Traction pour un settlement donné.
// 1. Si un snapshot existe → renvoie les rows snapshot (état figé à l'import)
// 2. Sinon → fallback sur traction_amazon_lignes live
//    (utile pour les settlements importés AVANT la mise en place du snapshot)
export async function loadTractionForSettlement(
  settlement_id: string | null,
  options: { code_ligne_in?: string[] } = {},
): Promise<TractionSnapshotRow[]> {
  const codeLigne = options.code_ligne_in || ['AMA', 'FBA', 'FBM']

  // 1) Tentative snapshot
  if (settlement_id) {
    const rows: TractionSnapshotRow[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('amazon_traction_snapshots')
        .select('pk_code, pk_fournisseur, code_ligne, qty, qty_minus_reserved, prix_coutant, desc_fra')
        .eq('settlement_id', settlement_id)
        .in('code_ligne', codeLigne)
        .range(from, from + 999)
      if (error) break
      rows.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }
    if (rows.length > 0) return rows
  }

  // 2) Fallback live
  const liveRows: TractionSnapshotRow[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('traction_amazon_lignes')
      .select('pk_code, pk_fournisseur, code_ligne, qty, qty_minus_reserved, prix_coutant, desc_fra')
      .in('code_ligne', codeLigne)
      .range(from, from + 999)
    if (error) break
    liveRows.push(...(data || []))
    if (!data || data.length < 1000) break
    from += 1000
  }
  return liveRows
}
