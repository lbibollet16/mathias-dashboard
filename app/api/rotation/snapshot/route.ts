// Snapshot mensuel — le « print » d'inventaire du 1er du mois.
//
// Appelé par le cron Vercel le 1er de chaque mois. Photographie l'inventaire
// Traction pièce par pièce, avec son fournisseur et son code de ligne figés à
// cette date, et l'archive définitivement.
//
// Pourquoi c'est indispensable : la rotation d'inventaire se calcule
// « coût des ventes ÷ stock MOYEN de la période ». Sans série de photos
// mensuelles, on ne connaît que le stock d'aujourd'hui — et une réception de la
// veille suffit à faire mentir le chiffre. Chaque photo ajoute un point à la
// moyenne ; au bout de 12 mois, le roulement est exact.
//
// Convention de nommage : le snapshot pris le 1er septembre porte le mois
// « 2026-08 », parce qu'il photographie la CLÔTURE d'août.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { moisPrecedent } from '@/lib/supply-chain'
import { chargerConfig, chargerTraction, insererParLots } from '@/lib/supply-chain-db'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) { return POST(req) }

export async function POST(req: NextRequest) {
  const log: string[] = []
  const debut = Date.now()

  try {
    const params = new URL(req.url).searchParams
    const mois = params.get('mois') || moisPrecedent(new Date())
    const force = params.get('force') === '1'
    const source = params.get('source') === 'manuel' ? 'manuel' : 'cron'

    if (!/^\d{4}-\d{2}$/.test(mois)) {
      return NextResponse.json({ erreur: `Mois invalide : ${mois} (format attendu YYYY-MM)` }, { status: 400 })
    }

    // Idempotence : le cron peut être rejoué, l'utilisateur peut recliquer.
    const { data: existant } = await supabaseAdmin
      .from('sc_snapshots').select('*').eq('mois', mois).maybeSingle()
    if (existant && !force) {
      return NextResponse.json({
        success: true, deja_fait: true, mois,
        message: `Snapshot ${mois} déjà archivé le ${existant.date_snapshot} `
          + `(${existant.nb_pieces} pièces, ${Math.round(existant.valeur_totale)} $). `
          + `Ajouter ?force=1 pour le refaire.`,
        snapshot: existant,
      })
    }

    // Garde-fou anti-troncature : on compare au dernier snapshot connu. Un feed
    // Traction partiel archiverait un inventaire amputé — et une archive est
    // par nature ce qu'on ne pourra plus recalculer.
    const { data: dernier } = await supabaseAdmin
      .from('sc_snapshots').select('nb_pieces').neq('mois', mois)
      .order('mois', { ascending: false }).limit(1).maybeSingle()

    // Même exclusion que l'analyse : les lignes Amazon ne doivent pas entrer
    // dans l'archive non plus, sinon le stock moyen des snapshots ne serait pas
    // comparable au coût des ventes et la rotation repartirait de travers.
    const cfg = await chargerConfig()
    const { pieces: traction, exclusion } = await chargerTraction(0, cfg.lignes_hors_perimetre)
    log.push(`Feed Traction : ${traction.size} pièces retenues au catalogue`)
    if (exclusion.nb_catalogue > 0) {
      log.push(`${exclusion.nb_catalogue} références écartées (${exclusion.lignes.join(', ')}) : `
        + `${exclusion.nb_en_stock} en stock pour ${Math.round(exclusion.valeur).toLocaleString('fr-CA')} $ `
        + `— suivies dans le module Amazon, hors de cette archive`)
    }

    // Une pièce à stock nul n'a pas sa place dans un inventaire ; une pièce à
    // stock négatif, si — c'est un écart à documenter, et l'exclure fausserait
    // la valeur totale archivée.
    const lignes: any[] = []
    for (const p of traction.values()) {
      if (p.qty === 0) continue
      lignes.push({
        mois,
        code_piece: p.pk,
        description: p.desc,
        id_fournisseur: p.idFournisseur || null,
        fournisseur: p.fournisseur,
        code_ligne: p.codeLigne,
        qty: p.qty,
        qty_dispo: p.qtyDispo,
        qte_reserve: p.qteReserve,
        qte_transit: p.qteTransit,
        qte_commande: p.qteCommande,
        cout_unitaire: p.cout,
        valeur: p.qty * p.cout,
        localisation: p.localisation || null,
      })
    }

    if (dernier?.nb_pieces && lignes.length < 0.7 * dernier.nb_pieces) {
      throw new Error(
        `Snapshot annulé : ${lignes.length} pièces en stock vs ${dernier.nb_pieces} au snapshot précédent ` +
        `(< 70 %). Feed Traction probablement tronqué — mieux vaut pas d'archive qu'une archive fausse.`)
    }

    const valeurTotale = lignes.reduce((s, l) => s + l.valeur, 0)
    const qteTotale = lignes.reduce((s, l) => s + l.qty, 0)
    const fournisseurs = new Set(lignes.map(l => l.fournisseur))
    log.push(`${lignes.length} pièces en stock, ${fournisseurs.size} fournisseurs, ${Math.round(valeurTotale)} $`)

    // Agrégats par fournisseur et par code de ligne — lus ensuite à chaque
    // calcul de rotation, sans relire les 18 000 lignes de détail.
    const agreger = (dimension: 'fournisseur' | 'ligne', champ: 'fournisseur' | 'code_ligne') => {
      const m = new Map<string, { nb: number; qte: number; val: number }>()
      for (const l of lignes) {
        const cle = l[champ]
        const e = m.get(cle) || { nb: 0, qte: 0, val: 0 }
        e.nb++; e.qte += l.qty; e.val += l.valeur
        m.set(cle, e)
      }
      return [...m.entries()].map(([cle, e]) => ({
        mois, dimension, cle, nb_pieces: e.nb, qte_totale: e.qte, valeur_totale: e.val,
      }))
    }
    const agregats = [...agreger('fournisseur', 'fournisseur'), ...agreger('ligne', 'code_ligne')]

    // Ré-exécution : on repart d'une archive propre pour ce mois.
    if (existant) {
      await supabaseAdmin.from('sc_snapshot_lignes').delete().eq('mois', mois)
      await supabaseAdmin.from('sc_snapshot_agregats').delete().eq('mois', mois)
      await supabaseAdmin.from('sc_snapshots').delete().eq('mois', mois)
      log.push(`Ancien snapshot ${mois} remplacé`)
    }

    const { error: errEntete } = await supabaseAdmin.from('sc_snapshots').insert({
      mois,
      date_snapshot: new Date().toISOString().split('T')[0],
      source,
      nb_pieces: lignes.length,
      nb_fournisseurs: fournisseurs.size,
      qte_totale: qteTotale,
      valeur_totale: valeurTotale,
      log,
    })
    if (errEntete) throw new Error(`En-tête snapshot : ${errEntete.message}`)

    await insererParLots('sc_snapshot_lignes', lignes, 500)
    await insererParLots('sc_snapshot_agregats', agregats, 500)
    log.push(`${agregats.length} agrégats écrits`)

    // Le snapshot change le stock moyen, donc la rotation : on enchaîne le
    // recalcul. En échec, le snapshot reste valide — il sera repris au prochain
    // recalcul quotidien.
    let recalcul = 'non lancé'
    try {
      const base = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin
      const r = await fetch(`${base}/api/rotation/recalculer?declencheur=cron`, {
        method: 'POST', signal: AbortSignal.timeout(280_000),
      })
      recalcul = r.ok ? 'ok' : `échec HTTP ${r.status}`
    } catch (e: any) {
      recalcul = `échec : ${e.message}`
    }
    log.push(`Recalcul de l'analyse : ${recalcul}`)

    return NextResponse.json({
      success: true, mois, duree_ms: Date.now() - debut,
      stats: {
        pieces: lignes.length, fournisseurs: fournisseurs.size,
        qte_totale: qteTotale, valeur_totale: valeurTotale,
      },
      exclusion,
      recalcul, log,
    })

  } catch (e: any) {
    return NextResponse.json({ success: false, erreur: e.message, log }, { status: 500 })
  }
}
