import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const loc = req.nextUrl.searchParams.get('loc')?.trim()
    if (!loc) return NextResponse.json([])

    // Faire 4 requêtes séparées et combiner les résultats
    const [r1, r2, r3, r4] = await Promise.all([
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation1', loc).limit(500),
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation2', loc).limit(500),
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation3', loc).limit(500),
      supabaseAdmin.from('inventaire_localisations').select('*').ilike('localisation4', loc).limit(500),
    ])

    // Combiner et dédupliquer par id
    const seen = new Set<number>()
    const results: any[] = []
    for (const r of [r1, r2, r3, r4]) {
      for (const row of r.data || []) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          results.push(row)
        }
      }
    }

    results.sort((a, b) => a.code_piece.localeCompare(b.code_piece))
    return NextResponse.json(results)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
