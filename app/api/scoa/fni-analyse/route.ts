import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateText } from 'ai'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

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
    const prenom = vendeur_nom.includes(',') ? vendeur_nom.split(',')[1].trim() : vendeur_nom

    const MOIS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
    const lblMois = (k: string) => {
      const m = /^(\d{4})-(\d{2})$/.exec(k)
      if (!m) return k
      return `${MOIS_FR[parseInt(m[2], 10) - 1]} ${m[1]}`
    }

    const prompt = `Tu analyses les chiffres FNI (Financement & Insurance) du vendeur ${vendeur_nom} dans un concessionnaire Mathias Marine Sports (motoneiges, motos, bateaux). Produis un coaching ACTIONNABLE et PRÉCIS.

PÉRIODE : ${filtDebut || 'début'} → ${filtFin || "aujourd'hui"}
CIBLE INTERNE : 9 % marge brute FNI (= Profit FNI ÷ Prix de Vente)

═══ KPIs DU VENDEUR ═══
- Unités vendues : ${kpiVendeur.nb}
- Prix de vente total : ${fmt$(kpiVendeur.prix)}
- Profit FNI total : ${fmt$(kpiVendeur.profit_fni)}
- % Marge FNI : ${fmtPc(kpiVendeur.marge_fni)}
- Attach FNI (% deals avec FNI) : ${fmtPc(kpiVendeur.attach)}
- FNI / unité (moyenne) : ${fmt$(kpiVendeur.fni_par_u)}
- % Cash deals : ${fmtPc(kpiVendeur.pct_cash)}

═══ MOYENNE DU GROUPE (toute l'équipe, ${kpiGroupe.nb} ventes) ═══
- % Marge FNI : ${fmtPc(kpiGroupe.marge_fni)}
- Attach FNI : ${fmtPc(kpiGroupe.attach)}
- FNI / unité : ${fmt$(kpiGroupe.fni_par_u)}
- % Cash deals : ${fmtPc(kpiGroupe.pct_cash)}

═══ PERFORMANCE PAR MARQUE (vendeur) ═══
${vendorParMarque.map(m =>
  `- ${m.marque} : ${m.nb} u · profit FNI ${fmt$(m.profit_fni)} · marge ${fmtPc(m.marge_fni)} · attach ${fmtPc(m.attach)} · FNI/u ${fmt$(m.fni_par_u)}`
).join('\n')}

═══ MANQUE À GAGNER PAR MARQUE (vs le meilleur de l'équipe) ═══
${manques.filter(m => m.manque > 0).sort((a, b) => b.manque - a.manque).slice(0, 6).map(m =>
  `- ${m.marque} : ton FNI/u = ${fmt$(m.mon_fni_u)} | ${m.best_vendeur.split(',')[1]?.trim() || m.best_vendeur} = ${fmt$(m.best_fni_u)} | écart ${fmt$(m.ecart)}/u sur ${m.nb} ventes → manque à gagner ${fmt$(m.manque)}`
).join('\n')}

MANQUE À GAGNER TOTAL : ${fmt$(manqueTotal)}

═══ TENDANCE MENSUELLE ═══
${mensuels.map(m =>
  `- ${lblMois(m.mois)} : ${m.nb} u · profit FNI ${fmt$(m.profit_fni)} · marge ${fmtPc(m.marge_fni)} · attach ${fmtPc(m.attach)} · cash ${fmtPc(m.pct_cash)}`
).join('\n')}

TÂCHE :
Produis un coaching SYNTHÉTIQUE et ACTIONNABLE (≤ 350 mots) en français québécois professionnel.
Tutoie ${prenom}. Chiffres précis, jamais d'approximations vagues type « beaucoup » ou « peu ».

Structure ta réponse EXACTEMENT en 4 sections :

🟢 **TES POINTS FORTS**
2-3 bullets sur les marques / mois où ${prenom} excelle vs le groupe (avec chiffres).

🔴 **TES POINTS À TRAVAILLER**
2-3 bullets sur où ${prenom} perd des dollars (avec écart vs meilleur ou vs groupe, en $).

🎯 **ACTIONS CONCRÈTES CETTE SEMAINE**
3 actions précises et opérationnelles (pas du blabla type « améliorer », mais des verbes comme « pousser », « scripter », « reformer », « cibler tel client »).

💰 **POTENTIEL DE GAIN**
Estimation $ si les 3 actions sont appliquées (base-toi sur le manque à gagner total ${fmt$(manqueTotal)} et identifie ce qui est réaliste à rattraper).

Ton : ferme mais bienveillant, comme un coach pro. Pas de phrase d'introduction ni de conclusion.`

    const t0 = Date.now()
    const { text } = await generateText({
      model: 'anthropic/claude-sonnet-4.5',
      system: 'Tu es un coach expert F&I (Financement & Insurance) dans un concessionnaire de véhicules récréatifs au Québec. Tu donnes un coaching factuel basé sur des chiffres précis, en français québécois professionnel.',
      prompt,
      temperature: 0.4,
    })
    const dureeMs = Date.now() - t0

    return NextResponse.json({
      analyse: text,
      manque_total: manqueTotal,
      duree_ms: dureeMs,
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
