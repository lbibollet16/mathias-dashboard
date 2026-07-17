import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'
import { parseFacturesPiecesOuvertes } from '@/lib/pieces-parser-ouvertes'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// POST multipart/form-data, champ "file" = liste_peice.xlsx.
// Suivi d'âge des factures pièces ouvertes (comme les bons méca) : une facture
// disparue de l'import est marquée fermée. Le suivi (suivi_*) et le clerk_id
// ne sont pas dans le payload d'upsert → PostgREST les préserve.

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { factures, warnings } = await parseFacturesPiecesOuvertes(buffer)
    const ouvertes = factures.filter(f => f.estOuverte)
    if (ouvertes.length === 0) {
      return NextResponse.json({ erreur: 'Aucune facture ouverte détectée dans ce fichier.', warnings }, { status: 422 })
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('parts_import_batches')
      .insert({ type: 'factures_pieces_ouvertes', filename: file.name, row_count: ouvertes.length, warnings })
      .select().single()
    if (batchErr) throw batchErr

    const ids = Array.from(new Set(ouvertes.map(f => f.clerkId).filter((x): x is string => !!x)))
    if (ids.length) {
      const { data: connus, error: eC } = await supabaseAdmin.from('parts_clerks').select('id').in('id', ids)
      if (eC) throw eC
      const dejaLa = new Set((connus ?? []).map(c => c.id))
      const nouveaux = ids.filter(id => !dejaLa.has(id)).map(id => ({ id, nom: `Commis #${id}` }))
      if (nouveaux.length) {
        const { error } = await supabaseAdmin.from('parts_clerks').insert(nouveaux)
        if (error) throw error
      }
    }

    const now = new Date().toISOString()
    const rows = ouvertes.map(f => ({
      facture_no: f.factureNo,
      clerk_id: f.clerkId,
      client_no: f.clientNo,
      client_nom: f.clientNom,
      total: f.total,
      date_ouverture: f.dateOuverture,
      is_open: true,
      closed_detected_at: null,
      import_batch_id: batch.id,
      updated_at: now,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from('parts_open_invoices').upsert(rows.slice(i, i + 500), { onConflict: 'facture_no' })
      if (error) throw error
    }

    // Fermeture des factures disparues — chargement paginé (plafond PostgREST 1000).
    const stillOpen = await chargerTout<any>('parts_open_invoices', q => q.select('facture_no').eq('is_open', true), 'facture_no')
    const vues = new Set(ouvertes.map(f => f.factureNo))
    const toClose = stillOpen.filter(r => !vues.has(r.facture_no)).map(r => r.facture_no)
    for (let i = 0; i < toClose.length; i += 500) {
      const { error } = await supabaseAdmin
        .from('parts_open_invoices')
        .update({ is_open: false, closed_detected_at: now })
        .in('facture_no', toClose.slice(i, i + 500))
      if (error) throw error
    }

    return NextResponse.json({ success: true, batchId: batch.id, rowsImported: ouvertes.length, facturesClosedSinceLastImport: toClose.length, warnings })
  } catch (e: any) {
    console.error('[pieces/import/ouvertes] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
