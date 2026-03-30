import { NextRequest, NextResponse } from 'next/server'
import { parseFrNum } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const sku = req.nextUrl.searchParams.get('sku')?.trim()
    if (!sku || sku.length < 2) return NextResponse.json({ found: false })

    // Télécharger Traction
    const res = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error('Traction inaccessible')
    const csv = await res.text()

    const lines = csv.split(/\r?\n/)
    const hdrs = (lines[0] || '').split(';')
    const iP = hdrs.findIndex(h => h.trim().toLowerCase() === 'pkcode')
    const iS = hdrs.findIndex(h => h.trim().toLowerCase() === 'qtyminusreserved')
    const iF = hdrs.findIndex(h => h.trim().toLowerCase() === 'pkfournisseur')
    const iC = hdrs.findIndex(h => h.trim().toLowerCase() === 'prixcoutant')
    const iL = hdrs.findIndex(h => h.trim().toLowerCase() === 'codeligne')
    const iD = hdrs.findIndex(h => h.trim().toLowerCase() === 'descfra')

    // Télécharger fournisseurs pour avoir les noms
    const fournRes = await fetch(process.env.FOURNISSEURS_URL!)
    const fournTSV = await fournRes.text()
    const dictFourn = new Map<string, string>()
    for (const line of fournTSV.split(/\r?\n/).slice(1)) {
      const cols = line.split('\t')
      const idF = cols[0]?.replace(/['"]/g, '').trim()
      const nom = cols[1]?.replace(/['"]/g, '').trim()
      if (idF && nom) dictFourn.set(idF, nom)
    }

    // Normaliser pour comparaison
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '')
    const skuNorm = norm(sku)

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';')
      if (cols.length < 3) continue
      const pk = cols[iP]?.replace(/['"]/g, '').trim()
      if (!pk) continue
      if (norm(pk) === skuNorm) {
        const idF = cols[iF]?.replace(/['"]/g, '').trim()
        return NextResponse.json({
          found: true,
          pk,
          desc: cols[iD]?.replace(/['"]/g, '').trim() || '',
          fournisseur: dictFourn.get(idF) || idF || '',
          stock: parseFrNum(cols[iS]),
          cost: parseFrNum(cols[iC]),
          ligne: cols[iL]?.replace(/['"]/g, '').trim() || '',
        })
      }
    }

    return NextResponse.json({ found: false })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
