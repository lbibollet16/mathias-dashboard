// Réception du catalogue enrichi poussé par mathias-power-parts.
//
// Traction ne porte ni marque, ni catégorie. Le projet power-parts tient déjà
// un catalogue de 280 000 SKU issus des flux fournisseurs, avec une taxonomie
// de 1 858 catégories et 657 marques. Cet endpoint reçoit l'intersection des
// deux mondes, clé par PKCode.
//
// C'est power-parts qui pousse, comme il le fait déjà vers /api/amazon/import :
// aucune clé de la base pièces n'a à vivre ici.
//
//   POST { phase: 'debut' }                        → ouvre un import
//   POST { phase: 'categories', categories: [...] } → la taxonomie
//   POST { phase: 'lignes', lignes: [...] }         → un lot d'enrichissements
//   POST { phase: 'fin', couverture: {...} }        → clôt et purge le périmé
//   GET                                             → état et couverture

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { lireTout } from '@/lib/supply-chain-db'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Secret partagé, optionnel.
 *
 * Tant que CATALOGUE_IMPORT_SECRET n'est pas défini côté dashboard, l'endpoint
 * reste ouvert — c'est la convention de /api/amazon/import, et l'imposer d'un
 * coup casserait le pousseur avant qu'il soit configuré. Dès que la variable
 * existe, l'en-tête devient obligatoire. Poser la variable des deux côtés
 * verrouille l'endpoint sans changer une ligne de code.
 */
function autorise(req: NextRequest): boolean {
  const attendu = process.env.CATALOGUE_IMPORT_SECRET
  if (!attendu) return true
  const recu = req.headers.get('x-catalogue-secret') || ''
  return recu === attendu
}

