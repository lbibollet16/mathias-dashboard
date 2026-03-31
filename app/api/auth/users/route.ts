import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// GET — liste tous les utilisateurs
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('profils_utilisateurs')
      .select('*')
      .order('cree_le', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH — modifier rôle ou statut
export async function PATCH(req: NextRequest) {
  try {
    const { id, role, actif, nom } = await req.json()
    const updates: any = {}
    if (role !== undefined) updates.role = role
    if (actif !== undefined) updates.actif = actif
    if (nom !== undefined) updates.nom = nom

    const { error } = await supabaseAdmin
      .from('profils_utilisateurs')
      .update(updates)
      .eq('id', id)
    if (error) throw error

    // Si désactivé, déconnecter l'utilisateur
    if (actif === false) {
      await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: '876600h' })
    } else if (actif === true) {
      await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: 'none' })
    }

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// DELETE — supprimer un utilisateur
export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    await supabaseAdmin.auth.admin.deleteUser(id)
    await supabaseAdmin.from('profils_utilisateurs').delete().eq('id', id)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
