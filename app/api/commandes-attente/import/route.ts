import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseCommandesPdf } from '@/lib/commandes-pdf-parser'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST multipart/form-data — upload du PDF "Liste commande" Traction.
//
// Form fields :
//   file       : PDF
//   diagnostic : "1" pour renvoyer juste les rawLines (debug, pas d'écriture DB)
//
// Comportement d'import :
//   - Pour chaque ligne parsée :
//       * pas de row existant pour (num_commande, num_piece) → INSERT
//       * row existant + même statut → UPDATE date_dernier_import (garde date_premiere_vue)
//       * row existant + statut différent → UPDATE statut + reset date_premiere_vue
//   - Toutes les lignes actives qui n'apparaissent PAS dans cet import
//     sont marquées active=false (= reçues / fermées).

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const diagnostic = String(form.get('diagnostic') || '') === '1'

    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buf = Buffer.from(await file.arrayBuffer())
    const parsed = await parseCommandesPdf(buf)
    if (!parsed.success) return NextResponse.json({ erreur: parsed.erreur }, { status: 500 })

    if (diagnostic) {
      return NextResponse.json({
        diagnostic: true,
        nb_lignes_brutes: parsed.rawLines.length,
        nb_commandes_parsees: parsed.commandes.length,
        rawLines: parsed.rawLines,
        commandes: parsed.commandes,
        warnings: parsed.warnings,
      })
    }

    if (parsed.commandes.length === 0) {
      return NextResponse.json({
        erreur: 'Aucune commande détectée dans le PDF',
        warnings: parsed.warnings,
        rawLines: parsed.rawLines.slice(0, 50),
      }, { status: 400 })
    }

    const now = new Date().toISOString()

    // Charger l'existant (toutes les lignes même inactives, on les ressuscite si besoin)
    const { data: existants, error: errLoad } = await supabaseAdmin
      .from('commandes_attente')
      .select('id, num_commande, num_piece, statut, date_premiere_vue, active')
    if (errLoad) throw errLoad

    const existMap = new Map<string, any>()
    for (const r of existants || []) {
      existMap.set(`${r.num_commande}__${r.num_piece}`, r)
    }

    const seenKeys = new Set<string>()
    const toInsert: any[] = []
    const toUpdate: { id: number, patch: any }[] = []

    for (const c of parsed.commandes) {
      const key = `${c.num_commande}__${c.num_piece}`
      seenKeys.add(key)
      const ex = existMap.get(key)

      const baseRow = {
        num_commande:    c.num_commande,
        num_piece:       c.num_piece,
        statut:          c.statut,
        date_commande:   c.date_commande,
        num_fournisseur: c.num_fournisseur,
        nom_fournisseur: c.nom_fournisseur,
        commande_par:    c.commande_par,
        qte_commandee:   c.qte_commandee,
        description:     c.description,
        nom_employe:     c.nom_employe,
      }

      if (!ex) {
        toInsert.push({
          ...baseRow,
          date_premiere_vue:   now,
          date_dernier_import: now,
          active: true,
        })
      } else {
        const statutChange = ex.statut !== c.statut
        const wasInactive  = !ex.active
        toUpdate.push({
          id: ex.id,
          patch: {
            ...baseRow,
            date_dernier_import: now,
            // reset le compteur si le statut a changé OU si la ligne avait disparu (revient)
            ...(statutChange || wasInactive ? { date_premiere_vue: now } : {}),
            active: true,
          },
        })
      }
    }

    // Marquer comme inactives les lignes qui n'étaient pas dans cet import
    const toDeactivate: number[] = []
    for (const r of existants || []) {
      const key = `${r.num_commande}__${r.num_piece}`
      if (r.active && !seenKeys.has(key)) toDeactivate.push(r.id)
    }

    let inserted = 0, updated = 0, deactivated = 0

    // INSERT par batch
    for (let i = 0; i < toInsert.length; i += 500) {
      const batch = toInsert.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('commandes_attente').insert(batch)
      if (error) throw error
      inserted += batch.length
    }

    // UPDATE individuels (Supabase ne fait pas d'update batch hétérogène)
    for (const u of toUpdate) {
      const { error } = await supabaseAdmin
        .from('commandes_attente')
        .update(u.patch)
        .eq('id', u.id)
      if (error) throw error
      updated++
    }

    // Désactivation par batch
    if (toDeactivate.length > 0) {
      for (let i = 0; i < toDeactivate.length; i += 500) {
        const batch = toDeactivate.slice(i, i + 500)
        const { error } = await supabaseAdmin
          .from('commandes_attente')
          .update({ active: false, date_dernier_import: now })
          .in('id', batch)
        if (error) throw error
        deactivated += batch.length
      }
    }

    return NextResponse.json({
      success: true,
      inserted,
      updated,
      deactivated,
      nb_commandes_parsees: parsed.commandes.length,
      warnings: parsed.warnings,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
