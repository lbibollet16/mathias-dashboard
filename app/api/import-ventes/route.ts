import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, parseFrNum } from '@/lib/supabase'
import * as XLSX from 'xlsx'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('data') as File
    const mois = formData.get('mois_annee') as string

    if (!file || !mois) {
      return NextResponse.json({ erreur: 'Fichier et mois requis' }, { status: 400 })
    }

    // Lire le fichier Excel
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows: any[] = XLSX.utils.sheet_to_json(sheet)

    const toInsert = []
    for (const row of rows) {
      const keys = Object.keys(row)
      const keyCode   = keys.find(k => k.trim().toLowerCase() === 'code')
      const keyQte    = keys.find(k => ['qte', 'qty'].includes(k.trim().toLowerCase()))
      const keyRev    = keys.find(k => k.trim().toLowerCase() === 'revenus')
      const keyProfit = keys.find(k => k.trim().toLowerCase() === 'total $')

      if (!keyCode || !row[keyCode]) continue
      const codePiece = String(row[keyCode]).trim()
      if (codePiece.toLowerCase().includes('total')) continue

      const quantite = parseFrNum(keyQte ? row[keyQte] : 0)
      const revenus  = parseFrNum(keyRev ? row[keyRev] : 0)
      const profit   = parseFrNum(keyProfit ? row[keyProfit] : 0)

      if (quantite !== 0 || revenus !== 0) {
        toInsert.push({ code_piece: codePiece, mois, quantite, revenus, profit })
      }
    }

    if (toInsert.length === 0) {
      return NextResponse.json({ erreur: 'Aucune ligne valide dans le fichier' }, { status: 400 })
    }

    const { error } = await supabaseAdmin.from('historique_ventes').insert(toInsert)
    if (error) throw new Error(error.message)

    return NextResponse.json({ success: true, lignes_importees: toInsert.length })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