export async function POST(req: NextRequest) {
  if (!autorise(req)) {
    return NextResponse.json({ erreur: 'Secret invalide' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const phase = String(body.phase || '')

    // ── Ouverture ────────────────────────────────────────────────────
    if (phase === 'debut') {
      const { data, error } = await supabaseAdmin
        .from('sc_catalogue_imports')
        .insert({ source: body.source || 'power-parts', statut: 'en_cours' })
        .select('id').single()
      if (error) throw new Error(error.message)
      return NextResponse.json({ success: true, import_id: data.id })
    }

    const importId = Number(body.import_id) || null

    // ── La taxonomie ─────────────────────────────────────────────────
    if (phase === 'categories') {
      const cats = Array.isArray(body.categories) ? body.categories : []
      const rows = cats.map((c: any) => ({
        id: c.id,
        slug: c.slug ?? null,
        nom_fr: c.nom_fr ?? null,
        nom_en: c.nom_en ?? null,
        univers: c.univers ?? null,
        parent_id: c.parent_id ?? null,
        chemin: c.chemin ?? null,
        profondeur: Number(c.profondeur) || 0,
        maj_le: new Date().toISOString(),
      }))
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseAdmin
          .from('sc_categories_externes')
          .upsert(rows.slice(i, i + 500), { onConflict: 'id' })
        if (error) throw new Error(`categories : ${error.message}`)
      }
      if (importId) {
        await supabaseAdmin.from('sc_catalogue_imports')
          .update({ nb_categories: rows.length }).eq('id', importId)
      }
      return NextResponse.json({ success: true, categories: rows.length })
    }

    // ── Un lot d'enrichissements ─────────────────────────────────────
    if (phase === 'lignes') {
      const lignes = Array.isArray(body.lignes) ? body.lignes : []
      const maintenant = new Date().toISOString()
      const rows = lignes.map((l: any) => ({
        code_piece: String(l.code_piece).trim(),
        sku_externe: String(l.sku_externe ?? '').trim(),
        appariement: ['sku', 'normalise', 'gtin'].includes(l.appariement) ? l.appariement : 'sku',
        marque: l.marque ?? null,
        marque_slug: l.marque_slug ?? null,
        categorie_id: l.categorie_id ?? null,
        categorie_nom: l.categorie_nom ?? null,
        categorie_univers: l.categorie_univers ?? null,
        categorie_chemin: l.categorie_chemin ?? null,
        cout_fournisseur: nOuNull(l.cout_fournisseur),
        prix_detail: nOuNull(l.prix_detail),
        msrp: nOuNull(l.msrp),
        map_price: nOuNull(l.map_price),
        stock_fournisseur: nOuNull(l.stock_fournisseur),
        stock_fournisseur_maj: l.stock_fournisseur_maj ?? null,
        popularite: nOuNull(l.popularite),
        discontinue: !!l.discontinue,
        saison: l.saison ?? null,
        compatible_hiver: l.compatible_hiver === null || l.compatible_hiver === undefined
          ? null : !!l.compatible_hiver,
        maj_le: maintenant,
      })).filter((r: any) => r.code_piece && r.sku_externe)

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseAdmin
          .from('sc_catalogue_externe')
          .upsert(rows.slice(i, i + 500), { onConflict: 'code_piece' })
        if (error) throw new Error(`lignes : ${error.message}`)
      }
      return NextResponse.json({ success: true, lignes: rows.length })
    }

    // ── Clôture ──────────────────────────────────────────────────────
    if (phase === 'fin') {
      // Purge de ce que cet import n'a pas revu : une pièce disparue du
      // catalogue fournisseur ne doit pas garder éternellement une marque et
      // une catégorie qui ne sont plus vraies. On se cale sur l'horodatage de
      // l'import plutôt que sur une liste d'ids, qui ferait un payload énorme.
      const depuis = body.debut_le
      let purges = 0
      if (depuis) {
        const { data } = await supabaseAdmin
          .from('sc_catalogue_externe').delete().lt('maj_le', depuis).select('code_piece')
        purges = data?.length ?? 0
      }

      if (importId) {
        const { count } = await supabaseAdmin
          .from('sc_catalogue_externe').select('*', { count: 'exact', head: true })
        await supabaseAdmin.from('sc_catalogue_imports').update({
          statut: 'termine',
          termine_le: new Date().toISOString(),
          nb_lignes: count ?? 0,
          nb_lots: Number(body.nb_lots) || 0,
          couverture: body.couverture ?? {},
        }).eq('id', importId)
      }
      return NextResponse.json({ success: true, purges })
    }

    return NextResponse.json({ erreur: `phase inconnue : ${phase}` }, { status: 400 })

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

const nOuNull = (v: any) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** État de l'enrichissement : ce qu'on a, et ce que ça couvre. */
export async function GET() {
  try {
    const [lignes, cats, imports] = await Promise.all([
      supabaseAdmin.from('sc_catalogue_externe').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('sc_categories_externes').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('sc_catalogue_imports').select('*').order('demarre_le', { ascending: false }).limit(5),
    ])

    // Répartition par univers, sur les pièces réellement en stock : c'est la
    // seule mesure de couverture qui veut dire quelque chose.
    const enrichi = await lireTout<any>('sc_catalogue_externe',
      'code_piece, categorie_univers, categorie_chemin, marque, discontinue, stock_fournisseur')

    const parUnivers = new Map<string, number>()
    const parMarque = new Map<string, number>()
    let sansCategorie = 0, discontinues = 0, avecDispo = 0
    for (const r of enrichi) {
      const u = r.categorie_univers || '(sans univers)'
      parUnivers.set(u, (parUnivers.get(u) || 0) + 1)
      if (r.marque) parMarque.set(r.marque, (parMarque.get(r.marque) || 0) + 1)
      if (!r.categorie_chemin) sansCategorie++
      if (r.discontinue) discontinues++
      if (Number(r.stock_fournisseur) > 0) avecDispo++
    }

    return NextResponse.json({
      nb_lignes: lignes.count ?? 0,
      nb_categories: cats.count ?? 0,
      sans_categorie: sansCategorie,
      discontinues,
      avec_dispo_fournisseur: avecDispo,
      par_univers: [...parUnivers.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ univers: k, nb: v })),
      top_marques: [...parMarque.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => ({ marque: k, nb: v })),
      imports: imports.data ?? [],
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
