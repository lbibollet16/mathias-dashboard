import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('vente_marques')
      .select('*')
      .order('nom', { ascending: true })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { nom, sous_categories } = await req.json()
    if (!nom || !nom.trim()) return NextResponse.json({ erreur: 'nom requis' }, { status: 400 })
    const { data, error } = await supabaseAdmin
      .from('vente_marques')
      .insert({ nom: nom.trim(), sous_categories: Array.isArray(sous_categories) ? sous_categories : [] })
      .select().single()
    if (error) throw error
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, nom, actif, sous_categories } = await req.json()
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const update: any = {}
    if (nom !== undefined) update.nom = nom
    if (actif !== undefined) update.actif = actif
    if (sous_categories !== undefined) update.sous_categories = Array.isArray(sous_categories) ? sous_categories : []
    const { data, error } = await supabaseAdmin
      .from('vente_marques').update(update).eq('id', id).select().single()
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
    const { error } = await supabaseAdmin.from('vente_marques').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
