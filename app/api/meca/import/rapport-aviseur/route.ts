import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseRapportAviseur } from '@/lib/meca-parser-rapport-aviseur'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST multipart/form-data, champ "file" = l'export Excel (.xlsx) du
// "Rapport des Aviseurs Technique - Détaillée".
// Voir lib/meca-parser-rapport-aviseur.ts pour le détail du parsing.

function normalizeNom(nom: string): string {
  return nom.toLowerCase().trim().replace(/\s+/g, ' ')
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: "Fichier requis" }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { rows, warnings } = await parseRapportAviseur(buffer)

    if (rows.length === 0) {
      return NextResponse.json(
        { erreur: 'Aucune ligne de performance détectée dans ce fichier.', warnings },
        { status: 422 }
      )
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('meca_import_batches')
      .insert({ type: 'rapport_aviseur', filename: file.name, row_count: rows.length, warnings: [...warnings] })
      .select()
      .single()
    if (batchErr) throw batchErr

    // Ce fichier donne le NOM de l'aviseur, pas son numéro : on rattache par
    // nom aux aviseurs déjà connus (créés par l'import des bons de travail).
    const { data: knownAdvisors, error: errAdv } = await supabaseAdmin.from('meca_advisors').select('id, nom')
    if (errAdv) throw errAdv
    const byNom = new Map((knownAdvisors ?? []).map(a => [normalizeNom(a.nom), a.id]))

    const unmatchedNames = new Set<string>()
    const toInsert = rows.map(r => {
      const advisorId = byNom.get(normalizeNom(r.advisor_nom)) ?? null
      if (!advisorId) unmatchedNames.add(r.advisor_nom)
      return {
        import_batch_id: batch.id,
        advisor_id: advisorId,
        advisor_nom: r.advisor_nom,
        row_label: r.row_label,
        periode_type: r.periode_type,
        valeurs: r.valeurs,
      }
    })

    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabaseAdmin.from('meca_advisor_performance').insert(toInsert.slice(i, i + 500))
      if (error) throw error
    }

    if (unmatchedNames.size > 0) {
      const extraWarnings = Array.from(unmatchedNames).map(
        n => `Aucun aviseur trouvé pour "${n}" — importe la liste des bons de travail d'abord (elle crée les aviseurs), ou vérifie l'orthographe.`
      )
      await supabaseAdmin
        .from('meca_import_batches')
        .update({ warnings: [...warnings, ...extraWarnings] })
        .eq('id', batch.id)
    }

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      rowsImported: toInsert.length,
      unmatchedAdvisorNames: Array.from(unmatchedNames),
      warnings,
    })
  } catch (e: any) {
    console.error('[meca/import/rapport-aviseur] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) || 'Erreur inconnue' }, { status: 500 })
  }
}
