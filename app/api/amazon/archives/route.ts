import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste des pk_codes archivés (disparus du feed Traction).
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('traction_sku_archive')
      .select('*')
      .order('first_disappeared_at', { ascending: false })
      .limit(1000)
    if (error) throw error
    return NextResponse.json({ archives: data || [] })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE ?pk_code=XXX — supprimer définitivement une entrée d'archive
export async function DELETE(req: NextRequest) {
  try {
    const pk = req.nextUrl.searchParams.get('pk_code')
    if (!pk) return NextResponse.json({ erreur: 'pk_code requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('traction_sku_archive').delete().eq('pk_code', pk)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
