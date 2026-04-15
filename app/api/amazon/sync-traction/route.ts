import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { syncTractionFeed } from '@/lib/amazon-traction-sync'

// POST — synchronise les pièces Traction sur les lignes Amazon (AMA/FBA/FBM)
// depuis le flux feedexport. Garde les multiples fournisseurs pour un même PKCode.
export async function POST() {
  const r = await syncTractionFeed()
  if (!r.success) return NextResponse.json({ erreur: r.erreur }, { status: 500 })
  return NextResponse.json(r)
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
