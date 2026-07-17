import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/pieces/commis-summary?id=NN — détail d'un commis : ventes du dernier
// import, ventes sous le seuil de marge (justificatif), taux de closing
// personnel, et ses factures pièces ouvertes avec suivi.

export async function GET(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ erreur: "Paramètre 'id' requis." }, { status: 400 })

    const { data: clerk, error: eClerk } = await supabaseAdmin
      .from('parts_clerks').select('id, nom, actif').eq('id', id).maybeSingle()
    if (eClerk) throw eClerk
    if (!clerk) return NextResponse.json({ erreur: `Aucun commis avec l'id ${id}.` }, { status: 404 })

    const { data: dernierBatch } = await supabaseAdmin
      .from('parts_import_batches').select('id')
      .eq('type', 'rapport_vente_piece')
      .order('uploaded_at', { ascending: false }).limit(1).maybeSingle()

    const ventes = await chargerTout<any>('parts_sales', q => {
      let qq = q.select('*').eq('clerk_id', id)
      if (dernierBatch) qq = qq.eq('import_batch_id', dernierBatch.id)
      return qq
    })

    const ventesTotal = ventes.reduce((s, v) => s + Number(v.ventes || 0), 0)
    const coutTotal = ventes.reduce((s, v) => s + Number(v.cout || 0), 0)
    const profitTotal = ventesTotal - coutTotal
    const ventesSousSeuil = ventes.filter(v => v.marge_sous_seuil)
      .sort((a, b) => Number(b.ventes) - Number(a.ventes))

    // Taux de closing : ses estimés, via facture_no = estimate_no.
    const sesFactures = await chargerTout<any>('parts_invoices', q => q.select('facture_no').eq('clerk_id', id), 'facture_no')
    const sesNos = new Set(sesFactures.map(f => f.facture_no))
    const tousEstimes = await chargerTout<any>('parts_estimates', q => q.select('estimate_no, converti'), 'estimate_no')
    const sesEstimes = tousEstimes.filter(e => sesNos.has(e.estimate_no))
    const nbConvertis = sesEstimes.filter(e => e.converti).length

    // Ses factures ouvertes, avec suivi, triées par âge décroissant.
    const ouvertes = await chargerTout<any>('parts_open_invoices',
      q => q.select('facture_no, client_nom, total, date_ouverture, suivi_statut, suivi_date_planifiee, suivi_note, suivi_par, suivi_maj_at')
            .eq('is_open', true).eq('clerk_id', id), 'facture_no')

    const now = Date.now()
    const liste = ouvertes.map(f => ({
      factureNo: f.facture_no,
      clientNom: f.client_nom ?? '',
      total: Number(f.total || 0),
      dateOuverture: f.date_ouverture,
      ageJours: Math.floor((now - new Date(f.date_ouverture).getTime()) / 86400000),
      signale: Math.floor((now - new Date(f.date_ouverture).getTime()) / 86400000) > 20,
      suiviStatut: f.suivi_statut ?? null,
      suiviDatePlanifiee: f.suivi_date_planifiee ?? null,
      suiviNote: f.suivi_note ?? null,
      suiviPar: f.suivi_par ?? null,
      suiviMajAt: f.suivi_maj_at ?? null,
    })).sort((a, b) => b.ageJours - a.ageJours)

    return NextResponse.json({
      clerk,
      kpi: {
        ventesTotal: Math.round(ventesTotal * 100) / 100,
        profitTotal: Math.round(profitTotal * 100) / 100,
        profitPct: ventesTotal !== 0 ? Math.round((profitTotal / ventesTotal) * 1000) / 10 : null,
        nbFactures: ventes.reduce((s, v) => s + Number(v.nb_factures || 0), 0),
        ventesSousSeuilCount: ventesSousSeuil.length,
        justificatifsManquants: ventesSousSeuil.filter(v => v.justificatif_requis && !v.justificatif_texte).length,
      },
      ventesSousSeuil: ventesSousSeuil.map(v => ({
        id: v.id,
        clientNom: v.client_nom,
        ventes: Number(v.ventes || 0),
        profitPct: v.profit_pct,
        justificatifRequis: v.justificatif_requis,
        justificatifTexte: v.justificatif_texte,
      })),
      closing: { nbEstimes: sesEstimes.length, nbConvertis, tauxClosing: sesEstimes.length > 0 ? Math.round((nbConvertis / sesEstimes.length) * 1000) / 10 : null },
      facturesOuvertes: {
        total: liste.length,
        plus7j: liste.filter(f => f.ageJours > 7).length,
        plus15j: liste.filter(f => f.ageJours > 15).length,
        plus20jUrgent: liste.filter(f => f.ageJours > 20).length,
        liste,
      },
    })
  } catch (e: any) {
    console.error('[pieces/commis-summary] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
