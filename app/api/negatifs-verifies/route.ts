import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    // Récupération d'un négatif vérifié précis par id (édition après retour compta)
    const idParam = req.nextUrl.searchParams.get('id')
    if (idParam) {
      const { data, error } = await supabaseAdmin
        .from('negatifs_verifies').select('*').eq('id', Number(idParam)).maybeSingle()
      if (error) throw error
      return NextResponse.json(data || null)
    }
    const { data, error } = await supabaseAdmin
      .from('negatifs_verifies')
      .select('*')
      .order('date_verification', { ascending: false })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// PATCH /api/negatifs-verifies
// Body: { id, ...champs à mettre à jour }
// Met à jour un négatif vérifié existant (utilisé par l'employé après un retour
// comptabilité). N'écrit que les champs fournis.
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...fields } = body
    if (!id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })

    const allowed = [
      'stock_au_moment','valeur_au_moment','note',
      'serv_detail','serv_interne','serv_gar','pce_detail','recept_comm','dec_physique','autre',
      'qte_reelle','ajustement','cause','commentaire',
      'photo_url','photo_url2',
      'alt_code_piece','alt_ajustement',
      'alt_serv_detail','alt_serv_interne','alt_serv_gar','alt_pce_detail',
      'alt_recept_comm','alt_dec_physique','alt_autre','alt_qte_reelle',
    ]
    const update: any = {}
    for (const k of allowed) if (fields[k] !== undefined) update[k] = fields[k]

    const { data, error } = await supabaseAdmin
      .from('negatifs_verifies').update(update).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { code_piece, employe } = body
    if (!code_piece || !employe) return NextResponse.json({ erreur: 'code_piece et employe requis' }, { status: 400 })

    const { error } = await supabaseAdmin.from('negatifs_verifies').insert({
      code_piece,
      employe,
      stock_au_moment:  body.stock_au_moment,
      valeur_au_moment: body.valeur_au_moment,
      note:             body.note || null,
      // Transactions
      serv_detail:      body.serv_detail ?? 0,
      serv_interne:     body.serv_interne ?? 0,
      serv_gar:         body.serv_gar ?? 0,
      pce_detail:       body.pce_detail ?? 0,
      recept_comm:      body.recept_comm ?? 0,
      dec_physique:     body.dec_physique ?? 0,
      autre:            body.autre ?? 0,
      qte_reelle:       body.qte_reelle ?? 0,
      ajustement:       body.ajustement ?? 0,
      // Justification comptabilité
      cause:            body.cause || null,
      commentaire:      body.commentaire || null,
      // Photos
      photo_url:        body.photo_url || null,
      photo_url2:       body.photo_url2 || null,
      // Pièce alternative
      alt_code_piece:   body.alt_code_piece || null,
      alt_ajustement:   body.alt_ajustement ?? null,
      alt_serv_detail:  body.alt_serv_detail ?? 0,
      alt_serv_interne: body.alt_serv_interne ?? 0,
      alt_serv_gar:     body.alt_serv_gar ?? 0,
      alt_pce_detail:   body.alt_pce_detail ?? 0,
      alt_recept_comm:  body.alt_recept_comm ?? 0,
      alt_dec_physique: body.alt_dec_physique ?? 0,
      alt_autre:        body.alt_autre ?? 0,
      alt_qte_reelle:   body.alt_qte_reelle ?? 0,
      date_verification: new Date().toISOString()
    })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    if (body.id) {
      const { error } = await supabaseAdmin.from('negatifs_verifies').delete().eq('id', body.id)
      if (error) throw error
    } else if (body.code_piece) {
      const { error } = await supabaseAdmin.from('negatifs_verifies').delete().eq('code_piece', body.code_piece)
      if (error) throw error
    }
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
