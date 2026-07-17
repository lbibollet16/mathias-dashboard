import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseEstimeRapportVente } from '@/lib/pieces-parser-estimes'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// POST multipart/form-data, champ "file" = estimé_rapport_vente.xlsx.
// Apparie chaque estimé à sa facture réelle si converti.

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { estimes, warnings } = await parseEstimeRapportVente(buffer)
    if (estimes.length === 0) {
      return NextResponse.json({ erreur: 'Aucun estimé détecté dans ce fichier.', warnings }, { status: 422 })
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('parts_import_batches')
      .insert({ type: 'estime_rapport_vente', filename: file.name, row_count: estimes.length, warnings })
      .select().single()
    if (batchErr) throw batchErr

    const rows = estimes.map(e => ({
      estimate_no: e.estimateNo,
      date_estime: e.dateEstime,
      client_no: e.clientNo,
      client_nom: e.clientNom,
      montant_estime: e.montantEstime,
      facture_reelle_no: e.factureReelleNo,
      date_facture_reelle: e.dateFactureReelle,
      montant_facture_reel: e.montantFactureReel,
      converti: e.converti,
      import_batch_id: batch.id,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from('parts_estimates').upsert(rows.slice(i, i + 500), { onConflict: 'estimate_no' })
      if (error) throw error
    }

    return NextResponse.json({
      success: true, batchId: batch.id, rowsImported: estimes.length,
      convertis: estimes.filter(e => e.converti).length, warnings,
    })
  } catch (e: any) {
    console.error('[pieces/import/estimes] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
