import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — catalogue + demandes en attente
export async function GET() {
  try {
    const [catRes, demRes] = await Promise.all([
      supabaseAdmin.from('fournitures_catalogue').select('*').eq('actif', true).order('categorie').order('description'),
      supabaseAdmin.from('demandes_fournitures').select('*').order('date_demande', { ascending: false }).limit(500)
    ])
    return NextResponse.json({
      catalogue: catRes.data || [],
      demandes: demRes.data || []
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer une demande
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { employe, sku, description, fournisseur, categorie, quantite, unite, note, url } = body
    if (!employe || !description) return NextResponse.json({ erreur: 'employe et description requis' }, { status: 400 })
    // Combiner note + url dans le champ note (format: note|||url)
    let noteFinale = note || ''
    if (url) noteFinale = noteFinale ? noteFinale + '|||' + url : '|||' + url
    const { error } = await supabaseAdmin.from('demandes_fournitures').insert({
      employe, sku: sku || null, description, fournisseur: fournisseur || null,
      categorie: categorie || 'Autre', quantite: quantite || 1,
      unite: unite || 'unité', note: noteFinale || null,
      statut: 'en_attente', date_demande: new Date().toISOString()
    })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH — changer statut d'une demande
export async function PATCH(req: NextRequest) {
  try {
    const { id, statut } = await req.json()
    const { error } = await supabaseAdmin.from('demandes_fournitures').update({ statut }).eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
