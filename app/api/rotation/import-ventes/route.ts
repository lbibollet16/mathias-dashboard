// Import mensuel du rapport Traction 2891 « Analyse de vente de pièces ».
//
// GET  ?apercu=1  n'est pas supporté (pas de fichier) — l'aperçu se fait en POST
//                 avec apercu=1 dans le formulaire : le fichier est parsé et les
//                 totaux renvoyés, SANS rien écrire en base.
// POST            importe le mois.
//
// L'import est IDEMPOTENT : ré-importer le même mois remplace ses lignes au lieu
// de les empiler. L'ancien /api/import-ventes faisait un insert sec, ce qui
// doublait la demande calculée à chaque ré-import.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parserVente2891 } from '@/lib/parser-vente-2891'
import { moisPrecedent, fenetreMois } from '@/lib/supply-chain'
import { insererParLots, lireTout } from '@/lib/supply-chain-db'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = (form.get('file') || form.get('data')) as File | null
    const mois = String(form.get('mois') || form.get('mois_annee') || '').trim()
    const apercu = String(form.get('apercu') || '') === '1'
    const userEmail = String(form.get('user_email') || '') || null

    if (!file) return NextResponse.json({ erreur: 'Aucun fichier reçu' }, { status: 400 })
    if (!/^\d{4}-\d{2}$/.test(mois)) {
      return NextResponse.json({ erreur: 'Mois requis au format YYYY-MM' }, { status: 400 })
    }
    const [an, mo] = mois.split('-').map(Number)
    if (mo < 1 || mo > 12 || an < 2000 || an > 2100) {
      return NextResponse.json({ erreur: `Mois hors plage : ${mois}` }, { status: 400 })
    }
    // Un mois futur ne peut pas être clos : c'est presque toujours une faute de
    // frappe qui polluerait la fenêtre de calcul.
    const moisCourant = new Date().toISOString().slice(0, 7)
    if (mois > moisCourant) {
      return NextResponse.json({ erreur: `${mois} est dans le futur (mois courant : ${moisCourant})` }, { status: 400 })
    }

    const buffer = await file.arrayBuffer()
    const r = parserVente2891(buffer)

    // Lignes déjà en base pour ce mois — sert au décompte « remplacé » et à la
    // purge des codes qui ne sont plus au rapport.
    const existant = await lireTout<any>('historique_ventes', 'id, code_piece', q => q.eq('mois', mois))
    const codesFichier = new Set(r.lignes.map(l => l.code))
    const aSupprimer = existant.filter(e => !codesFichier.has(e.code_piece)).map(e => e.id)

    const resume = {
      mois,
      fichier: file.name,
      nb_codes: r.totaux.nb_codes,
      nb_lignes_fichier: r.totaux.nb_lignes,
      quantite: r.totaux.quantite,
      revenus: r.totaux.revenus,
      couts: r.totaux.couts,
      profit: r.totaux.profit,
      marge_pct: r.totaux.revenus > 0 ? (r.totaux.profit / r.totaux.revenus) * 100 : 0,
      lignes_deja_en_base: existant.length,
      lignes_a_supprimer: aSupprimer.length,
      bloc2_ignore: r.totaux_bloc2,
      total_rapport: r.total_rapport,
      avertissements: r.avertissements,
    }

    if (apercu) {
      return NextResponse.json({
        apercu: true, resume,
        echantillon: r.lignes.slice(0, 10),
        note: existant.length > 0
          ? `${existant.length} lignes existent déjà pour ${mois} — elles seront remplacées.`
          : `Aucune donnée pour ${mois} : ce sera un premier import.`,
      })
    }

    // ── Écriture ────────────────────────────────────────────────────
    // Upsert sur (code_piece, mois) : l'index unique posé par la migration
    // rend le ré-import naturellement idempotent.
    const rows = r.lignes.map(l => ({
      code_piece: l.code,
      mois,
      quantite: l.quantite,
      revenus: l.revenus,
      profit: l.profit,
    }))

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin
        .from('historique_ventes')
        .upsert(rows.slice(i, i + 500), { onConflict: 'code_piece,mois' })
      if (error) throw new Error(`Écriture historique_ventes : ${error.message}`)
    }

    // Codes disparus du rapport : le mois est désormais décrit par ce fichier
    // seul, on ne laisse pas traîner des ventes d'un import précédent.
    for (let i = 0; i < aSupprimer.length; i += 200) {
      await supabaseAdmin.from('historique_ventes').delete().in('id', aSupprimer.slice(i, i + 200))
    }

    await supabaseAdmin.from('sc_imports_ventes').insert({
      mois,
      fichier: file.name,
      nb_lignes: rows.length,
      qte_totale: r.totaux.quantite,
      ca_total: r.totaux.revenus,
      cogs_total: r.totaux.couts,
      profit_total: r.totaux.profit,
      remplace: existant.length,
      importe_par: userEmail,
      avertissements: r.avertissements,
    })

    // Le mois importé change la demande, donc toute l'analyse : on relance.
    let recalcul = 'non lancé'
    try {
      const base = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin
      const res = await fetch(`${base}/api/rotation/recalculer?declencheur=import`, {
        method: 'POST', signal: AbortSignal.timeout(280_000),
      })
      recalcul = res.ok ? 'ok' : `échec HTTP ${res.status}`
    } catch (e: any) {
      recalcul = `échec : ${e.message}`
    }

    return NextResponse.json({
      success: true,
      resume,
      lignes_importees: rows.length,
      lignes_supprimees: aSupprimer.length,
      recalcul,
    })

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

