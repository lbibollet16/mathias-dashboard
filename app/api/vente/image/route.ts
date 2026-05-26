import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/vente/image — upload une image pour une promo ou un package.
// Form-data : file (File), kind ('promo'|'package'), nom (optionnel).
// Réutilise le bucket inventaire-photos (déjà public) avec un préfixe.
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const kind = (formData.get('kind') as string) || 'autre'
    const nom = (formData.get('nom') as string) || 'vente'

    if (!file) return NextResponse.json({ erreur: 'Fichier manquant' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const safeNom = nom.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
    const fileName = `vente_${kind}_${safeNom}_${Date.now()}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_')

    let contentType = file.type || 'image/jpeg'
    if (!contentType.startsWith('image/')) contentType = 'image/jpeg'

    const { error } = await supabaseAdmin.storage
      .from('inventaire-photos')
      .upload(fileName, buffer, { contentType, upsert: true })
    if (error) throw error

    const { data: urlData } = supabaseAdmin.storage
      .from('inventaire-photos')
      .getPublicUrl(fileName)

    return NextResponse.json({ success: true, url: urlData.publicUrl })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
