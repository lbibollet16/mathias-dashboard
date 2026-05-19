import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste toutes les vérifications doubles (= les validations admin déjà
// effectuées). Permet à la Comptabilité de savoir quels items ont passé le
// contrôle, et à l'onglet Vérification de connaître ce qui reste à faire.
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('verifications_doubles')
      .select('*')
      .order('valide_le', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer une validation admin pour un item (ou plusieurs ids quand c'est
// agrégé multi-loc). Body: { source, ref_ids: number[], code_piece, ecart,
// snapshot, valide_par, commentaire? }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { source, ref_ids, code_piece, ecart, snapshot, valide_par, commentaire } = body
    if (!source || !Array.isArray(ref_ids) || ref_ids.length === 0 || !code_piece || !valide_par) {
      return NextResponse.json({ erreur: 'Champs requis manquants' }, { status: 400 })
    }
    const rows = ref_ids.map((rid: number) => ({
      source, ref_id: rid, code_piece,
      ecart: Number(ecart || 0),
      snapshot: snapshot || null,
      valide_par,
      commentaire: commentaire || null,
    }))
    const { data, error } = await supabaseAdmin
      .from('verifications_doubles')
      .upsert(rows, { onConflict: 'source,ref_id' })
      .select()
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// DELETE — annuler une validation admin (par id de la ligne).
// Body: { id } OU { source, ref_id }
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, source, ref_id } = body
    if (id) {
      const { error } = await supabaseAdmin.from('verifications_doubles').delete().eq('id', id)
      if (error) throw error
    } else if (source && ref_id) {
      const { error } = await supabaseAdmin.from('verifications_doubles')
        .delete().eq('source', source).eq('ref_id', ref_id)
      if (error) throw error
    } else {
      return NextResponse.json({ erreur: 'id ou (source,ref_id) requis' }, { status: 400 })
    }
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
