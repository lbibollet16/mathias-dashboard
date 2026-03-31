import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function POST(req: NextRequest) {
  try {
    const { email, nom, role } = await req.json()
    if (!email || !nom || !role) return NextResponse.json({ erreur: 'email, nom et role requis' }, { status: 400 })

    // Inviter l'utilisateur via Supabase Auth
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?type=invite`,
      data: { nom, role }
    })
    if (error) throw error

    // Créer le profil
    await supabaseAdmin.from('profils_utilisateurs').upsert({
      id: data.user.id,
      email,
      nom,
      role,
      actif: true
    })

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
