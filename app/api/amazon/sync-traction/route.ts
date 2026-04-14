import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST — synchronise les pièces Traction sur les lignes Amazon (AMA/FBA/FBM)
// depuis le flux feedexport. Garde les multiples fournisseurs pour un même PKCode.

const TRACTION_FEED_URL = 'https://mathias.tractiondk.com/traction/web/feedexport?key=dqw231Lkdqwoffw1fqwWWD24vLC&id=22523'
const LIGNES_AMAZON = new Set(['AMA', 'FBA', 'FBM'])

export async function POST() {
  try {
    const r = await fetch(TRACTION_FEED_URL, { cache: 'no-store' })
    if (!r.ok) throw new Error(`Traction feed HTTP ${r.status}`)
    const text = await r.text()

    const lines = text.split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) throw new Error('Feed Traction vide')

    // Header: PKCode;PKFournisseur;PrixListe1;PrixListe2;PrixListe3;PrixCoutant;QTY;QTYMINUSRESERVED;QteReserveEnStock;CodeBarres;CodeLigne;DescFra
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
      return NextResponse.json({ success: true, lignes: 0, message: 'Aucune ligne AMA/FBA/FBM trouvée' })
    }

    // Stratégie simple: on efface et on réinsère (idempotent par rapport au flux).
    await supabaseAdmin.from('traction_amazon_lignes').delete().neq('id', 0)

    // Insert par lots de 500
    let inserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('traction_amazon_lignes').insert(batch)
      if (error) throw error
      inserted += batch.length
    }

    // Compter par ligne
    const parLigne: Record<string, number> = {}
    for (const r of rows) parLigne[r.code_ligne] = (parLigne[r.code_ligne] || 0) + 1

    return NextResponse.json({
      success: true,
      lignes: inserted,
      par_ligne: parLigne,
      synced_at: new Date().toISOString(),
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// GET — renvoie les stats + dernière sync
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('traction_amazon_lignes')
      .select('code_ligne, synced_at')
      .limit(5000)
    if (error) throw error
    const counts: Record<string, number> = {}
    let latestSync: string | null = null
    for (const r of data || []) {
      counts[r.code_ligne] = (counts[r.code_ligne] || 0) + 1
      if (!latestSync || (r.synced_at && r.synced_at > latestSync)) latestSync = r.synced_at
    }
    return NextResponse.json({ counts, latest_sync: latestSync, total: (data || []).length })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
