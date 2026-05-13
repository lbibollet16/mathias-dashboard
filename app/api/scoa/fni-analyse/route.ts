import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateText } from 'ai'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

// GET ?vendeur_nom=... — récupère l'analyse sauvegardée si existante
export async function GET(req: NextRequest) {
  try {
    const vendeur_nom = new URL(req.url).searchParams.get('vendeur_nom')
    if (!vendeur_nom) return NextResponse.json({ erreur: 'vendeur_nom requis' }, { status: 400 })

    const { data, error } = await supabaseAdmin
      .from('scoa_fni_analyses')
      .select('*')
      .eq('vendeur_nom', vendeur_nom)
      .maybeSingle()

    if (error) throw error
    if (!data) return NextResponse.json({ analyse: null })

    return NextResponse.json({
      analyse: data.analyse,
      manque_total: Number(data.manque_total || 0),
      duree_ms: data.duree_ms || 0,
      generee_le: data.generee_le,
      date_debut: data.date_debut,
      date_fin: data.date_fin,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}

// POST /api/scoa/fni-analyse
// body: { vendeur_nom: string, filtDebut?: string, filtFin?: string }
//
// Calcule les KPIs détaillés du vendeur + groupe + par marque + mensuel +
// manque à gagner par marque, puis demande à Claude un coaching synthétique
// et actionnable.
export async function POST(req: NextRequest) {
  try {
    const { vendeur_nom, filtDebut, filtFin } = await req.json()
    if (!vendeur_nom) return NextResponse.json({ erreur: 'vendeur_nom requis' }, { status: 400 })

    // Données du vendeur
    let q = supabaseAdmin.from('scoa_ventes').select('*').eq('vendeur_nom', vendeur_nom)
    if (filtDebut) q = q.gte('date_vente', filtDebut)
    if (filtFin) q = q.lte('date_vente', filtFin)
    const { data: ventesVendeur, error } = await q
    if (error) throw error
    if (!ventesVendeur || ventesVendeur.length === 0) {
      return NextResponse.json({ erreur: `Aucune vente trouvée pour ${vendeur_nom}` }, { status: 404 })
    }

    // Données du groupe (toutes ventes)
    let q2 = supabaseAdmin.from('scoa_ventes').select('*')
    if (filtDebut) q2 = q2.gte('date_vente', filtDebut)
    if (filtFin) q2 = q2.lte('date_vente', filtFin)
    const { data: allVentes } = await q2

    const agrege = (vs: any[]) => {
      const t = vs.reduce((a, v) => ({
        nb: a.nb + 1,
        prix: a.prix + Number(v.prix_vente || 0),
        profit_fni: a.profit_fni + Number(v.profit_fni || 0),
        ventes_fni: a.ventes_fni + Number(v.ventes_fni || 0),
        nb_avec_fni: a.nb_avec_fni + (Math.abs(Number(v.profit_fni || 0)) > 0.01 ? 1 : 0),
      }), { nb: 0, prix: 0, profit_fni: 0, ventes_fni: 0, nb_avec_fni: 0 })
      return {
        ...t,
        marge_fni: t.prix > 0 ? t.profit_fni / t.prix : 0,
        attach:    t.nb > 0 ? t.nb_avec_fni / t.nb : 0,
        fni_par_u: t.nb > 0 ? t.profit_fni / t.nb : 0,
        pct_cash:  t.nb > 0 ? (t.nb - t.nb_avec_fni) / t.nb : 0,
      }
    }

    const kpiVendeur = agrege(ventesVendeur)
    const kpiGroupe  = agrege(allVentes || [])

    // Performance par marque (vendeur)
    const parMarqueV = new Map<string, any[]>()
    for (const v of ventesVendeur) {
      const k = v.marque || 'Inconnue'
      if (!parMarqueV.has(k)) parMarqueV.set(k, [])
      parMarqueV.get(k)!.push(v)
    }
    const vendorParMarque = [...parMarqueV.entries()]
      .map(([m, vs]) => ({ marque: m, ...agrege(vs) }))
      .sort((a, b) => b.nb - a.nb)

    // Best vendeur par marque (FNI/u le plus élevé)
    const parMarqueAll = new Map<string, Map<string, any[]>>()
    for (const v of allVentes || []) {
      const km = v.marque || 'Inconnue'
      const kv = v.vendeur_nom || ''
      if (!parMarqueAll.has(km)) parMarqueAll.set(km, new Map())
      const inner = parMarqueAll.get(km)!
      if (!inner.has(kv)) inner.set(kv, [])
      inner.get(kv)!.push(v)
    }
    const bestParMarque = new Map<string, { vendeur: string, fni_u: number, marge: number, nb: number }>()
    for (const [marque, vendorMap] of parMarqueAll) {
      let bestV = '', bestF = -Infinity, bestMarge = 0, bestN = 0
      for (const [vn, vs] of vendorMap) {
        const t = agrege(vs)
        if (t.fni_par_u > bestF) {
          bestF = t.fni_par_u; bestV = vn; bestMarge = t.marge_fni; bestN = t.nb
        }
      }
      bestParMarque.set(marque, { vendeur: bestV, fni_u: bestF, marge: bestMarge, nb: bestN })
    }

    // Manque à gagner par marque
    const manques = vendorParMarque.map(vm => {
      const best = bestParMarque.get(vm.marque)
      if (!best || best.vendeur === vendeur_nom) {
        return { marque: vm.marque, nb: vm.nb, mon_fni_u: vm.fni_par_u, best_vendeur: vendeur_nom, best_fni_u: vm.fni_par_u, ecart: 0, manque: 0 }
      }
      const manque = Math.max(0, vm.nb * (best.fni_u - vm.fni_par_u))
      return { marque: vm.marque, nb: vm.nb, mon_fni_u: vm.fni_par_u, best_vendeur: best.vendeur, best_fni_u: best.fni_u, ecart: best.fni_u - vm.fni_par_u, manque }
    })
    const manqueTotal = manques.reduce((s, m) => s + m.manque, 0)

    // Mensuel
    const parMois = new Map<string, any[]>()
    for (const v of ventesVendeur) {
      const k = String(v.date_vente).slice(0, 7)
      if (!parMois.has(k)) parMois.set(k, [])
      parMois.get(k)!.push(v)
    }
    const mensuels = [...parMois.entries()]
      .map(([m, vs]) => ({ mois: m, ...agrege(vs) }))
      .sort((a, b) => a.mois.localeCompare(b.mois))

    // Format pour le prompt
    const fmt$  = (n: number) => '$' + Math.round(n).toLocaleString('fr-CA')
    const fmtPc = (n: number) => (n * 100).toFixed(1).replace('.', ',') + ' %'

    const MOIS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
    const lblMois = (k: string) => {
      const m = /^(\d{4})-(\d{2})$/.exec(k)
      if (!m) return k
      return `${MOIS_FR[parseInt(m[2], 10) - 1]} ${m[1]}`
    }

    // Classement par volume — pour situer le vendeur dans l'équipe
    const parVendeurVol = new Map<string, any[]>()
    for (const v of allVentes || []) {
      const k = v.vendeur_nom || '(?)'
      if (!parVendeurVol.has(k)) parVendeurVol.set(k, [])
      parVendeurVol.get(k)!.push(v)
    }
    const classementVol = [...parVendeurVol.entries()]
      .map(([nom, vs]) => ({ nom, ...agrege(vs) }))
      .sort((a, b) => b.nb - a.nb)
    const rangVol   = classementVol.findIndex(x => x.nom === vendeur_nom) + 1
    const rangMarge = [...classementVol].sort((a, b) => b.marge_fni - a.marge_fni).findIndex(x => x.nom === vendeur_nom) + 1
    const rangFniU  = [...classementVol].sort((a, b) => b.fni_par_u - a.fni_par_u).findIndex(x => x.nom === vendeur_nom) + 1

    const prompt = `Tu es un manager senior F&I qui prépare une note d'analyse interne sur la performance d'un de tes vendeurs : ${vendeur_nom}.
Cette note te sert à TOI (le manager) pour identifier les lacunes et l'aider à progresser. Tu parles donc DE ${vendeur_nom}, pas À ${vendeur_nom}.

PÉRIODE : ${filtDebut || 'début'} → ${filtFin || "aujourd'hui"}
CIBLE INTERNE : 9 % marge brute FNI (= Profit FNI ÷ Prix de Vente)

═══ POSITIONNEMENT DANS L'ÉQUIPE (${classementVol.length} vendeurs au total) ═══
- Volume : ${rangVol}e (${kpiVendeur.nb} ventes)
- % Marge FNI : ${rangMarge}e (${fmtPc(kpiVendeur.marge_fni)})
- FNI / unité : ${rangFniU}e (${fmt$(kpiVendeur.fni_par_u)})

═══ COMPARATIF VOLUMES ENTRE TOUS LES VENDEURS ═══
${classementVol.map((c, i) =>
  `${i+1}. ${c.nom} : ${c.nb} ventes · profit FNI ${fmt$(c.profit_fni)} · marge ${fmtPc(c.marge_fni)} · attach ${fmtPc(c.attach)} · FNI/u ${fmt$(c.fni_par_u)}`
).join('\n')}

═══ KPIs DE ${vendeur_nom} ═══
- Unités vendues : ${kpiVendeur.nb}
- Prix de vente total : ${fmt$(kpiVendeur.prix)}
- Profit FNI total : ${fmt$(kpiVendeur.profit_fni)}
- % Marge FNI : ${fmtPc(kpiVendeur.marge_fni)} (cible 9 %, moyenne équipe ${fmtPc(kpiGroupe.marge_fni)})
- Attach FNI : ${fmtPc(kpiVendeur.attach)} (équipe ${fmtPc(kpiGroupe.attach)})
- FNI / unité : ${fmt$(kpiVendeur.fni_par_u)} (équipe ${fmt$(kpiGroupe.fni_par_u)})
- % Cash deals : ${fmtPc(kpiVendeur.pct_cash)} (équipe ${fmtPc(kpiGroupe.pct_cash)})

═══ PAR MARQUE ═══
${vendorParMarque.map(m =>
  `- ${m.marque} : ${m.nb} u · profit FNI ${fmt$(m.profit_fni)} · marge ${fmtPc(m.marge_fni)} · attach ${fmtPc(m.attach)} · FNI/u ${fmt$(m.fni_par_u)}`
).join('\n')}

═══ MANQUE À GAGNER PAR MARQUE (vs meilleur de l'équipe) ═══
${manques.filter(m => m.manque > 0).sort((a, b) => b.manque - a.manque).slice(0, 6).map(m =>
  `- ${m.marque} : son FNI/u = ${fmt$(m.mon_fni_u)} | ${m.best_vendeur.split(',')[1]?.trim() || m.best_vendeur} fait ${fmt$(m.best_fni_u)}/u sur ${bestParMarque.get(m.marque)?.nb || 0} ventes → manque à gagner ${fmt$(m.manque)} sur ses ${m.nb} ventes`
).join('\n')}

MANQUE À GAGNER TOTAL : ${fmt$(manqueTotal)}

═══ TENDANCE MENSUELLE ═══
${mensuels.map(m =>
  `- ${lblMois(m.mois)} : ${m.nb} u · profit FNI ${fmt$(m.profit_fni)} · marge ${fmtPc(m.marge_fni)} · attach ${fmtPc(m.attach)} · cash ${fmtPc(m.pct_cash)}`
).join('\n')}

TÂCHE :
Rédige une NOTE D'ANALYSE INTERNE en français québécois professionnel, en MAX 200 mots.
Phrases courtes et percutantes (style note de manager, pas paragraphe).
Parle de ${vendeur_nom} à la 3e personne (« il/elle fait », pas « tu fais »).
Chiffres précis partout, jamais de mots flous comme « peu », « beaucoup », « bien ».

Structure ta réponse EXACTEMENT en 4 sections courtes :

📍 **POSITIONNEMENT**
1-2 phrases : où il/elle se situe (volume, marge, FNI/u) — chiffres + rang.

🟢 **FORCES** (2 bullets max)
Marques / mois où il/elle dépasse le groupe, avec chiffre d'écart.

🔴 **LACUNES** (3 bullets max)
Où il/elle perd des dollars vs équipe ou vs meilleur, avec montant chiffré du manque.

🎯 **PISTES POUR L'AIDER** (3 bullets max)
Actions du MANAGER pour l'accompagner (formation, shadowing, script, jumelage avec un meilleur, etc.). Pas d'actions vagues — verbes concrets.

Pas d'introduction ni de conclusion. Démarre direct par 📍.`

    const t0 = Date.now()
    const { text } = await generateText({
      model: 'anthropic/claude-sonnet-4.5',
      system: 'Tu es un manager F&I (Financement & Insurance) senior d\'un concessionnaire de véhicules récréatifs au Québec (Mathias Marine Sports). Tu rédiges des notes d\'analyse interne courtes pour évaluer tes vendeurs et identifier les leviers de progression. Tu écris en français québécois professionnel, phrases courtes et percutantes, chiffres précis. Tu parles DES vendeurs (3e personne), jamais à eux directement.',
      prompt,
      temperature: 0.3,
    })
    const dureeMs = Date.now() - t0

    // Persister l'analyse (1 seule entry par vendeur, on remplace la précédente)
    const { error: errSave } = await supabaseAdmin
      .from('scoa_fni_analyses')
      .upsert({
        vendeur_nom,
        analyse: text,
        manque_total: manqueTotal,
        date_debut: filtDebut || null,
        date_fin: filtFin || null,
        duree_ms: dureeMs,
        generee_le: new Date().toISOString(),
      }, { onConflict: 'vendeur_nom' })
    if (errSave) console.error('[fni-analyse] sauvegarde échouée :', errSave)

    return NextResponse.json({
      analyse: text,
      manque_total: manqueTotal,
      duree_ms: dureeMs,
      generee_le: new Date().toISOString(),
      stats: {
        ventes_vendeur: kpiVendeur.nb,
        ventes_groupe: kpiGroupe.nb,
        marques: vendorParMarque.length,
        mois: mensuels.length,
      },
    })
  } catch (e: any) {
    console.error('[fni-analyse]', e)
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
