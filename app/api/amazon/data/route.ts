import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — résumé global pour l'UI Amazon (phase 1: fondations)
export async function GET() {
  try {
    const [settlements, txCount, fbaCount, rbCount, unresolvedTx, mappingsCount, tractionCount] = await Promise.all([
      supabaseAdmin.from('amazon_settlements').select('*').order('deposit_date', { ascending: false }),
      supabaseAdmin.from('amazon_transactions').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('amazon_fba_inventory').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('amazon_reimbursements').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('amazon_transactions').select('id', { count: 'exact', head: true }).is('traction_code', null),
      supabaseAdmin.from('amazon_sku_mapping').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('traction_amazon_lignes').select('id', { count: 'exact', head: true }),
    ])

    return NextResponse.json({
      settlements: settlements.data || [],
      counts: {
        transactions: txCount.count || 0,
        fba_inventory: fbaCount.count || 0,
        reimbursements: rbCount.count || 0,
        unresolved_transactions: unresolvedTx.count || 0,
        mappings: mappingsCount.count || 0,
        traction_amazon_lignes: tractionCount.count || 0,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
