import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { detectVariant } from '@/lib/amazon-inventory'

// GET — liste tous les audits
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('amazon_audits')
      .select('*')
      .order('started_at', { ascending: false })
    if (error) throw error

    // Enrichir chaque audit avec un résumé : nb_comptés / total
    const audits = data || []
    for (const a of audits as any[]) {
      const { data: counts } = await supabaseAdmin
        .from('amazon_audit_counts')
        .select('id, hub_compte, fbm_compte, sans_prefix_compte')
        .eq('audit_id', a.id)
      const total = (counts || []).length
      const countesHub = (counts || []).filter(c => c.hub_compte != null).length
      a.nb_total = total
      a.nb_comptes = countesHub
    }

    return NextResponse.json(audits)
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST — créer un nouvel audit, avec snapshot initial de tous les base products
//        qui ont du stock HUB, FBM ou sans préfixe (stock à compter physiquement)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { mois, label, started_by } = body
    if (!mois) return NextResponse.json({ erreur: 'mois requis (YYYY-MM)' }, { status: 400 })

    // Créer l'audit
    const { data: created, error: cErr } = await supabaseAdmin
      .from('amazon_audits')
      .insert({
        mois,
        label: label || `Audit ${mois}`,
        started_by: started_by || null,
        statut: 'en_cours',
        started_at: new Date().toISOString(),
      })
      .select()
      .single()
    if (cErr) throw cErr
    const auditId = created.id

    // Construire le snapshot : charger toutes les lignes Traction AMA/FBA/FBM
    const tractionRows: any[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('traction_amazon_lignes')
        .select('pk_code, qty_minus_reserved, prix_coutant, desc_fra')
        .in('code_ligne', ['AMA', 'FBA', 'FBM'])
        .range(from, from + 999)
      if (error) throw error
      tractionRows.push(...(data || []))
      if (!data || data.length < 1000) break
      from += 1000
    }

    // Dernier snapshot FBA Amazon
    const { data: snapDates } = await supabaseAdmin
      .from('amazon_fba_inventory')
      .select('snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
    const latestSnap = snapDates && snapDates[0]?.snapshot_date

    const fbaByBase = new Map<string, number>()
    if (latestSnap) {
      let f = 0
      while (true) {
        const { data } = await supabaseAdmin
          .from('amazon_fba_inventory')
          .select('sku, afn_fulfillable_quantity, afn_inbound_working_quantity, afn_inbound_shipped_quantity, afn_inbound_receiving_quantity, afn_reserved_quantity, traction_code')
          .eq('snapshot_date', latestSnap)
          .range(f, f + 999)
        if (!data) break
        for (const row of data) {
          const base = detectVariant(row.traction_code || row.sku).base
          const total = Number(row.afn_fulfillable_quantity || 0)
            + Number(row.afn_inbound_working_quantity || 0)
            + Number(row.afn_inbound_shipped_quantity || 0)
            + Number(row.afn_inbound_receiving_quantity || 0)
            + Number(row.afn_reserved_quantity || 0)
          fbaByBase.set(base, (fbaByBase.get(base) || 0) + total)
        }
        if (data.length < 1000) break
        f += 1000
      }
    }

    // Grouper Traction par base code
    type BaseAccum = {
      description: string | null
      coutant: number
      hub: number
      fbm: number
      sans_prefix: number
      fba_traction: number
    }
    const bases = new Map<string, BaseAccum>()
    for (const t of tractionRows) {
      const v = detectVariant(t.pk_code)
      const qty = Number(t.qty_minus_reserved || 0)
      const ex = bases.get(v.base) || { description: null, coutant: 0, hub: 0, fbm: 0, sans_prefix: 0, fba_traction: 0 }
      if (!ex.description && t.desc_fra) ex.description = t.desc_fra
      if (ex.coutant === 0 && Number(t.prix_coutant || 0) > 0) ex.coutant = Number(t.prix_coutant)
      if (v.location === 'HUB')       ex.hub += qty
      else if (v.location === 'FBM')  ex.fbm += qty
      else if (v.location === 'FBA')  ex.fba_traction += qty
      else                            ex.sans_prefix += qty
      bases.set(v.base, ex)
    }

    // Créer une ligne amazon_audit_counts pour chaque base qui mérite d'être comptée
    // (stock HUB, FBM ou sans préfixe > 0, OU présent chez Amazon)
    const countRows: any[] = []
    for (const [base, b] of bases) {
      const fba_amazon = fbaByBase.get(base) || 0
      if (b.hub === 0 && b.fbm === 0 && b.sans_prefix === 0 && fba_amazon === 0 && b.fba_traction === 0) continue
      countRows.push({
        audit_id: auditId,
        base_code: base,
        description: b.description,
        coutant: b.coutant,
        hub_theorique: b.hub,
        fbm_theorique: b.fbm,
        sans_prefix_theorique: b.sans_prefix,
        fba_amazon_theorique: fba_amazon,
        fba_traction_theorique: b.fba_traction,
      })
    }

    // Insert par lots de 500
    for (let i = 0; i < countRows.length; i += 500) {
      const batch = countRows.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('amazon_audit_counts').insert(batch)
      if (error) throw error
    }

    // Mettre à jour le snapshot_count
    await supabaseAdmin
      .from('amazon_audits')
      .update({ snapshot_count: countRows.length })
      .eq('id', auditId)

    return NextResponse.json({
      success: true,
      audit: { ...created, snapshot_count: countRows.length },
      total: countRows.length,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}

// DELETE — supprimer un audit (et ses counts via cascade)
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.id) return NextResponse.json({ erreur: 'id requis' }, { status: 400 })
    const { error } = await supabaseAdmin.from('amazon_audits').delete().eq('id', body.id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
