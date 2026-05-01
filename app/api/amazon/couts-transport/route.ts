import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/amazon/couts-transport
// Liste tous les coûts de transport par pk_code.
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('amazon_couts_transport')
      .select('*')
      .order('pk_code', { ascending: true })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// POST — crée ou met à jour un coût de transport pour un pk_code
// Body: { pk_code, cout_unitaire, type_canal?, notes?, updated_by? }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pk_code, cout_unitaire, type_canal, notes, updated_by } = body
    if (!pk_code) return NextResponse.json({ erreur: 'pk_code requis' }, { status: 400 })
    const cout = Number(cout_unitaire)
    if (isNaN(cout) || cout < 0) return NextResponse.json({ erreur: 'cout_unitaire invalide' }, { status: 400 })
    const row = {
      pk_code,
      cout_unitaire: cout,
      type_canal: type_canal || null,
      notes: notes || null,
      updated_at: new Date().toISOString(),
      updated_by: updated_by || null,
    }
    const { error } = await supabaseAdmin
      .from('amazon_couts_transport')
      .upsert(row, { onConflict: 'pk_code' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE ?pk_code=XXX
export async function DELETE(req: NextRequest) {
  try {
    const pk_code = req.nextUrl.searchParams.get('pk_code')
    if (!pk_code) return NextResponse.json({ erreur: 'pk_code requis' }, { status: 400 })
    const { error } = await supabaseAdmin
      .from('amazon_couts_transport')
      .delete()
      .eq('pk_code', pk_code)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
