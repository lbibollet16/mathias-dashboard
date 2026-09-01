// Constats des agents supply chain, filtrables par agent / sévérité / fournisseur.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const run = await dernierRun()
    if (!run) return NextResponse.json({ findings: [], total: 0, pret: false })

    const p = req.nextUrl.searchParams
    const agent = p.get('agent')
    const severite = p.get('severite')
    const fournisseur = p.get('fournisseur')
    const limite = Math.min(500, Math.max(10, parseInt(p.get('limite') || '150', 10)))

    let q = supabaseAdmin
      .from('sc_findings').select('*', { count: 'exact' })
      .eq('run_id', run.run_id)

    if (agent) q = q.in('agent', agent.split(','))
    if (severite) q = q.in('severite', severite.split(','))
    if (fournisseur) q = q.eq('fournisseur', fournisseur)

    const { data, error, count } = await q.order('rang', { ascending: true }).limit(limite)
    if (error) throw new Error(error.message)

    return NextResponse.json({ pret: true, findings: data || [], total: count || 0 })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
