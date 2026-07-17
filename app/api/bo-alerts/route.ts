import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/bo-alerts
//
// Alertes « pièce en back-order » à afficher côté aviseur et commis pièces.
// Source : l'onglet Commandes en attente. Une ligne dont le plan d'action est
// « 🔁 BO » et qui porte une date_bo signale qu'une pièce d'un bon de travail
// (num_facture) est en back-order pour la date donnée.
//
// Retour : { alerts: { [num_facture]: [{ numPiece, description, dateBo, nomFournisseur }] } }
// Le client (dashboard aviseur / commis) matche ses bons/factures sur cette clé.

const PLAN_BO = '🔁 BO'

export async function GET() {
  try {
    // Chargement paginé (plafond PostgREST 1000).
    const lignes: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin
        .from('commandes_attente')
        .select('num_facture, num_piece, description, date_bo, nom_fournisseur, plan_action, active')
        .eq('plan_action', PLAN_BO)
        .eq('active', true)
        .not('date_bo', 'is', null)
        .not('num_facture', 'is', null)
        .order('id', { ascending: true })
        .range(from, from + 999)
      if (error) throw error
      if (!data || data.length === 0) break
      lignes.push(...data)
      if (data.length < 1000) break
    }

    const alerts: Record<string, any[]> = {}
    for (const l of lignes) {
      const key = String(l.num_facture)
      if (!alerts[key]) alerts[key] = []
      alerts[key].push({
        numPiece:       l.num_piece,
        description:    l.description,
        dateBo:        l.date_bo,
        nomFournisseur: l.nom_fournisseur,
      })
    }

    return NextResponse.json({ alerts, nbPieces: lignes.length, nbBons: Object.keys(alerts).length })
  } catch (e: any) {
    console.error('[bo-alerts] erreur :', e)
    return NextResponse.json({ erreur: e?.message || String(e), alerts: {} }, { status: 500 })
  }
}
