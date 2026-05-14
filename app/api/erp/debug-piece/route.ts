import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, parseFrNum } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

// GET /api/erp/debug-piece?pk=0110-6785
// Retourne tout ce qu'on sait sur cette pièce dans la DB + ce que Traction
// live renvoie maintenant. Utile pour diagnostiquer un écart entre le
// dashboard et l'inventaire physique.
export async function GET(req: NextRequest) {
  try {
    const pk = (req.nextUrl.searchParams.get('pk') || '').trim()
    if (!pk) return NextResponse.json({ erreur: 'pk requis' }, { status: 400 })

    // 1) stock_aujourdhui (= ce que le dashboard affiche)
    const { data: stockAuj } = await supabaseAdmin
      .from('stock_aujourdhui')
      .select('*')
      .eq('code_piece', pk)
      .maybeSingle()

    // 2) stock_hier (= dernière sync précédente)
    const { data: stockHier } = await supabaseAdmin
      .from('stock_hier')
      .select('*')
      .eq('code_piece', pk)
      .maybeSingle()

    // 3) memoire_negatifs (= si la pièce est marquée négative)
    const { data: neg } = await supabaseAdmin
      .from('memoire_negatifs')
      .select('*')
      .eq('code_piece', pk)
      .maybeSingle()

    // 4) inventaire_comptages (= comptages faits par les employés)
    const { data: comptages } = await supabaseAdmin
      .from('inventaire_comptages')
      .select('*')
      .eq('code_piece', pk)
      .order('date_comptage', { ascending: false })
      .limit(10)

    // 5) comptabilite_retours (= demandes de correction comptable)
    const { data: retours } = await supabaseAdmin
      .from('comptabilite_retours')
      .select('*')
      .eq('code_piece', pk)
      .order('retourne_le', { ascending: false })
      .limit(10)

    // 6) Ce que Traction LIVE renvoie maintenant
    let tractionLive: any = null
    let tractionError: string | null = null
    try {
      const r = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(30000) })
      if (!r.ok) throw new Error('Traction HTTP ' + r.status)
      const csv = await r.text()
      const lines = csv.split(/\r?\n/)
      const hdrs = (lines[0] || '').split(';')
      const idx = (n: string) => hdrs.findIndex(h => h.trim().toLowerCase() === n.toLowerCase())
      const iP = idx('PKCode'), iS = idx('QTYMINUSRESERVED'), iQ = idx('QTY')
      const iR = idx('QteReserveEnStock'), iC = idx('PrixCoutant'), iD = idx('DescFra')
      for (let i = 1; i < lines.length; i++) {
        const cols = (lines[i] || '').split(';')
        const pkLine = (cols[iP] || '').replace(/['"]/g, '').trim()
        if (pkLine === pk) {
          tractionLive = {
            PKCode: pkLine,
            QTY: parseFrNum(cols[iQ]),
            QTYMINUSRESERVED: parseFrNum(cols[iS]),
            QteReserveEnStock: parseFrNum(cols[iR]),
            PrixCoutant: parseFrNum(cols[iC]),
            DescFra: (cols[iD] || '').replace(/['"]/g, '').trim(),
          }
          break
        }
      }
    } catch (e: any) {
      tractionError = e.message || String(e)
    }

    return NextResponse.json({
      pk,
      dashboard_actuel: stockAuj ? {
        stock_dispo: Number(stockAuj.quantite),
        stock_total: Number(stockAuj.qty_total || stockAuj.quantite),
      } : '(pièce absente de stock_aujourdhui)',
      stock_hier: stockHier ? {
        stock_dispo: Number(stockHier.quantite),
        stock_total: Number(stockHier.qty_total || stockHier.quantite),
      } : '(pièce absente de stock_hier)',
      traction_live: tractionLive || (tractionError ? `Erreur : ${tractionError}` : '(pièce absente du feed Traction live)'),
      memoire_negatifs: neg || '(pas marquée négative)',
      comptages: comptages || [],
      retours_comptables: retours || [],
      diagnostic: {
        dashboard_dit: stockAuj ? Number(stockAuj.quantite) : null,
        traction_live_dit_qty: tractionLive?.QTY ?? null,
        traction_live_dit_dispo: tractionLive?.QTYMINUSRESERVED ?? null,
        en_negatif: !!neg,
        nb_comptages: comptages?.length || 0,
        nb_retours_actifs: (retours || []).filter((r: any) => !r.corrige_le).length,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
