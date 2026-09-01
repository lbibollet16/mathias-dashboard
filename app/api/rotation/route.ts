// Payload d'ouverture de l'onglet : KPIs, agrégats par fournisseur et par code
// de ligne, synthèse par agent, historique des snapshots. Tout vient du dernier
// run pré-calculé — aucun appel à Traction ici, l'écran s'ouvre instantanément.

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { dernierRun, lireTout, chargerConfig } from '@/lib/supply-chain-db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const run = await dernierRun()
    const [cfg, snapshots, imports, receptions] = await Promise.all([
      chargerConfig(),
      supabaseAdmin.from('sc_snapshots').select('*').order('mois', { ascending: true }),
      supabaseAdmin.from('sc_imports_ventes').select('*').order('mois', { ascending: false }).limit(36),
      supabaseAdmin.from('sc_receptions')
        .select('id', { count: 'exact', head: true })
        .eq('alerte', true).eq('statut', 'nouveau'),
    ])

    if (!run) {
      return NextResponse.json({
        pret: false,
        message: 'Aucune analyse calculée. Lance un premier recalcul depuis l\'onglet.',
        config: cfg,
        snapshots: snapshots.data || [],
        imports: imports.data || [],
        groupes: [], findings_par_agent: [], kpis: {},
        nb_receptions_nouvelles: receptions.count || 0,
      })
    }

    const groupes = await lireTout<any>('sc_analyse_groupes', '*', q => q.eq('run_id', run.run_id))

    // Synthèse par agent : combien de constats, quel argent en jeu, et le
    // constat le plus lourd — de quoi remplir les cartes d'en-tête sans
    // descendre toute la liste.
    const findings = await lireTout<any>(
      'sc_findings', 'agent, severite, impact_dollars, titre, rang',
      q => q.eq('run_id', run.run_id).order('rang', { ascending: true }))

    const parAgent = new Map<string, any>()
    for (const f of findings) {
      const e = parAgent.get(f.agent) || {
        agent: f.agent, nb: 0, nb_critique: 0, nb_attention: 0,
        impact: 0, titre_principal: f.titre,
      }
      e.nb++
      if (f.severite === 'critique') e.nb_critique++
      if (f.severite === 'attention') e.nb_attention++
      e.impact += Number(f.impact_dollars) || 0
      parAgent.set(f.agent, e)
    }

    return NextResponse.json({
      pret: true,
      run: {
        run_id: run.run_id, termine_le: run.termine_le, duree_ms: run.duree_ms,
        declencheur: run.declencheur, nb_pieces: run.nb_pieces, log: run.log,
      },
      kpis: run.kpis || {},
      config: cfg,
      groupes,
      findings_par_agent: [...parAgent.values()].sort((a, b) => b.impact - a.impact),
      snapshots: snapshots.data || [],
      imports: imports.data || [],
      nb_receptions_nouvelles: receptions.count || 0,
    })

  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
