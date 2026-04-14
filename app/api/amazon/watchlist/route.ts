import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste des SKU watchés
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('amazon_sku_watchlist')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — ajouter un SKU à la watchlist
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { amazon_sku, notes } = body
    if (!amazon_sku) return NextResponse.json({ erreur: 'amazon_sku requis' }, { status: 400 })
    const { error } = await supabaseAdmin
      .from('amazon_sku_watchlist')
      .upsert({ amazon_sku, notes: notes || null }, { onConflict: 'amazon_sku' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// DELETE — retirer un SKU de la watchlist
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.amazon_sku) return NextResponse.json({ erreur: 'amazon_sku requis' }, { status: 400 })
    const { error } = await supabaseAdmin
      .from('amazon_sku_watchlist')
      .delete()
      .eq('amazon_sku', body.amazon_sku)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
