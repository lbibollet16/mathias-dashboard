import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Multi-mapping SKU Amazon → PKCodes Traction
// Un SKU peut avoir N PKCodes associés. Le stock Traction pour le SKU =
// somme des qty_minus_reserved sur code_ligne='AMA' des PKCodes mappés.

export async function GET(req: NextRequest) {
  try {
    const sku = req.nextUrl.searchParams.get('sku')
    let q = supabaseAdmin.from('amazon_sku_pkcodes').select('id, amazon_sku, pk_code, multiplier, notes, created_at').order('amazon_sku').order('pk_code')
    if (sku) q = q.eq('amazon_sku', sku)
    const { data, error } = await q.limit(5000)
    if (error) throw error

    // Enrichir avec le stock actuel de chaque pk_code (AMA seulement) pour affichage
    const pkCodes = Array.from(new Set((data || []).map((r: any) => r.pk_code)))
    const stockMap = new Map<string, number>()
    if (pkCodes.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, qty_minus_reserved, code_ligne')
        .in('pk_code', pkCodes)
        .eq('code_ligne', 'AMA')
      for (const r of rows || []) {
        stockMap.set(r.pk_code, (stockMap.get(r.pk_code) || 0) + Number(r.qty_minus_reserved || 0))
      }
    }

    const enriched = (data || []).map((r: any) => ({
      ...r,
      current_stock_ama: stockMap.has(r.pk_code) ? stockMap.get(r.pk_code) : null,
    }))

    return NextResponse.json({ mappings: enriched })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { amazon_sku, pk_code, multiplier, notes } = body
    if (!amazon_sku || !pk_code) return NextResponse.json({ erreur: 'amazon_sku et pk_code requis' }, { status: 400 })
    const mult = Number(multiplier)
    const { error } = await supabaseAdmin
      .from('amazon_sku_pkcodes')
      .upsert({
        amazon_sku: amazon_sku.trim(),
        pk_code: pk_code.trim(),
        multiplier: !isNaN(mult) && mult > 0 ? mult : 1,
        notes: notes || null,
      }, { onConflict: 'amazon_sku,pk_code' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// PATCH — update multiplier ou notes
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, multiplier, notes } = body
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const update: any = {}
    if (multiplier !== undefined) {
      const mult = Number(multiplier)
      update.multiplier = !isNaN(mult) && mult > 0 ? mult : 1
    }
    if (notes !== undefined) update.notes = notes || null
    const { error } = await supabaseAdmin.from('amazon_sku_pkcodes').update(update).eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('amazon_sku_pkcodes').delete().eq('id', parseInt(id, 10))
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
