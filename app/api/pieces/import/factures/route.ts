import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseListeFacturesPieces } from '@/lib/pieces-parser-factures'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// POST multipart/form-data, champ "file" = Liste_des_factures_de_pièces.xlsx.
// Une ligne par facture (avec l'employé). Sert aussi de clé de jointure avec
// les estimés (facture_no = estimate_no).

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { factures, warnings } = await parseListeFacturesPieces(buffer)
    if (factures.length === 0) {
      return NextResponse.json({ erreur: 'Aucune facture détectée dans ce fichier.', warnings }, { status: 422 })
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('parts_import_batches')
      .insert({ type: 'liste_factures_pieces', filename: file.name, row_count: factures.length, warnings })
      .select().single()
    if (batchErr) throw batchErr

    const clerks = new Map<string, string>()
    for (const f of factures) if (f.clerkId && !clerks.has(f.clerkId)) clerks.set(f.clerkId, f.clerkNom || `Commis #${f.clerkId}`)
    const ids = [...clerks.keys()]
    if (ids.length) {
      const { data: connus, error: eC } = await supabaseAdmin.from('parts_clerks').select('id').in('id', ids)
      if (eC) throw eC
      const dejaLa = new Set((connus ?? []).map(c => c.id))
      const nouveaux = ids.filter(id => !dejaLa.has(id)).map(id => ({ id, nom: clerks.get(id)! }))
      if (nouveaux.length) {
        const { error } = await supabaseAdmin.from('parts_clerks').insert(nouveaux)
        if (error) throw error
      }
    }

    const now = new Date().toISOString()
    const rows = factures.map(f => ({
      facture_no: f.factureNo,
      clerk_id: f.clerkId,
      client_no: f.clientNo,
      client_nom: f.clientNom,
      total_pieces: f.totalPieces,
      date_ouverture: f.dateOuverture,
      import_batch_id: batch.id,
      updated_at: now,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from('parts_invoices').upsert(rows.slice(i, i + 500), { onConflict: 'facture_no' })
      if (error) throw error
    }

    return NextResponse.json({ success: true, batchId: batch.id, rowsImported: factures.length, warnings })
  } catch (e: any) {
    console.error('[pieces/import/factures] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
