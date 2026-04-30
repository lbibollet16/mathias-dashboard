import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { createAuditSnapshot } from '@/lib/amazon-audit-create'

// GET — liste tous les audits
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('amazon_audits')
      .select('*')
      .order('started_at', { ascending: false })
    if (error) throw error

    // Enrichir chaque audit avec un résumé : nb_comptés / total
    const audits = data || []
    for (const a of audits as any[]) {
      const { data: counts } = await supabaseAdmin
        .from('amazon_audit_counts')
        .select('id, hub_compte, fbm_compte, sans_prefix_compte')
        .eq('audit_id', a.id)
      const total = (counts || []).length
      const countesHub = (counts || []).filter(c => c.hub_compte != null).length
      a.nb_total = total
      a.nb_comptes = countesHub
    }

    return NextResponse.json(audits)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer un nouvel audit, avec snapshot initial de tous les base products
//        qui ont du stock HUB, FBM ou sans préfixe (stock à compter physiquement)
// audit_type: 'mensuel_ama' (default) | 'settlement_fbm'
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { mois, label, started_by, settlement_id, audit_type } = body
    if (!mois) return NextResponse.json({ erreur: 'mois requis (YYYY-MM)' }, { status: 400 })
    const r = await createAuditSnapshot({
      mois, label, started_by,
      settlement_id: settlement_id || null,
      audit_type: audit_type || 'mensuel_ama',
    })
    if (!r.success) return NextResponse.json({ erreur: r.erreur }, { status: 500 })
    return NextResponse.json(r)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE — supprimer un audit (et ses counts via cascade)
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('amazon_audits').delete().eq('id', body.id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
