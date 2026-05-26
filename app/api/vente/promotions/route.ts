import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — liste promotions. Filtres :
//   ?actives=1            → uniquement actives ET dans la fenêtre date
//   ?marque_id=X          → uniquement pour cette marque (ou sans marque)
export async function GET(req: NextRequest) {
  try {
    const actives = req.nextUrl.searchParams.get('actives')
    const marqueId = req.nextUrl.searchParams.get('marque_id')
    let q = supabaseAdmin.from('vente_promotions').select('*').order('date_fin', { ascending: true, nullsFirst: false })
    if (actives === '1') {
      const today = new Date().toISOString().slice(0, 10)
      q = q.eq('actif', true)
        .or(`date_debut.is.null,date_debut.lte.${today}`)
        .or(`date_fin.is.null,date_fin.gte.${today}`)
    }
    if (marqueId) q = q.or(`marque_id.is.null,marque_id.eq.${Number(marqueId)}`)
    const { data, error } = await q
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { titre, description, marque_id, modele, annee, sku, type_rabais, valeur, prix_avant, prix_apres, image_url, date_debut, date_fin, actif, cree_par } = body
    if (!titre || !titre.trim()) return NextResponse.json({ erreur: 'titre requis' }, { status: 400 })
    const { data, error } = await supabaseAdmin.from('vente_promotions').insert({
      titre: titre.trim(),
      description: description || null,
      marque_id: marque_id || null,
      modele: modele || null,
      annee: annee || null,
      sku: sku || null,
      type_rabais: type_rabais || 'autre',
      valeur: valeur != null ? Number(valeur) : null,
      prix_avant: prix_avant != null ? Number(prix_avant) : null,
      prix_apres: prix_apres != null ? Number(prix_apres) : null,
      image_url: image_url || null,
      date_debut: date_debut || null,
      date_fin: date_fin || null,
      actif: actif !== undefined ? !!actif : true,
      cree_par: cree_par || null,
    }).select().single()
    if (error) throw error
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...rest } = body
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const update: any = {}
    for (const k of ['titre','description','marque_id','modele','annee','sku','type_rabais','valeur','prix_avant','prix_apres','image_url','date_debut','date_fin','actif']) {
      if (rest[k] !== undefined) update[k] = rest[k]
    }
    const { data, error } = await supabaseAdmin
      .from('vente_promotions').update(update).eq('id', id).select().single()
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
    const { error } = await supabaseAdmin.from('vente_promotions').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
