import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parseCommandesPdf } from '@/lib/commandes-pdf-parser'
import { parseCommandesPdfAvecIA } from '@/lib/commandes-pdf-ai-parser'

export const runtime = 'nodejs'
export const maxDuration = 300  // l'IA peut prendre 60-180s sur un gros PDF
export const dynamic = 'force-dynamic'

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
    // Moteur par défaut = regex (rapide, adapté au format multi-page Traction).
    // L'IA reste en option ("moteur=ia") pour les cas où le regex galère.
    const moteur = String(form.get('moteur') || 'regex').toLowerCase()

    if (!file) return NextResponse.json({ erreur: 'Fichier requis' }, { status: 400 })

    const buf = Buffer.from(await file.arrayBuffer())

    // ── Mode diagnostic : on utilise TOUJOURS le parser regex (rapide, fiable),
    //    juste pour dumper les lignes brutes et voir ce que le PDF contient.
    if (diagnostic) {
      const r = await parseCommandesPdf(buf)
      if (!r.success) return NextResponse.json({ erreur: r.erreur || 'Erreur extraction PDF' }, { status: 500 })
      return NextResponse.json({
        diagnostic: true,
        moteur: 'regex (diagnostic)',
        nb_lignes_brutes: r.rawLines.length,
        nb_commandes_parsees: r.commandes.length,
        rawText: r.rawLines.join('\n').slice(0, 8000),
        commandes: r.commandes,
        warnings: r.warnings,
      })
    }

    // ── Choix du moteur de parsing ──────────────────────────────
    let commandes: any[] = []
    let warnings: string[] = []
    let moteurUtilise = moteur
    let dureeMsIa: number | undefined

    if (moteur === 'regex') {
      const r = await parseCommandesPdf(buf)
      if (!r.success) return NextResponse.json({ erreur: r.erreur }, { status: 500 })
      commandes = r.commandes
      warnings = r.warnings
    } else {
      // Moteur IA (défaut) — envoie le PDF directement à Claude.
      // On wrappe par sécurité même si la fonction interne a déjà un try/catch.
      let r: Awaited<ReturnType<typeof parseCommandesPdfAvecIA>>
      try {
        r = await parseCommandesPdfAvecIA(buf)
      } catch (eIa: any) {
        r = { success: false, commandes: [], erreur: eIa.message || String(eIa) }
      }
      dureeMsIa = r.duree_ms
      if (r.success) {
        commandes = r.commandes
        moteurUtilise = 'ia'
      } else {
        warnings.push(`IA indisponible (${r.erreur}) — fallback regex`)
        const rg = await parseCommandesPdf(buf)
        if (!rg.success) {
          return NextResponse.json({
            erreur: `IA et regex ont échoué. IA: ${r.erreur}. Regex: ${rg.erreur}`,
            duree_ms_ia: dureeMsIa,
          }, { status: 500 })
        }
        commandes = rg.commandes
        warnings = warnings.concat(rg.warnings)
        moteurUtilise = 'regex (fallback)'
      }
    }

    if (commandes.length === 0) {
      return NextResponse.json({
        erreur: 'Aucune commande détectée dans le PDF',
        moteur: moteurUtilise,
        warnings,
        duree_ms_ia: dureeMsIa,
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
      duree_ms_ia: dureeMsIa,
      warnings,
    })
  } catch (e: any) {
    // Filet ultime : si quoi que ce soit a échappé aux catches internes,
    // on renvoie toujours du JSON (pas la page d'erreur HTML de Vercel).
    console.error('[commandes-attente/import] erreur non gérée :', e)
    return NextResponse.json({
      erreur: e?.message || String(e) || 'Erreur inconnue',
      stack: process.env.NODE_ENV === 'development' ? e?.stack : undefined,
    }, { status: 500 })
  }
}
