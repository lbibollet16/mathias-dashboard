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

    // Capture des pk_codes actuels AVANT le reset pour détecter les disparitions
    const prev: { pk_code: string; code_ligne: string; qty_minus_reserved: number; prix_coutant: number; desc_fra: string | null }[] = []
    {
      let from = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('traction_amazon_lignes')
          .select('pk_code, code_ligne, qty_minus_reserved, prix_coutant, desc_fra')
          .range(from, from + 999)
        if (!data || data.length === 0) break
        prev.push(...data as any)
        if (data.length < 1000) break
        from += 1000
      }
    }
    const newPkSet = new Set(rows.map(r => r.pk_code))

    await supabaseAdmin.from('traction_amazon_lignes').delete().neq('id', 0)

    let inserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('traction_amazon_lignes').insert(batch)
      if (error) throw error
      inserted += batch.length
    }

    // Archivage des pk_codes disparus (présents avant, absents maintenant).
    // Dédup par pk_code : si plusieurs rangées avec même pk_code (différents fourn),
    // on garde la somme de qty et la dernière desc/prix.
    const disparusMap = new Map<string, { code_ligne: string; qty: number; prix: number; desc: string | null }>()
    for (const p of prev) {
      if (!p.pk_code || newPkSet.has(p.pk_code)) continue
      const ex = disparusMap.get(p.pk_code) || { code_ligne: p.code_ligne, qty: 0, prix: Number(p.prix_coutant || 0), desc: p.desc_fra }
      ex.qty += Number(p.qty_minus_reserved || 0)
      if (ex.prix === 0) ex.prix = Number(p.prix_coutant || 0)
      if (!ex.desc) ex.desc = p.desc_fra
      disparusMap.set(p.pk_code, ex)
    }
    if (disparusMap.size > 0) {
      const archiveRows = [...disparusMap.entries()].map(([pk_code, v]) => ({
        pk_code,
        code_ligne: v.code_ligne,
        last_qty_dispo: v.qty,
        last_prix_coutant: v.prix,
        last_desc_fra: v.desc,
        last_seen_at: new Date().toISOString(),
      }))
      // Upsert : si déjà archivé, on n'écrase pas first_disappeared_at
      for (let i = 0; i < archiveRows.length; i += 500) {
        const batch = archiveRows.slice(i, i + 500)
        await supabaseAdmin.from('traction_sku_archive').upsert(batch, { onConflict: 'pk_code', ignoreDuplicates: false })
      }
    }
    // Si un pk_code réapparait dans le feed → on le retire de l'archive
    if (newPkSet.size > 0) {
      const reapparus = [...newPkSet]
      for (let i = 0; i < reapparus.length; i += 500) {
        const batch = reapparus.slice(i, i + 500)
        await supabaseAdmin.from('traction_sku_archive').delete().in('pk_code', batch)
      }
    }

    const parLigne: Record<string, number> = {}
    for (const row of rows) parLigne[row.code_ligne] = (parLigne[row.code_ligne] || 0) + 1

    return {
      success: true,
      lignes: inserted,
      par_ligne: parLigne,
      synced_at: new Date().toISOString(),
      nb_archives_ajoutees: disparusMap.size,
    } as any
  } catch (e: any) {
    return { success: false, lignes: 0, par_ligne: {}, synced_at: new Date().toISOString(), erreur: e.message || String(e) }
  }
}
