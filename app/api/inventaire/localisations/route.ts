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
        // Exclure les placeholders LOC_* créés lors de la création d'une nouvelle localisation
        if (r.code_piece && r.code_piece.startsWith('LOC_')) continue
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
    const codes = req.nextUrl.searchParams.get('codes')?.trim()

    // Recherche multi-codes (pipe-séparé) — pour batch fetch des localisations
    // de plusieurs pièces sans saturer le serveur de requêtes individuelles.
    if (codes) {
      const list = codes.split('|').map(s => s.trim()).filter(Boolean)
      if (list.length === 0) return NextResponse.json([])
      const out: any[] = []
      for (let i = 0; i < list.length; i += 200) {
        const slice = list.slice(i, i + 200)
        const { data, error } = await supabaseAdmin
          .from('inventaire_localisations')
          .select('code_piece, localisation1, localisation2, localisation3, localisation4')
          .in('code_piece', slice)
        if (error) throw error
        if (data) out.push(...data)
      }
      return NextResponse.json(out)
    }

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

// PUT — ajouter une pièce à une localisation (ou créer l'entrée)
export async function PUT(req: NextRequest) {
  try {
    const { code_piece, localisation, description, fournisseur } = await req.json()
    if (!code_piece || !localisation) return NextResponse.json({ erreur: 'code_piece et localisation requis' }, { status: 400 })

    // Vérifier si la pièce existe déjà dans la table
    const { data: existing } = await supabaseAdmin
      .from('inventaire_localisations')
      .select('*')
      .ilike('code_piece', code_piece)
      .limit(1)

    if (existing && existing.length > 0) {
      // La pièce existe — ajouter la localisation dans le premier slot vide
      const row = existing[0]
      const update: any = {}
      if (!row.localisation1) update.localisation1 = localisation
      else if (!row.localisation2) update.localisation2 = localisation
      else if (!row.localisation3) update.localisation3 = localisation
      else if (!row.localisation4) update.localisation4 = localisation
      else {
        // Les 4 slots sont pleins — remplacer le dernier
        update.localisation4 = localisation
      }
      const { error } = await supabaseAdmin.from('inventaire_localisations').update(update).eq('id', row.id)
      if (error) throw error
      // Retourner la ligne mise à jour
      const { data: updated } = await supabaseAdmin.from('inventaire_localisations').select('*').eq('id', row.id).single()
      return NextResponse.json(updated)
    } else {
      // La pièce n'existe pas — créer une nouvelle entrée
      const { data: inserted, error } = await supabaseAdmin.from('inventaire_localisations').insert({
        code_piece,
        description: description || null,
        fournisseur: fournisseur || null,
        localisation1: localisation,
        localisation2: null,
        localisation3: null,
        localisation4: null,
      }).select().single()
      if (error) throw error
      return NextResponse.json(inserted)
    }
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
