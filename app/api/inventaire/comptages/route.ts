import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    // Récupération d'un comptage précis par id (édition côté employé)
    const idParam = req.nextUrl.searchParams.get('id')
    if (idParam) {
      const { data, error } = await supabaseAdmin.from('inventaire_comptages').select('*').eq('id', Number(idParam)).maybeSingle()
      if (error) throw error
      return NextResponse.json(data || null)
    }

    // Vérifier les comptages d'aujourd'hui pour une pièce spécifique
    const codeCheck = req.nextUrl.searchParams.get('code_today')
    if (codeCheck) {
      const today = new Date().toISOString().split('T')[0]
      const { data, error } = await supabaseAdmin.from('inventaire_comptages').select('*')
        .eq('code_piece', codeCheck)
        .gte('date_comptage', today + 'T00:00:00').lte('date_comptage', today + 'T23:59:59')
      if (error) throw error
      return NextResponse.json(data || [])
    }

    let query = supabaseAdmin.from('inventaire_comptages').select('*').order('date_comptage', { ascending: false })
    let all: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await query.range(from, from + 999)
      if (error) throw error
      all = all.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    return NextResponse.json(all)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { code_piece, localisation, qte_comptee, qte_systeme, qte_reservee, employe, note, photo_url } = body
    if (!code_piece || !localisation || qte_comptee === undefined || !employe) {
      return NextResponse.json({ erreur: 'Champs requis manquants' }, { status: 400 })
    }
    const ecart = qte_comptee - (qte_systeme || 0)
    const now = new Date()
    const today = now.toISOString().split('T')[0]

    // Récupérer les IDs des anciens comptages du jour AVANT suppression,
    // pour transférer leurs retours comptables actifs vers le nouveau comptage.
    const { data: anciens } = await supabaseAdmin
      .from('inventaire_comptages')
      .select('id')
      .eq('code_piece', code_piece).eq('localisation', localisation)
      .gte('date_comptage', today + 'T00:00:00').lte('date_comptage', today + 'T23:59:59')
    const ancienIds = (anciens || []).map((a: any) => a.id)

    // Supprimer les comptages existants du même jour pour cette pièce+localisation
    if (ancienIds.length > 0) {
      await supabaseAdmin.from('inventaire_comptages').delete().in('id', ancienIds)
    }

    const { data, error } = await supabaseAdmin.from('inventaire_comptages').insert({
      code_piece, localisation, qte_comptee, qte_systeme: qte_systeme || 0,
      qte_reservee: qte_reservee || 0, ecart, employe, note: note || null,
      photo_url: photo_url || null,
      date_comptage: now.toISOString(), statut: 'en_attente'
    }).select()
    if (error) throw error
    const nouveauComptage = data?.[0]

    // Transférer les retours comptables actifs des anciens comptages vers le
    // nouveau (préserve le commentaire de la comptable).
    if (nouveauComptage && ancienIds.length > 0) {
      await supabaseAdmin
        .from('comptabilite_retours')
        .update({ ref_id: nouveauComptage.id })
        .eq('source', 'comptage')
        .in('ref_id', ancienIds)
    }

    return NextResponse.json(nouveauComptage || {})
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH /api/inventaire/comptages
// Body: { id, localisation?, qte_comptee?, qte_reservee?, note?, photo_url? }
// Met à jour un comptage existant (utilisé par l'employé après un retour
// comptabilité). Recalcule ecart et — si le comptage est déjà réconcilié —
// ecart_reconcilie immédiatement (pas d'attente de la prochaine sync ERP).
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, localisation, qte_comptee, qte_systeme, qte_reservee, note, photo_url } = body
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

    const { data: existing, error: errFetch } = await supabaseAdmin
      .from('inventaire_comptages').select('*').eq('id', id).maybeSingle()
    if (errFetch) throw errFetch
    if (!existing) return NextResponse.json({ erreur: 'Comptage introuvable' }, { status: 404 })

    const update: any = {}
    if (localisation !== undefined) update.localisation = localisation
    if (qte_comptee !== undefined) update.qte_comptee = qte_comptee
    if (qte_systeme !== undefined) update.qte_systeme = qte_systeme
    if (qte_reservee !== undefined) update.qte_reservee = qte_reservee
    if (note !== undefined) update.note = note
    if (photo_url !== undefined) update.photo_url = photo_url

    const newQc = qte_comptee !== undefined ? Number(qte_comptee) : Number(existing.qte_comptee || 0)
    const newQs = qte_systeme !== undefined ? Number(qte_systeme) : Number(existing.qte_systeme || 0)
    update.ecart = newQc - newQs

    // Réconciliation immédiate si déjà réconcilié — on garde le comptage visible
    // côté Comptabilité avec son nouvel écart sans attendre la prochaine sync.
    if (existing.statut === 'reconcilie') {
      update.ecart_reconcilie = newQc - newQs
      update.date_reconciliation = new Date().toISOString()
    }

    const { data, error } = await supabaseAdmin
      .from('inventaire_comptages').update(update).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const all = req.nextUrl.searchParams.get('all')
    const code = req.nextUrl.searchParams.get('code')
    const loc = req.nextUrl.searchParams.get('loc')

    if (all === '1') {
      // Effacer TOUS les comptages
      const { error } = await supabaseAdmin
        .from('inventaire_comptages')
        .delete()
        .neq('id', 0)
      if (error) throw error
      return NextResponse.json({ success: true, message: 'Tous les comptages effacés' })
    }

    if (code && loc) {
      const today = new Date().toISOString().split('T')[0]
      await supabaseAdmin.from('inventaire_comptages').delete()
        .eq('code_piece', code).eq('localisation', loc)
        .gte('date_comptage', today + 'T00:00:00')
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ erreur: 'Paramètres manquants' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
