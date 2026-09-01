// Détail par pièce du dernier run — filtrable et paginé.
// Sert à la fois au drill-down (clic sur un fournisseur / un code de ligne) et
// à la recherche libre.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'

const TRIS: Record<string, string> = {
  valeur: 'valeur_stock', exces: 'exces_valeur', morte: 'valeur_morte',
  urgence: 'score_urgence', rotation: 'rotation', couverture: 'couverture_mois',
  demande: 'demande_mens', stock: 'stock', ventes: 'ventes_12m_cogs',
  code: 'code_piece', commander: 'qte_a_commander',
}

export async function GET(req: NextRequest) {
  try {
    const run = await dernierRun()
    if (!run) return NextResponse.json({ pieces: [], total: 0, pret: false })

    const p = req.nextUrl.searchParams
    const fournisseur = p.get('fournisseur')
    const ligne = p.get('ligne')
    const statut = p.get('statut')
    const abc = p.get('abc')
    const xyz = p.get('xyz')
    const q = (p.get('q') || '').trim()
    const tri = TRIS[p.get('tri') || 'valeur'] || 'valeur_stock'
    const sens = p.get('sens') === 'asc'
    const page = Math.max(0, parseInt(p.get('page') || '0', 10))
    const taille = Math.min(500, Math.max(10, parseInt(p.get('taille') || '100', 10)))

    let req_ = supabaseAdmin
      .from('sc_analyse_pieces')
      .select('*', { count: 'exact' })
      .eq('run_id', run.run_id)

    if (fournisseur) req_ = req_.eq('fournisseur', fournisseur)
    if (ligne) req_ = req_.eq('code_ligne', ligne)
    if (statut) req_ = req_.in('statut', statut.split(','))
    if (abc) req_ = req_.in('classe_abc', abc.split(','))
    if (xyz) req_ = req_.in('classe_xyz', xyz.split(','))
    if (q) {
      // Recherche sur le code OU la description. Les caractères réservés de
      // PostgREST (virgule, parenthèses) casseraient le filtre `or` : on les
      // neutralise plutôt que de risquer une requête malformée.
      const s = q.replace(/[,()%\\]/g, ' ').trim()
      if (s) req_ = req_.or(`code_piece.ilike.%${s}%,description.ilike.%${s}%`)
    }

    const { data, error, count } = await req_
      .order(tri, { ascending: sens, nullsFirst: false })
      .range(page * taille, page * taille + taille - 1)
    if (error) throw new Error(error.message)

    return NextResponse.json({
      pret: true, pieces: data || [], total: count || 0, page, taille,
    })

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
