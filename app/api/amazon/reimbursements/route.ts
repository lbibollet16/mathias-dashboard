import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// PATCH /api/amazon/reimbursements
//   Body: { reimbursement_id, pk_code, employe, action: 'mark'|'unmark' }
//   Marque un reimbursement comme "ajusté dans LAUTOPAK" (ou annule).
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { reimbursement_id, pk_code, employe, action } = body
    if (!reimbursement_id) return NextResponse.json({ erreur: 'reimbursement_id requis' }, { status: 400 })

    const update: any = action === 'unmark'
      ? { inventaire_ajuste_le: null, inventaire_ajuste_par: null, inventaire_pk_code: null }
      : {
          inventaire_ajuste_le: new Date().toISOString(),
          inventaire_ajuste_par: employe || 'Inconnu',
          inventaire_pk_code: pk_code || null,
        }

    const { error } = await supabaseAdmin
      .from('amazon_reimbursements')
      .update(update)
      .eq('reimbursement_id', reimbursement_id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
