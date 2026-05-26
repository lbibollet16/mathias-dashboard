import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET — packages avec leurs items inclus.
// ?actives=1  → uniquement actifs dans la fenêtre date
export async function GET(req: NextRequest) {
  try {
    const actives = req.nextUrl.searchParams.get('actives')
    let q = supabaseAdmin.from('vente_packages').select('*').order('cree_le', { ascending: false })
    if (actives === '1') {
      const today = new Date().toISOString().slice(0, 10)
      q = q.eq('actif', true)
        .or(`date_debut.is.null,date_debut.lte.${today}`)
        .or(`date_fin.is.null,date_fin.gte.${today}`)
    }
    const { data, error } = await q
    if (error) throw error

    // Charger les items pour ces packages
    const ids = (data || []).map((p:any) => p.id)
    let items: any[] = []
    if (ids.length > 0) {
      const { data: it } = await supabaseAdmin
        .from('vente_package_items').select('*').in('package_id', ids).order('ordre', { ascending: true })
      items = it || []
    }
    const itemsParPkg = new Map<number, any[]>()
    for (const it of items) {
      if (!itemsParPkg.has(it.package_id)) itemsParPkg.set(it.package_id, [])
      itemsParPkg.get(it.package_id)!.push(it)
    }
    const enrichis = (data || []).map((p:any) => ({ ...p, items: itemsParPkg.get(p.id) || [] }))
    return NextResponse.json(enrichis)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer un package + ses items en une transaction logique
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { titre, description, marque_id, prix_avant, prix_apres, mo_montant, image_url, date_debut, date_fin, actif, cree_par, items } = body
    if (!titre || !titre.trim()) return NextResponse.json({ erreur: 'titre requis' }, { status: 400 })
    const { data: pkg, error } = await supabaseAdmin.from('vente_packages').insert({
      titre: titre.trim(),
      description: description || null,
      marque_id: marque_id || null,
      prix_avant: prix_avant != null ? Number(prix_avant) : null,
      prix_apres: prix_apres != null ? Number(prix_apres) : null,
      mo_montant: mo_montant != null ? Number(mo_montant) : null,
      image_url: image_url || null,
      date_debut: date_debut || null,
      date_fin: date_fin || null,
      actif: actif !== undefined ? !!actif : true,
      cree_par: cree_par || null,
    }).select().single()
    if (error) throw error

    if (Array.isArray(items) && items.length > 0) {
      const rows = items.map((it: any, i: number) => ({
        package_id: pkg.id,
        sku: it.sku || null,
        description: it.description || null,
        quantite: Number(it.quantite || 1),
        prix_unitaire: it.prix_unitaire != null ? Number(it.prix_unitaire) : null,
        ordre: i,
      }))
      const { error: errIt } = await supabaseAdmin.from('vente_package_items').insert(rows)
      if (errIt) throw errIt
    }
    return NextResponse.json(pkg)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH — modifier un package + remplacer ses items
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, items, ...rest } = body
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const update: any = {}
    for (const k of ['titre','description','marque_id','prix_avant','prix_apres','mo_montant','image_url','date_debut','date_fin','actif']) {
      if (rest[k] !== undefined) update[k] = rest[k]
    }
    const { data, error } = await supabaseAdmin
      .from('vente_packages').update(update).eq('id', id).select().single()
    if (error) throw error

    // Remplacer les items si fournis (delete + insert)
    if (Array.isArray(items)) {
      await supabaseAdmin.from('vente_package_items').delete().eq('package_id', id)
      if (items.length > 0) {
        const rows = items.map((it: any, i: number) => ({
          package_id: id,
          sku: it.sku || null,
          description: it.description || null,
          quantite: Number(it.quantite || 1),
          prix_unitaire: it.prix_unitaire != null ? Number(it.prix_unitaire) : null,
          ordre: i,
        }))
        const { error: errIt } = await supabaseAdmin.from('vente_package_items').insert(rows)
        if (errIt) throw errIt
      }
    }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('vente_packages').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
