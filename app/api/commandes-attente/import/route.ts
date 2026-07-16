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

// Nombre de jours pendant lesquels on garde une ligne désactivée (= pièce
// reçue/fermée) avant de la supprimer définitivement.
const RETENTION_JOURS = 90

// Supprime les lignes inactives depuis plus de RETENTION_JOURS qui ne portent
// aucune saisie humaine. Retourne le nombre de lignes supprimées.
//
// On sélectionne puis on supprime par id plutôt que de filtrer directement
// dans le DELETE : ça permet d'écarter aussi les chaînes vides laissées par
// d'anciennes versions du PATCH (aujourd'hui il écrit `null`), que `.is(null)`
// ne verrait pas — et donc de ne jamais purger une ligne annotée.
async function purgerInactives(): Promise<number> {
  const seuil = new Date(Date.now() - RETENTION_JOURS * 86400000).toISOString()

  const candidats: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from('commandes_attente')
      .select('id, remarque, plan_action, date_bo')
      .eq('active', false)
      .lt('date_dernier_import', seuil)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    if (!data || data.length === 0) break
    candidats.push(...data)
    if (data.length < 1000) break
  }

  const aSupprimer = candidats
    .filter(r => !String(r.remarque ?? '').trim()
              && !String(r.plan_action ?? '').trim()
              && !r.date_bo)
    .map(r => r.id)

  let purged = 0
  for (let i = 0; i < aSupprimer.length; i += 500) {
    const batch = aSupprimer.slice(i, i + 500)
    const { error } = await supabaseAdmin
      .from('commandes_attente')
      .delete()
      .in('id', batch)
    if (error) throw error
    purged += batch.length
  }
  return purged
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null
    const diagnostic = String(form.get('diagnostic') || '') === '1'
    // Filtre diagnostic : si fourni, ne renvoie que les lignes brutes autour
    // de cette commande précise (utile pour debug "il manque des pièces sur
    // M1C00XXX" quand le dump complet dépasse 8000 char).
    const cmdFilter = String(form.get('cmd') || '').trim().toUpperCase()
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

      // Si l'utilisateur a demandé une commande précise, on extrait juste son
      // bloc dans le texte brut + on filtre les warnings + on garde uniquement
      // ses pièces parsées. Sinon comportement classique : dump 8000 char.
      let rawText: string
      let commandesFiltrees = r.commandes
      let warningsFiltres = r.warnings
      if (cmdFilter) {
        // Trouver l'index de la ligne qui contient cmdFilter (= header de la
        // commande) et tout extraire jusqu'au prochain header ou la fin.
        const idxStart = r.rawLines.findIndex(l => l.toUpperCase().startsWith(cmdFilter + ' '))
        if (idxStart < 0) {
          rawText = `(commande ${cmdFilter} introuvable dans le PDF)`
        } else {
          // Inclure les 4 lignes avant (en-tête colonne) et jusqu'à la prochaine
          // ligne qui commence par "X / Y" (= début de page suivante) ou la fin.
          const idxFin = r.rawLines.findIndex((l, i) => i > idxStart && /^\d+\s*\/\s*\d+$/.test(l.trim()))
          const fin = idxFin > 0 ? idxFin : r.rawLines.length
          const debut = Math.max(0, idxStart - 4)
          rawText = r.rawLines.slice(debut, fin).join('\n')
        }
        commandesFiltrees = r.commandes.filter(c => c.num_commande.toUpperCase() === cmdFilter)
        warningsFiltres = r.warnings.filter(w => w.toUpperCase().includes(cmdFilter))
      } else {
        rawText = r.rawLines.join('\n').slice(0, 8000)
      }

      return NextResponse.json({
        diagnostic: true,
        moteur: 'regex (diagnostic)',
        cmd_filter: cmdFilter || null,
        nb_lignes_brutes: r.rawLines.length,
        nb_commandes_parsees: r.commandes.length,
        rawText,
        commandes: commandesFiltrees,
        warnings: warningsFiltres,
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

    // Charger l'existant — PAGINÉ.
    // PostgREST/Supabase plafonne un select() sans range à 1000 lignes. Au-delà,
    // les lignes non chargées étaient vues comme absentes → INSERT sur une clé
    // déjà présente → violation de UNIQUE(num_commande, num_piece) → import KO.
    const existants: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error: errLoad } = await supabaseAdmin
        .from('commandes_attente')
        .select('id, num_commande, num_piece, statut, date_premiere_vue, active')
        .order('id', { ascending: true })
        .range(from, from + 999)
      if (errLoad) throw errLoad
      if (!data || data.length === 0) break
      existants.push(...data)
      if (data.length < 1000) break
    }

    const existMap = new Map<string, any>()
    for (const r of existants || []) {
      existMap.set(`${r.num_commande}__${r.num_piece}`, r)
    }

    const seenKeys = new Set<string>()
    // Dédoublonnage intra-PDF : une même paire (num_commande, num_piece) peut
    // apparaître plusieurs fois dans le même fichier. On indexe par clé pour
    // que la dernière occurrence écrase les précédentes — sinon deux INSERT
    // sur la même clé violeraient la contrainte UNIQUE(num_commande, num_piece).
    const insertByKey = new Map<string, any>()
    const updateById  = new Map<number, { id: number, patch: any }>()

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
        num_facture:     c.num_facture ?? null,
      }

      if (!ex) {
        insertByKey.set(key, {
          ...baseRow,
          date_premiere_vue:   now,
          date_dernier_import: now,
          active: true,
        })
      } else {
        const statutChange = ex.statut !== c.statut
        const wasInactive  = !ex.active
        updateById.set(ex.id, {
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

    const toInsert = Array.from(insertByKey.values())
    const toUpdate = Array.from(updateById.values())

    const toDeactivate: number[] = []
    for (const r of existants || []) {
      const key = `${r.num_commande}__${r.num_piece}`
      if (r.active && !seenKeys.has(key)) toDeactivate.push(r.id)
    }

    let inserted = 0, updated = 0, deactivated = 0

    for (let i = 0; i < toInsert.length; i += 500) {
      const batch = toInsert.slice(i, i + 500)
      // upsert plutôt qu'insert : filet de sécurité si une clé existait malgré
      // tout en base (course avec un autre import, ligne créée à la main…).
      const { error } = await supabaseAdmin
        .from('commandes_attente')
        .upsert(batch, { onConflict: 'num_commande,num_piece' })
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

    // ── Purge des lignes désactivées trop vieilles ────────────────
    // Sans purge la table grossit indéfiniment (~18 lignes/jour), alors qu'une
    // ligne désactivée = pièce reçue/fermée, donc de l'historique mort.
    //
    // Deux garde-fous :
    //   - on ne touche qu'aux lignes inactives depuis RETENTION_JOURS ;
    //   - on épargne celles portant une saisie humaine (remarque / plan
    //     d'action / date BO). commandes_attente_historique référence
    //     commandes_attente(id) ON DELETE CASCADE : supprimer la ligne
    //     effacerait aussi la trace de qui a écrit quoi et quand.
    //
    // date_dernier_import fige la date de désactivation : une ligne inactive
    // n'est plus jamais retouchée par les imports suivants.
    const purged = await purgerInactives()

    return NextResponse.json({
      success: true,
      moteur: moteurUtilise,
      inserted,
      updated,
      deactivated,
      purged,
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
