import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseBonsDeTravail } from '@/lib/meca-parser-bons'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

// POST multipart/form-data, champ "file" = l'export Excel (.xlsx) de la
// "Liste des Bons de Travail Ouverts".
// Voir lib/meca-parser-bons.ts pour le détail du parsing.
//
// Un bon présent dans l'import est (ré)ouvert et son compteur de stagnation
// incrémenté ; un bon absent de l'import alors qu'il était ouvert est
// considéré fermé (is_open=false, closed_detected_at=maintenant).

// Nombre d'imports consécutifs où un bon reste ouvert avant d'être signalé.
const SEUIL_SIGNALEMENT = 2

// Charge toutes les lignes d'une requête en paginant : PostgREST plafonne un
// select() sans range à 1000 lignes, ce qui tronquerait silencieusement.
async function chargerTout(table: string, colonnes: string, filtre?: (q: any) => any) {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin.from(table).select(colonnes).order('facture_no', { ascending: true }).range(from, from + 999)
    if (filtre) q = filtre(q)
    const { data, error } = await q
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const { workOrders, warnings } = await parseBonsDeTravail(buffer)

    if (workOrders.length === 0) {
      return NextResponse.json(
        { erreur: 'Aucun bon de travail détecté dans ce fichier.', warnings },
        { status: 422 }
      )
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('meca_import_batches')
      .insert({ type: 'bons_de_travail', filename: file.name, row_count: workOrders.length, warnings })
      .select()
      .single()
    if (batchErr) throw batchErr

    // Aviseurs : ce fichier ne donne QUE le numéro, pas le nom. On crée les
    // inconnus avec un nom temporaire, sans jamais écraser un nom déjà connu
    // (venu du rapport aviseur ou saisi à la main).
    const advisorIds = Array.from(new Set(workOrders.map(w => w.advisor_id)))
    const { data: connus, error: errConnus } = await supabaseAdmin
      .from('meca_advisors').select('id').in('id', advisorIds)
    if (errConnus) throw errConnus
    const dejaLa = new Set((connus ?? []).map(a => a.id))
    const nouveaux = advisorIds.filter(id => !dejaLa.has(id)).map(id => ({ id, nom: `Aviseur #${id}` }))
    if (nouveaux.length > 0) {
      const { error } = await supabaseAdmin.from('meca_advisors').insert(nouveaux)
      if (error) throw error
    }

    // On charge l'existant en une fois plutôt qu'une requête par bon : sur un
    // gros import, la version par-bon faisait des centaines d'allers-retours.
    const existants = await chargerTout(
      'meca_work_orders',
      'facture_no, first_seen_batch_id, imports_vus_ouvert, premiere_alerte_at, is_open, advisor_assigned_manually, advisor_id'
    )
    const parFacture = new Map(existants.map(e => [e.facture_no, e]))

    const maintenant = new Date().toISOString()
    let nouveauxSignalements = 0

    const aUpserter = workOrders.map(wo => {
      const ex = parFacture.get(wo.facture_no)
      // Un bon fermé puis rouvert repart de zéro : on ne compte la stagnation
      // que sur une série d'imports où il est resté ouvert.
      const compteurPrecedent = ex?.is_open ? ex.imports_vus_ouvert ?? 0 : 0
      const alertePrecedente  = ex?.is_open ? ex.premiere_alerte_at : null
      const importsVusOuvert  = compteurPrecedent + 1
      const vientDAtteindreLeSeuil = importsVusOuvert >= SEUIL_SIGNALEMENT && !alertePrecedente
      if (vientDAtteindreLeSeuil) nouveauxSignalements++

      // Réassignation manuelle : l'import ne réécrase pas le choix fait dans l'UI.
      const advisorIdAUtiliser =
        ex?.advisor_assigned_manually && ex.advisor_id ? ex.advisor_id : wo.advisor_id

      return {
        facture_no:          wo.facture_no,
        advisor_id:          advisorIdAUtiliser,
        client_no:           wo.client_no,
        client_nom:          wo.client_nom,
        no_serie:            wo.no_serie,
        no_stock:            wo.no_stock,
        statut:              wo.statut,
        date_ouverture:      wo.date_ouverture,
        date_a_compter:      null,          // non fourni par cet export
        montants:            wo.montants,
        age_jours_source:    wo.age_jours_source,
        is_open:             true,
        closed_detected_at:  null,
        first_seen_batch_id: ex?.first_seen_batch_id ?? batch.id,
        last_seen_batch_id:  batch.id,
        imports_vus_ouvert:  importsVusOuvert,
        premiere_alerte_at:  vientDAtteindreLeSeuil ? maintenant : alertePrecedente ?? null,
        updated_at:          maintenant,
      }
    })

    for (let i = 0; i < aUpserter.length; i += 500) {
      const { error } = await supabaseAdmin
        .from('meca_work_orders')
        .upsert(aUpserter.slice(i, i + 500), { onConflict: 'facture_no' })
      if (error) throw error
    }

    // Fermeture : tout bon encore marqué ouvert qui n'est plus dans l'import.
    const vues = new Set(workOrders.map(w => w.facture_no))
    const toClose = existants.filter(e => e.is_open && !vues.has(e.facture_no)).map(e => e.facture_no)
    for (let i = 0; i < toClose.length; i += 500) {
      const { error } = await supabaseAdmin
        .from('meca_work_orders')
        .update({ is_open: false, closed_detected_at: maintenant })
        .in('facture_no', toClose.slice(i, i + 500))
      if (error) throw error
    }

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      workOrdersImported: workOrders.length,
      workOrdersClosedSinceLastImport: toClose.length,
      nouveauxSignalements,
      warnings,
    })
  } catch (e: any) {
    console.error('[meca/import/bons-de-travail] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e) || 'Erreur inconnue' }, { status: 500 })
  }
}
