import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST — toggle (insert ou delete) une ligne facturée pour un settlement+sku
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { settlement_id, sku, employe, action } = body
    if (!settlement_id || !sku) return NextResponse.json({ erreur: 'settlement_id + sku requis' }, { status: 400 })

    if (action === 'uncheck') {
      const { error } = await supabaseAdmin
        .from('amazon_lautopak_lines_facturees')
        .delete()
        .eq('settlement_id', settlement_id)
        .eq('sku', sku)
      if (error) throw error
    } else {
      const { error } = await supabaseAdmin
        .from('amazon_lautopak_lines_facturees')
        .upsert({
          settlement_id, sku,
          facturee_le: new Date().toISOString(),
          facturee_par: employe || 'Inconnu',
        }, { onConflict: 'settlement_id,sku' })
      if (error) throw error
    }
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
