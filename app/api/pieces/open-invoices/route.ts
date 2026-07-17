import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { estStatutValide } from '@/lib/meca-suivi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH { factureNo, suivi: { statut, datePlanifiee, note }, par }
// Suivi que le commis pose sur une facture pièce ouverte (mêmes statuts que
// les bons méca). Même contrat que /api/meca/work-orders pour réutiliser la
// ligne éditable côté client.
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const factureNo = body?.factureNo
    if (!factureNo) return NextResponse.json({ erreur: "Champ 'factureNo' requis." }, { status: 400 })

    const s = body.suivi ?? {}
    if (s.statut != null && s.statut !== '' && !estStatutValide(s.statut)) {
      return NextResponse.json({ erreur: `Statut de suivi inconnu : ${s.statut}` }, { status: 400 })
    }
    const datePlan = s.datePlanifiee && /^\d{4}-\d{2}-\d{2}$/.test(s.datePlanifiee) ? s.datePlanifiee : null
    const par = typeof body.par === 'string' && body.par.trim() ? body.par.trim() : null

    const { data, error } = await supabaseAdmin
      .from('parts_open_invoices')
      .update({
        suivi_statut:         s.statut || null,
        suivi_date_planifiee: datePlan,
        suivi_note:           (typeof s.note === 'string' && s.note.trim()) ? s.note.trim() : null,
        suivi_par:            par,
        suivi_maj_at:         new Date().toISOString(),
      })
      .eq('facture_no', factureNo).select().single()
    if (error) throw error
    return NextResponse.json({ success: true, openInvoice: data })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
