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
    const ext = file.name.split('.').pop() || 'jpg'
    const fileName = `${localisation}_${code_piece}_${Date.now()}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_')

    const { data, error } = await supabaseAdmin.storage
      .from('inventaire-photos')
      .upload(fileName, buffer, {
        contentType: file.type || 'image/jpeg',
        upsert: true
      })

    if (error) throw error

    // Essayer l'URL publique d'abord
    const { data: urlData } = supabaseAdmin.storage
      .from('inventaire-photos')
      .getPublicUrl(fileName)

    // Vérifier si l'URL publique fonctionne, sinon utiliser une signed URL (1 an)
    try {
      const testRes = await fetch(urlData.publicUrl, { method: 'HEAD' })
      if (testRes.ok) {
        return NextResponse.json({ success: true, url: urlData.publicUrl })
      }
    } catch {}

    // Bucket non-public : générer une signed URL longue durée
    const { data: signedData, error: signedError } = await supabaseAdmin.storage
      .from('inventaire-photos')
      .createSignedUrl(fileName, 60 * 60 * 24 * 365) // 1 an

    if (signedError || !signedData?.signedUrl) {
      return NextResponse.json({ success: true, url: urlData.publicUrl })
    }

    return NextResponse.json({ success: true, url: signedData.signedUrl })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
