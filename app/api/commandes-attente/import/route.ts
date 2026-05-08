import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseCommandesPdf } from '@/lib/commandes-pdf-parser'
import { parseCommandesPdfAvecIA } from '@/lib/commandes-pdf-ai-parser'

export const runtime = 'nodejs'
export const maxDuration = 90  // l'IA peut prendre 10-30s sur un gros PDF

// POST multipart/form-data — upload du PDF "Liste commande" Traction.
//
// Form fields :
//   file       : PDF
//   diagnostic : "1" pour renvoyer juste les rawLines/rawText (debug, pas d'écriture DB)
//   moteur     : "ia" (défaut) | "regex" (force le parser regex)
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
    const moteur = String(form.get('moteur') || 'ia').toLowerCase()

    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buf = Buffer.from(await file.arrayBuffer())

    // ── Choix du moteur de parsing ──────────────────────────────
    let commandes: any[] = []
    let rawTexte = ''
    let warnings: string[] = []
    let moteurUtilise = moteur

    if (moteur === 'regex') {
      const r = await parseCommandesPdf(buf)
      if (!r.success) return NextResponse.json({ erreur: r.erreur }, { status: 500 })
      commandes = r.commandes
      rawTexte = r.rawLines.join('\n')
      warnings = r.warnings
    } else {
      // Moteur IA (défaut)
      const r = await parseCommandesPdfAvecIA(buf)
      if (r.success) {
        commandes = r.commandes
        rawTexte = r.rawText
        moteurUtilise = 'ia'
      } else {
        // Fallback automatique sur le parser regex si l'IA échoue
        // (typiquement : pas d'AI_GATEWAY_API_KEY configurée)
        warnings.push(`IA indisponible (${r.erreur}) — fallback regex`)
        const rg = await parseCommandesPdf(buf)
        if (!rg.success) {
          return NextResponse.json({
            erreur: `IA et regex ont échoué. IA: ${r.erreur}. Regex: ${rg.erreur}`,
          }, { status: 500 })
        }
        commandes = rg.commandes
        rawTexte = rg.rawLines.join('\n')
        warnings = warnings.concat(rg.warnings)
        moteurUtilise = 'regex (fallback)'
      }
    }

    if (diagnostic) {
      return NextResponse.json({
        diagnostic: true,
        moteur: moteurUtilise,
        nb_lignes_brutes: rawTexte.split('\n').length,
        nb_commandes_parsees: commandes.length,
        rawText: rawTexte.slice(0, 8000),  // tronqué pour pas exploser le payload
        commandes,
        warnings,
      })
    }

    if (commandes.length === 0) {
      return NextResponse.json({
        erreur: 'Aucune commande détectée dans le PDF',
        moteur: moteurUtilise,
        warnings,
        rawText: rawTexte.slice(0, 4000),
      }, { status: 400 })
    }

    const now = new Date().toISOString()

    // Charger l'existant
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

    for (const c of commandes) {
      // Validation minimum
      if (!c.num_commande || !c.num_piece || !c.statut) continue

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
        qte_commandee:   typeof c.qte_commandee === 'number' ? c.qte_commandee : 0,
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
            ...(statutChange || wasInactive ? { date_premiere_vue: now } : {}),
            active: true,
          },
        })
      }
    }

    const toDeactivate: number[] = []
    for (const r of existants || []) {
      const key = `${r.num_commande}__${r.num_piece}`
      if (r.active && !seenKeys.has(key)) toDeactivate.push(r.id)
    }

    let inserted = 0, updated = 0, deactivated = 0

    for (let i = 0; i < toInsert.length; i += 500) {
      const batch = toInsert.slice(i, i + 500)
      const { error } = await supabaseAdmin.from('commandes_attente').insert(batch)
      if (error) throw error
      inserted += batch.length
    }

    for (const u of toUpdate) {
      const { error } = await supabaseAdmin
        .from('commandes_attente')
        .update(u.patch)
        .eq('id', u.id)
      if (error) throw error
      updated++
    }

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
      moteur: moteurUtilise,
      inserted,
      updated,
      deactivated,
      nb_commandes_parsees: commandes.length,
      warnings,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message || String(e) }, { status: 500 })
  }
}
