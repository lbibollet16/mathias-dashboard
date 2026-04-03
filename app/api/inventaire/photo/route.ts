import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const code_piece = formData.get('code_piece') as string
    const localisation = formData.get('localisation') as string

    if (!file) return NextResponse.json({ erreur: 'Fichier manquant' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const fileName = `${localisation}_${code_piece}_${Date.now()}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_')

    // Forcer le content type en image/jpeg si non reconnu (HEIC, etc.)
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
