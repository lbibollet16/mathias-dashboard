import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseScoaPdf } from '@/lib/scoa-parser'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST multipart/form-data — upload d'un PDF SCOA.
// Form fields :
//   file : PDF
//   type : 'ps_neuf' | 'ps_usage' | 'bateau_neuf' | 'bateau_usage'
//
// Dédup : UNIQUE(type, stock_num, num_contrat, date_vente) côté DB.
// Re-import = upsert : on remplace les lignes matchantes.

const TYPES_VALIDES = new Set(['ps_neuf', 'ps_usage', 'bateau_neuf', 'bateau_usage', 'rapport_fni_vendeur'])

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const type = String(form.get('type') || '').trim()

    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })
    if (!TYPES_VALIDES.has(type)) return NextResponse.json({ erreur: `type invalide (attendu : ${[...TYPES_VALIDES].join(', ')})` }, { status: 400 })

    const buf = Buffer.from(await file.arrayBuffer())
    const parsed = await parseScoaPdf(buf)
    if (!parsed.success) return NextResponse.json({ erreur: parsed.erreur }, { status: 500 })
    if (parsed.ventes.length === 0) {
      return NextResponse.json({
        erreur: 'Aucune vente détectée dans le PDF',
        warnings: parsed.warnings,
      }, { status: 400 })
    }

    const rows = parsed.ventes.map(v => ({
      type,
      date_vente: v.date_vente,
      client: v.client,
      stock_num: v.stock_num,
      marque: v.marque,
      modele: v.modele,
      annee: v.annee,
      num_contrat: v.num_contrat,
      vendeur_id: v.vendeur_id,
      vendeur_nom: v.vendeur_nom,
      prix_vente: v.prix_vente,
      profit_vehicule: v.profit_vehicule,
      pct_brut_vehicule: v.pct_brut_vehicule,
      ventes_fni: v.ventes_fni,
      profit_fni: v.profit_fni,
      pct_brut_fni: v.pct_brut_fni,
      ventes_totales: v.ventes_totales,
      profit_net_total: v.profit_net_total,
      pct_profit: v.pct_profit,
      nb_jours: v.nb_jours,
      periode_debut: parsed.periode_debut,
      periode_fin: parsed.periode_fin,
    }))

    // Upsert par clé unique (type, stock_num, num_contrat, date_vente)
    let inserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabaseAdmin
        .from('scoa_ventes')
        .upsert(batch, { onConflict: 'type,stock_num,num_contrat,date_vente' })
      if (error) throw error
      inserted += batch.length
    }

    return NextResponse.json({
      success: true,
      type,
      inserted,
      periode_debut: parsed.periode_debut,
      periode_fin: parsed.periode_fin,
      warnings: parsed.warnings,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
