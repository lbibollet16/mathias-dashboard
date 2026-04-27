import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/amazon/unsellable-actions?settlement_id=XXX
export async function GET(req: NextRequest) {
  try {
    const sid = req.nextUrl.searchParams.get('settlement_id')
    let q = supabaseAdmin.from('amazon_unsellable_actions').select('*').order('sku')
    if (sid) q = q.eq('settlement_id', sid)
    const { data, error } = await q.limit(5000)
    if (error) throw error
    return NextResponse.json({ actions: data || [] })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// POST — upsert action pour (settlement_id, sku)
//   - patch normal : action_type, amazon_ref, notes
//   - mark_traite (action: 'traiter')   : marque la ligne comme traitée
//   - mark_traite (action: 'untraiter') : annule le marquage
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { settlement_id, sku, traction_code, action_type, amazon_ref, notes, employe, action } = body
    if (!settlement_id || !sku) return NextResponse.json({ erreur: 'settlement_id + sku requis' }, { status: 400 })

    // Action spéciale : marquer / démarquer comme traité
    if (action === 'traiter' || action === 'untraiter') {
      const { error } = await supabaseAdmin
        .from('amazon_unsellable_actions')
        .update({
          traite_le: action === 'traiter' ? new Date().toISOString() : null,
          traite_par: action === 'traiter' ? (employe || 'Inconnu') : null,
        })
        .eq('settlement_id', settlement_id)
        .eq('sku', sku)
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    // Lire la ligne existante pour faire un vrai merge (sinon l'upsert écrase
    // les champs absents du body avec null).
    const { data: existing } = await supabaseAdmin
      .from('amazon_unsellable_actions')
      .select('*')
      .eq('settlement_id', settlement_id)
      .eq('sku', sku)
      .maybeSingle()

    const merged: any = {
      settlement_id,
      sku,
      traction_code: traction_code !== undefined ? (traction_code || null) : (existing?.traction_code || null),
      action_type: action_type !== undefined ? (action_type || null) : (existing?.action_type || null),
      amazon_ref: amazon_ref !== undefined ? (amazon_ref || null) : (existing?.amazon_ref || null),
      notes: notes !== undefined ? (notes || null) : (existing?.notes || null),
      action_le: existing?.action_le || null,
      action_par: existing?.action_par || null,
      traite_le: existing?.traite_le || null,
      traite_par: existing?.traite_par || null,
    }
    // Mettre à jour action_le/par seulement quand action_type change
    if (action_type !== undefined) {
      if (action_type) {
        merged.action_le = new Date().toISOString()
        merged.action_par = employe || 'Inconnu'
      } else {
        merged.action_le = null
        merged.action_par = null
      }
    }

    const { error } = await supabaseAdmin
      .from('amazon_unsellable_actions')
      .upsert(merged, { onConflict: 'settlement_id,sku' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
