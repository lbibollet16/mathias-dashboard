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
  code: 'code_piece', commander: 'qte_a_commander', saison: 'besoin_saison',
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
    // Même prédicat que l'action « Préparer la saison » : sans lui, le bouton
    // promet 31 pièces et en ouvre 3 000 triées par besoin. Un compte annoncé
    // doit ouvrir exactement ce qu'il annonce.
    const saison = p.get('saison') === '1'
    const tri = TRIS[p.get('tri') || 'valeur'] || 'valeur_stock'
    const sens = p.get('sens') === 'asc'
    const page = Math.max(0, parseInt(p.get('page') || '0', 10))
    const taille = Math.min(500, Math.max(10, parseInt(p.get('taille') || '100', 10)))

    let req_ = supabaseAdmin
      .from('sc_analyse_pieces')
      .select('*', { count: 'exact' })
      .eq('run_id', run.run_id)

    if (saison) {
      req_ = req_.gt('besoin_saison', 0).gt('indice_horizon', 1.15)
        .not('statut', 'in', '(rupture,sous_stock,sur_commande,mort,jamais_vendue,dormant)')
    }
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

    // Totaux sur TOUT le filtre, pas seulement la page affichée : quand on
    // arrive ici depuis « Voir les 1 149 pièces », la première question est
    // « ça représente combien ? ». Sans ça, l'écran ne montre que 100 lignes
    // sans jamais dire ce que pèse l'ensemble.
    const totaux = await totauxFiltre(run.run_id, { fournisseur, ligne, statut, abc, xyz, q, saison }, count || 0)

    return NextResponse.json({
      pret: true, pieces: data || [], total: count || 0, page, taille, totaux,
    })

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

/**
 * Somme les colonnes qui comptent sur l'ensemble du filtre.
 *
 * PostgREST ne garantit pas les fonctions d'agrégation (elles dépendent d'un
 * réglage Supabase souvent désactivé), donc on additionne côté serveur en
 * relisant uniquement les six colonnes numériques utiles — jamais les lignes
 * complètes. Au-delà de 25 000 pièces on renonce : l'utilisateur n'a de toute
 * façon pas de filtre utile à ce niveau, et ça éviterait 25 allers-retours
 * pour un total qu'il ne lira pas.
 */
async function totauxFiltre(
  runId: string,
  f: { fournisseur: string | null; ligne: string | null; statut: string | null
       abc: string | null; xyz: string | null; q: string; saison?: boolean },
  nbLignes: number,
) {
  if (nbLignes === 0 || nbLignes > 25_000) return null

  const COLS = 'valeur_stock, exces_valeur, valeur_morte, valeur_dormante, qte_a_commander, cout_unitaire, ventes_12m_cogs, besoin_saison'
  const t = {
    nb: 0, valeur_stock: 0, exces_valeur: 0, valeur_morte: 0, valeur_dormante: 0,
    qte_a_commander: 0, valeur_a_commander: 0, ventes_12m_cogs: 0,
    besoin_saison: 0, valeur_saison: 0,
  }

  let from = 0
  while (from < nbLignes) {
    let q = supabaseAdmin.from('sc_analyse_pieces').select(COLS).eq('run_id', runId)
    if (f.saison) {
      q = q.gt('besoin_saison', 0).gt('indice_horizon', 1.15)
        .not('statut', 'in', '(rupture,sous_stock,sur_commande,mort,jamais_vendue,dormant)')
    }
    if (f.fournisseur) q = q.eq('fournisseur', f.fournisseur)
    if (f.ligne) q = q.eq('code_ligne', f.ligne)
    if (f.statut) q = q.in('statut', f.statut.split(','))
    if (f.abc) q = q.in('classe_abc', f.abc.split(','))
    if (f.xyz) q = q.in('classe_xyz', f.xyz.split(','))
    if (f.q) {
      const s = f.q.replace(/[,()%\\]/g, ' ').trim()
      if (s) q = q.or(`code_piece.ilike.%${s}%,description.ilike.%${s}%`)
    }

    const { data, error } = await q.range(from, from + 999)
    if (error || !data || data.length === 0) break
    for (const r of data as any[]) {
      t.nb++
      t.valeur_stock += Number(r.valeur_stock) || 0
      t.exces_valeur += Number(r.exces_valeur) || 0
      t.valeur_morte += Number(r.valeur_morte) || 0
      t.valeur_dormante += Number(r.valeur_dormante) || 0
      t.ventes_12m_cogs += Number(r.ventes_12m_cogs) || 0
      const aCmd = Number(r.qte_a_commander) || 0
      t.qte_a_commander += aCmd
      t.valeur_a_commander += aCmd * (Number(r.cout_unitaire) || 0)
      const bs = Number(r.besoin_saison) || 0
      t.besoin_saison += bs
      t.valeur_saison += bs * (Number(r.cout_unitaire) || 0)
    }
    if (data.length < 1000) break
    from += 1000
  }
  return t
}
