import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/inventaire/multi-loc-incomplets
// Liste les pièces présentes dans PLUSIEURS localisations dont le cycle de
// comptage est COMMENCÉ mais PAS terminé : au moins une loc comptée, mais pas
// toutes. Tant que toutes les locs ne sont pas comptées, l'écart de la pièce est
// faux (le système n'a qu'un total). Cette liste permet à l'employé de finir.
export async function GET() {
  try {
    // 1) Localisations connues par pièce (inventaire_localisations)
    const knownLocs = new Map<string, Set<string>>()
    let from = 0
    while (true) {
      const { data: rows } = await supabaseAdmin
        .from('inventaire_localisations')
        .select('code_piece, localisation1, localisation2, localisation3, localisation4')
        .range(from, from + 999)
      for (const r of rows || []) {
        if (!r.code_piece || r.code_piece.startsWith('LOC_')) continue
        const set = knownLocs.get(r.code_piece) || new Set<string>()
        for (const l of [r.localisation1, r.localisation2, r.localisation3, r.localisation4]) {
          if (l) set.add(String(l).toUpperCase())
        }
        knownLocs.set(r.code_piece, set)
      }
      if (!rows || rows.length < 1000) break
      from += 1000
    }

    // 2) Locs comptées (cycle en cours = statut reconcilie ou en_attente)
    const counted = new Map<string, { locs: Set<string>, derniere: string, employe: string, description: string }>()
    let cFrom = 0
    while (true) {
      const { data: rows } = await supabaseAdmin
        .from('inventaire_comptages')
        .select('code_piece, localisation, statut, date_comptage, employe')
        .in('statut', ['reconcilie', 'en_attente'])
        .order('date_comptage', { ascending: false })
        .range(cFrom, cFrom + 999)
      for (const c of rows || []) {
        const cur = counted.get(c.code_piece) || { locs: new Set<string>(), derniere: c.date_comptage, employe: c.employe || '', description: '' }
        cur.locs.add(String(c.localisation || '').toUpperCase())
        if (!cur.derniere || (c.date_comptage && c.date_comptage > cur.derniere)) { cur.derniere = c.date_comptage; cur.employe = c.employe || cur.employe }
        counted.set(c.code_piece, cur)
      }
      if (!rows || rows.length < 1000) break
      cFrom += 1000
    }

    // 3) Pièces multi-loc commencées mais incomplètes
    const lignes: any[] = []
    for (const [code, cnt] of counted) {
      const known = knownLocs.get(code)
      if (!known || known.size <= 1) continue // pas multi-loc
      const restantes = Array.from(known).filter(l => !cnt.locs.has(l))
      if (restantes.length === 0) continue // déjà toutes comptées
      lignes.push({
        code_piece: code,
        nb_total: known.size,
        nb_comptees: known.size - restantes.length,
        locs_comptees: Array.from(known).filter(l => cnt.locs.has(l)),
        locs_restantes: restantes,
        derniere_date: cnt.derniere,
        employe: cnt.employe,
      })
    }

    // Plus de bacs restants d'abord, puis comptage le plus ancien (à finir en priorité)
    lignes.sort((a, b) => (b.locs_restantes.length - a.locs_restantes.length)
      || String(a.derniere_date).localeCompare(String(b.derniere_date)))

    return NextResponse.json({ total: lignes.length, lignes })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
