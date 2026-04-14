import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste toutes les validations comptables (historique inclus)
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('validations_comptables')
      .select('*')
      .order('date_validation', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — valider comptablement une entrée
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { source, ref_id, code_piece, snapshot, user_email } = body
    if (!source || ref_id === undefined || ref_id === null || !code_piece) {
      return NextResponse.json({ erreur: 'source, ref_id et code_piece requis' }, { status: 400 })
    }
    if (!['negatif', 'commande', 'comptage'].includes(source)) {
      return NextResponse.json({ erreur: 'source invalide' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.from('validations_comptables').upsert({
      source,
      ref_id,
      code_piece,
      snapshot: snapshot || null,
      user_email: user_email || null,
      date_validation: new Date().toISOString()
    }, { onConflict: 'source,ref_id' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// DELETE — annuler une validation (par id, ou par source+ref_id)
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    if (body.id) {
      const { error } = await supabaseAdmin.from('validations_comptables').delete().eq('id', body.id)
      if (error) throw error
    } else if (body.source && body.ref_id !== undefined) {
      const { error } = await supabaseAdmin.from('validations_comptables')
        .delete().eq('source', body.source).eq('ref_id', body.ref_id)
      if (error) throw error
    } else {
      return NextResponse.json({ erreur: 'id ou (source, ref_id) requis' }, { status: 400 })
    }
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