/**
 * Liste des mois présents / manquants, pour guider l'utilisateur.
 *
 * Les trous ne se valent pas, et les confondre rend l'avertissement inutile :
 *
 *  · dans la FENÊTRE DE CALCUL (12 derniers mois) — c'est là que se calculent
 *    la demande, la saisonnalité, l'écart-type et donc le stock de sécurité.
 *    Un trou ici fausse tous les seuils ;
 *  · dans les 24 mois — sert à distinguer une pièce « dormante » (vue bouger
 *    récemment) d'une pièce « morte ». Un trou ici peut classer morte une pièce
 *    dont la seule vente tombait dans le mois manquant ;
 *  · plus ancien — n'entre dans aucun calcul. Bon à combler pour l'historique,
 *    mais ça ne change aucun chiffre affiché aujourd'hui.
 */
export async function GET() {
  try {
    const rows = await lireTout<any>('historique_ventes', 'mois')
    const presents = new Set(rows.map(r => r.mois))
    const tries = [...presents].sort()
    if (tries.length === 0) {
      return NextResponse.json({
        mois_presents: [], mois_manquants: [],
        manquants_fenetre: [], manquants_24m: [], manquants_anciens: [],
      })
    }

    const moisFin = moisPrecedent(new Date())
    const fenetre12 = fenetreMois(moisFin, 12)
    const fenetre24 = fenetreMois(moisFin, 24)

    // Trous entre le premier mois connu et le dernier mois clos.
    const manquants: string[] = []
    let [a, m] = tries[0].split('-').map(Number)
    while (true) {
      const cle = `${a}-${String(m).padStart(2, '0')}`
      if (cle > moisFin) break
      if (!presents.has(cle)) manquants.push(cle)
      m++; if (m > 12) { m = 1; a++ }
    }

    const { data: imports } = await supabaseAdmin
      .from('sc_imports_ventes').select('*').order('importe_le', { ascending: false }).limit(36)

    return NextResponse.json({
      mois_presents: tries,
      mois_manquants: manquants,
      manquants_fenetre: manquants.filter(x => fenetre12.includes(x)),
      manquants_24m: manquants.filter(x => fenetre24.includes(x) && !fenetre12.includes(x)),
      manquants_anciens: manquants.filter(x => !fenetre24.includes(x)),
      fenetre: { debut: fenetre12[0], fin: moisFin },
      couverture: `${fenetre12.filter(x => presents.has(x)).length}/12`,
      premier_mois: tries[0],
      dernier_mois: tries[tries.length - 1],
      imports: imports || [],
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
