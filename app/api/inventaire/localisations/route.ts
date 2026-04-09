import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — chercher par localisation ou par code pièce
export async function GET(req: NextRequest) {
  try {
    const stats = req.nextUrl.searchParams.get('stats')
    if (stats === '1') {
      // Compter les pièces uniques par localisation (colonnes localisation1,2,3,4)
      const { data, error } = await supabaseAdmin
        .from('inventaire_localisations')
        .select('code_piece, localisation1, localisation2, localisation3, localisation4')
      if (error) throw error
      const map = new Map<string, Set<string>>()
      for (const r of data || []) {
        const locs = [r.localisation1, r.localisation2, r.localisation3, r.localisation4].filter(Boolean)
        for (const loc of locs) {
          if (!map.has(loc)) map.set(loc, new Set())
          map.get(loc)!.add(r.code_piece)
        }
      }
      return NextResponse.json(Array.from(map.entries()).map(([localisation, pieces]) => ({
        localisation,
        total_pieces: pieces.size
      })))
    }
    const loc = req.nextUrl.searchParams.get('loc')?.trim()
    const code = req.nextUrl.searchParams.get('code')?.trim()

    if (code) {
      const { data, error } = await supabaseAdmin
        .from('inventaire_localisations')
        .select('*')
        .ilike('code_piece', code)
        .limit(10)
      if (error) throw error
      return NextResponse.json(data || [])
    }

    if (!loc) return NextResponse.json([])

    const [r1, r2, r3, r4] = await Promise.all([
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation1', loc).limit(5000),
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation2', loc).limit(5000),
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation3', loc).limit(5000),
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation4', loc).limit(5000),
    ])

    const seen = new Set<number>()
    const results: any[] = []
    for (const r of [r1, r2, r3, r4]) {
      for (const row of r.data || []) {
        if (!seen.has(row.id)) { seen.add(row.id); results.push(row) }
      }
    }
    results.sort((a, b) => a.code_piece.localeCompare(b.code_piece))
    return NextResponse.json(results)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer une nouvelle localisation vide
export async function POST(req: NextRequest) {
  try {
    const { localisation, employe } = await req.json()
    if (!localisation) return NextResponse.json({ erreur: 'localisation requise' }, { status: 400 })

    // Insérer une ligne placeholder pour mémoriser la localisation
    const { error } = await supabaseAdmin.from('inventaire_localisations').insert({
      code_piece: `LOC_${localisation}`,
      fournisseur: null,
      description: `Nouvelle localisation créée par ${employe}`,
      localisation1: localisation,
      localisation2: null,
      localisation3: null,
      localisation4: null,
    })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
