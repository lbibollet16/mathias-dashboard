import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ erreur: 'Fichier manquant' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())

    // Parser le fichier Excel avec xlsx
    const XLSX = require('xlsx')
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

    // Mapping: B=1, C=2, D=3, E=4, F=5, G=6, H=7 (index 0-based)
    const paires: any[] = []
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const code = String(row[1] || '').trim()
      if (!code) continue
      paires.push({
        code_piece: code,
        fournisseur: String(row[2] || '').trim() || null,
        description: String(row[3] || '').trim() || null,
        localisation1: String(row[4] || '').trim() || null,
        localisation2: String(row[5] || '').trim() || null,
        localisation3: String(row[6] || '').trim() || null,
        localisation4: String(row[7] || '').trim() || null,
      })
    }

    if (paires.length === 0) {
      return NextResponse.json({ erreur: 'Aucune donnée valide trouvée' }, { status: 400 })
    }

    // Vider la table
    await supabaseAdmin.from('inventaire_localisations').delete().neq('id', 0)

    // Insérer par batch de 500
    let total = 0
    for (let i = 0; i < paires.length; i += 500) {
      const { error } = await supabaseAdmin
        .from('inventaire_localisations')
        .insert(paires.slice(i, i + 500))
      if (error) throw error
      total += Math.min(500, paires.length - i)
    }

    return NextResponse.json({ success: true, total })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
