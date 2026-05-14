import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { invaliderCacheFni } from '@/lib/scoa-fni-overrides'
import * as XLSX from 'xlsx'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

// POST multipart/form-data — upload d'un fichier Excel mappant #Stock → FNI vendor.
//
// Format attendu :
//   Colonne A : Nom du spécialiste FNI (ex: « Hamel, Joly-Ann »)
//   Colonne B : #Stock (ex: « 26-0419 »)
//   (1ère ligne = en-têtes, on saute)
//
// Comportement : upsert par stock_num (= un même stock peut avoir son
// FNI changé en ré-important une nouvelle version du fichier).
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buf = Buffer.from(await file.arrayBuffer())
    const wb = XLSX.read(buf, { type: 'buffer' })
    if (!wb.SheetNames.length) {
      return NextResponse.json({ erreur: 'Fichier Excel vide' }, { status: 400 })
    }

    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

    // Détection en-tête : on cherche FNI/Stock sur la 1re ligne
    let headerIdx = 0
    let fniCol = 0
    let stockCol = 1
    if (rows.length > 0) {
      const r0 = rows[0].map((c: any) => String(c || '').toLowerCase().trim())
      const ifni = r0.findIndex((c: string) => /fni|vendeur|specialist/.test(c))
      const istock = r0.findIndex((c: string) => /stock|#/.test(c))
      if (ifni >= 0 && istock >= 0) {
        fniCol = ifni
        stockCol = istock
      }
    }

    const assignments: { stock_num: string, fni_vendeur_nom: string, source: string, updated_at: string }[] = []
    const errors: string[] = []
    const now = new Date().toISOString()

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const fni = String(rows[i][fniCol] || '').trim()
      const stock = String(rows[i][stockCol] || '').trim()
      if (!fni && !stock) continue  // ligne vide
      if (!fni || !stock) {
        errors.push(`Ligne ${i + 1} : valeur manquante (FNI="${fni}", Stock="${stock}")`)
        continue
      }
      assignments.push({
        stock_num: stock,
        fni_vendeur_nom: fni,
        source: 'excel_import',
        updated_at: now,
      })
    }

    if (assignments.length === 0) {
      return NextResponse.json({
        erreur: 'Aucune attribution valide trouvée dans le fichier',
        errors,
      }, { status: 400 })
    }

    // Upsert par batch
    let upserted = 0
    for (let i = 0; i < assignments.length; i += 500) {
      const batch = assignments.slice(i, i + 500)
      const { error } = await supabaseAdmin
        .from('scoa_fni_assignments')
        .upsert(batch, { onConflict: 'stock_num' })
      if (error) throw error
      upserted += batch.length
    }

    // Vider le cache pour que le dashboard reflète les nouvelles attributions immédiatement
    invaliderCacheFni()

    return NextResponse.json({
      success: true,
      upserted,
      total: assignments.length,
      errors,
    })
  } catch (e: any) {
    console.error('[fni-assignments/import]', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
