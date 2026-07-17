import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseRapportVentePiece } from '@/lib/pieces-parser-vente'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// POST multipart/form-data, champ "file" = rapport_vente_piece.xlsx.
// Crée les commis, remplit ventes/coût/profit/marge par client, et pose le
// flag de marge (< 25 %) avec justificatif obligatoire au-dessus de 500 $.

const SEUIL_MARGE_PCT = 25
const SEUIL_MONTANT_JUSTIFICATIF_OBLIGATOIRE = 500

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { ventes, warnings } = await parseRapportVentePiece(buffer)
    if (ventes.length === 0) {
      return NextResponse.json({ erreur: 'Aucune vente détectée dans ce fichier.', warnings }, { status: 422 })
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('parts_import_batches')
      .insert({ type: 'rapport_vente_piece', filename: file.name, row_count: ventes.length, warnings })
      .select().single()
    if (batchErr) throw batchErr

    // Commis : créer les inconnus sans écraser un nom déjà réglé (chargement groupé).
    const clerks = new Map<string, string>()
    for (const v of ventes) if (!clerks.has(v.clerkId)) clerks.set(v.clerkId, v.clerkNom || `Commis #${v.clerkId}`)
    const ids = [...clerks.keys()]
    const { data: connus, error: eC } = await supabaseAdmin.from('parts_clerks').select('id').in('id', ids)
    if (eC) throw eC
    const dejaLa = new Set((connus ?? []).map(c => c.id))
    const nouveaux = ids.filter(id => !dejaLa.has(id)).map(id => ({ id, nom: clerks.get(id)! }))
    if (nouveaux.length) {
      const { error } = await supabaseAdmin.from('parts_clerks').insert(nouveaux)
      if (error) throw error
    }

    // Une ligne par client (on écarte les lignes « Total Commis »).
    const lignesClient = ventes.filter(v => !v.estTotalCommis)
    let ventesSousLeSeuil = 0
    const rows = lignesClient.map(v => {
      const margeSousSeuil = v.profitPct !== null && v.profitPct < SEUIL_MARGE_PCT
      if (margeSousSeuil) ventesSousLeSeuil++
      return {
        import_batch_id: batch.id,
        clerk_id: v.clerkId,
        client_no: v.clientNo,
        client_nom: v.clientNom,
        ventes: v.ventes,
        cout: v.cout,
        profit: v.profit,
        profit_pct: v.profitPct,
        nb_factures: v.nbFactures,
        moyenne_facture: v.moyenneFacture,
        commission: v.commission,
        marge_sous_seuil: margeSousSeuil,
        justificatif_requis: margeSousSeuil && v.ventes >= SEUIL_MONTANT_JUSTIFICATIF_OBLIGATOIRE,
      }
    })
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from('parts_sales').insert(rows.slice(i, i + 500))
      if (error) throw error
    }

    return NextResponse.json({ success: true, batchId: batch.id, rowsImported: lignesClient.length, ventesSousLeSeuil, warnings })
  } catch (e: any) {
    console.error('[pieces/import/rapport-vente] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
