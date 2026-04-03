import { NextRequest, NextResponse } from 'next/server'
import { parseFrNum } from '@/lib/supabase'

async function fetchStock(codesStr: string) {
  const codes = codesStr.split(',').map(c => c.trim().toLowerCase())

  const res = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error('Traction inaccessible')
  const csv = await res.text()
  const lines = csv.split(/\r?\n/)
  const hdrs = (lines[0] || '').split(';')
  const iP = hdrs.findIndex(h => h.trim().toLowerCase() === 'pkcode')
  const iS = hdrs.findIndex(h => h.trim().toLowerCase() === 'qtyminusreserved')
  const iR = hdrs.findIndex(h => h.trim().toLowerCase() === 'qtereserveenstock')

  const results: any[] = []
  const codesSet = new Set(codes)

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';')
    const pk = cols[iP]?.replace(/['"]/g, '').trim()
    if (!pk || !codesSet.has(pk.toLowerCase())) continue
    results.push({
      code_piece: pk,
      stock: parseFrNum(cols[iS]),
      reserve: parseFrNum(cols[iR]),
    })
  }

  return NextResponse.json(results)
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const codesParam = body.codes
    if (!codesParam) return NextResponse.json([])
    return fetchStock(codesParam)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const codesParam = req.nextUrl.searchParams.get('codes')
    if (!codesParam) return NextResponse.json([])
    return fetchStock(codesParam)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
