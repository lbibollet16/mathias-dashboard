import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chargerTout } from '@/lib/meca-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/pieces/summary — vue directeur du Comptoir Pièces : KPI globaux,
// classement des commis (triable côté client), suivi d'âge des factures
// ouvertes (+7/+15/+20 j urgent) et taux de closing des estimés.

const SEUIL_MARGE_PCT = 25
const SEUIL_MONTANT_JUSTIFICATIF_OBLIGATOIRE = 500

const AGE_BUCKETS = [
  { label: '0-7j',           min: 0,  max: 7 },
  { label: '8-15j',          min: 8,  max: 15 },
  { label: '16-20j',         min: 16, max: 20 },
  { label: '20j+ (urgent)',  min: 21, max: Infinity },
]

export async function GET() {
  try {
    const { data: clerks, error: eClerks } = await supabaseAdmin
      .from('parts_clerks').select('id, nom, actif').eq('actif', true)
    if (eClerks) throw eClerks
    const clerkIds = (clerks ?? []).map(c => c.id)

    const vide = {
      clerks: [],
      kpi: { ventesTotal: 0, profitTotal: 0, profitPctGlobal: 0, nbFactures: 0, ventesSousSeuil: 0 },
      classementCommis: [],
      tauxClosingGlobal: null,
      seuils: { margePct: SEUIL_MARGE_PCT, montantJustificatifObligatoire: SEUIL_MONTANT_JUSTIFICATIF_OBLIGATOIRE },
      facturesOuvertes: { total: 0, plus7j: 0, plus15j: 0, plus20jUrgent: 0, ageParTranche: AGE_BUCKETS.map(b => ({ label: b.label, count: 0 })), valeurEnAttente: 0 },
    }
    if (clerkIds.length === 0) return NextResponse.json(vide)

    // Dernier import du rapport de vente : on ne compte que ses lignes, pour ne
    // pas cumuler plusieurs imports du même mois.
    const { data: dernierBatch } = await supabaseAdmin
      .from('parts_import_batches').select('id')
      .eq('type', 'rapport_vente_piece')
      .order('uploaded_at', { ascending: false }).limit(1).maybeSingle()

    const ventes = await chargerTout<any>('parts_sales', q => {
      let qq = q.select('*').in('clerk_id', clerkIds)
      if (dernierBatch) qq = qq.eq('import_batch_id', dernierBatch.id)
      return qq
    })

    const ventesParCommis = new Map<string, any[]>()
    for (const v of ventes) {
      const l = ventesParCommis.get(v.clerk_id) ?? []
      l.push(v); ventesParCommis.set(v.clerk_id, l)
    }

    const openInvoices = await chargerTout<any>('parts_open_invoices',
      q => q.select('clerk_id, date_ouverture, total').eq('is_open', true).in('clerk_id', clerkIds), 'facture_no')

    const now = Date.now()
    const ageDe = (d: string) => Math.floor((now - new Date(d).getTime()) / 86400000)

    const urgentesParCommis = new Map<string, number>()
    for (const f of openInvoices) {
      if (ageDe(f.date_ouverture) > 20) urgentesParCommis.set(f.clerk_id, (urgentesParCommis.get(f.clerk_id) ?? 0) + 1)
    }

    const classementCommis = (clerks ?? []).map(c => {
      const l = ventesParCommis.get(c.id) ?? []
      const ventesTotal = l.reduce((s, v) => s + Number(v.ventes || 0), 0)
      const coutTotal = l.reduce((s, v) => s + Number(v.cout || 0), 0)
      const profitTotal = ventesTotal - coutTotal
      return {
        id: c.id,
        nom: c.nom,
        ventesTotal: Math.round(ventesTotal * 100) / 100,
        profitTotal: Math.round(profitTotal * 100) / 100,
        profitPct: ventesTotal !== 0 ? Math.round((profitTotal / ventesTotal) * 1000) / 10 : null,
        nbFactures: l.reduce((s, v) => s + Number(v.nb_factures || 0), 0),
        ventesSousSeuil: l.filter(v => v.marge_sous_seuil).length,
        justificatifsManquants: l.filter(v => v.justificatif_requis && !v.justificatif_texte).length,
        facturesUrgentes20j: urgentesParCommis.get(c.id) ?? 0,
      }
    })

    const ventesTotal = classementCommis.reduce((s, c) => s + c.ventesTotal, 0)
    const profitTotal = classementCommis.reduce((s, c) => s + c.profitTotal, 0)

    // Taux de closing global.
    const estimes = await chargerTout<any>('parts_estimates', q => q.select('converti'), 'estimate_no')
    const tauxClosingGlobal = estimes.length > 0
      ? Math.round((estimes.filter(e => e.converti).length / estimes.length) * 1000) / 10 : null

    const ages = openInvoices.map(f => ageDe(f.date_ouverture))
    return NextResponse.json({
      clerks,
      kpi: {
        ventesTotal: Math.round(ventesTotal * 100) / 100,
        profitTotal: Math.round(profitTotal * 100) / 100,
        profitPctGlobal: ventesTotal !== 0 ? Math.round((profitTotal / ventesTotal) * 1000) / 10 : 0,
        nbFactures: classementCommis.reduce((s, c) => s + c.nbFactures, 0),
        ventesSousSeuil: classementCommis.reduce((s, c) => s + c.ventesSousSeuil, 0),
      },
      classementCommis,
      tauxClosingGlobal,
      seuils: { margePct: SEUIL_MARGE_PCT, montantJustificatifObligatoire: SEUIL_MONTANT_JUSTIFICATIF_OBLIGATOIRE },
      facturesOuvertes: {
        total: openInvoices.length,
        plus7j: ages.filter(a => a > 7).length,
        plus15j: ages.filter(a => a > 15).length,
        plus20jUrgent: ages.filter(a => a > 20).length,
        ageParTranche: AGE_BUCKETS.map(b => ({ label: b.label, count: ages.filter(a => a >= b.min && a <= b.max).length })),
        valeurEnAttente: Math.round(openInvoices.reduce((s, f) => s + Number(f.total || 0), 0) * 100) / 100,
      },
    })
  } catch (e: any) {
    console.error('[pieces/summary] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
