import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste TOUS les paliers (ou ceux d'une marque si ?marque_id=)
export async function GET(req: NextRequest) {
  try {
    const marqueId = req.nextUrl.searchParams.get('marque_id')
    let q = supabaseAdmin.from('vente_paliers_rabais').select('*').order('montant_min', { ascending: true })
    if (marqueId) q = q.eq('marque_id', Number(marqueId))
    const { data, error } = await q
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { marque_id, montant_min, montant_max, rabais_montant } = await req.json()
    if (!marque_id || montant_min === undefined || montant_max === undefined || rabais_montant === undefined) {
      return NextResponse.json({ erreur: 'Champs requis manquants' }, { status: 400 })
    }
    if (Number(montant_max) <= Number(montant_min)) {
      return NextResponse.json({ erreur: 'montant_max doit être > montant_min' }, { status: 400 })
    }
    const { data, error } = await supabaseAdmin
      .from('vente_paliers_rabais')
      .insert({
        marque_id: Number(marque_id),
        montant_min: Number(montant_min),
        montant_max: Number(montant_max),
        rabais_montant: Number(rabais_montant),
      })
      .select().single()
    if (error) throw error
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, montant_min, montant_max, rabais_montant } = await req.json()
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const update: any = {}
    if (montant_min !== undefined) update.montant_min = Number(montant_min)
    if (montant_max !== undefined) update.montant_max = Number(montant_max)
    if (rabais_montant !== undefined) update.rabais_montant = Number(rabais_montant)
    const { data, error } = await supabaseAdmin
      .from('vente_paliers_rabais').update(update).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('vente_paliers_rabais').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
