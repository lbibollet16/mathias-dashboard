// Helper partagé pour synchroniser le flux Traction → table traction_amazon_lignes.
// Utilisé par /api/amazon/sync-traction (endpoint manuel) et /api/amazon/import
// (auto-déclenché sur import settlement).

import { supabaseAdmin } from './supabase'

const TRACTION_FEED_URL = 'https://mathias.tractiondk.com/traction/web/feedexport?key=dqw231Lkdqwoffw1fqwWWD24vLC&id=22523'
const LIGNES_AMAZON = new Set(['AMA', 'FBA', 'FBM'])

export interface SyncResult {
  success: boolean
  lignes: number
  par_ligne: Record<string, number>
  synced_at: string
  erreur?: string
}

export async function syncTractionFeed(): Promise<SyncResult> {
  try {
    const r = await fetch(TRACTION_FEED_URL, { cache: 'no-store' })
    if (!r.ok) throw new Error(`Traction feed HTTP ${r.status}`)
    const text = await r.text()

    const lines = text.split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) throw new Error('Feed Traction vide')

    const rows: any[] = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';')
      if (cols.length < 12) continue
      const code_ligne = (cols[10] || '').trim().toUpperCase()
      if (!LIGNES_AMAZON.has(code_ligne)) continue
      const pk_code = (cols[0] || '').trim()
      if (!pk_code) continue
      rows.push({
        pk_code,
        pk_fournisseur: (cols[1] || '').trim(),
        code_ligne,
        prix_liste1: parseFloat(cols[2]) || 0,
        prix_coutant: parseFloat(cols[5]) || 0,
        qty: parseFloat(cols[6]) || 0,
        qty_minus_reserved: parseFloat(cols[7]) || 0,
        qte_reserve: parseFloat(cols[8]) || 0,
        code_barres: (cols[9] || '').trim() || null,
        desc_fra: (cols[11] || '').trim() || null,
        synced_at: new Date().toISOString(),
      })
    }

    if (rows.length === 0) {
      return { success: true, lignes: 0, par_ligne: {}, synced_at: new Date().toISOString() }
    }

    await supabaseAdmin.from('traction_amazon_lignes').delete().neq('id', 0)

    let inserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('traction_amazon_lignes').insert(batch)
      if (error) throw error
      inserted += batch.length
    }

    const parLigne: Record<string, number> = {}
    for (const row of rows) parLigne[row.code_ligne] = (parLigne[row.code_ligne] || 0) + 1

    return {
      success: true,
      lignes: inserted,
      par_ligne: parLigne,
      synced_at: new Date().toISOString(),
    }
  } catch (e: any) {
    return { success: false, lignes: 0, par_ligne: {}, synced_at: new Date().toISOString(), erreur: e.message || String(e) }
  }
}
