import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

// GET /api/erp/audit-comptabilite
// Passe en revue TOUS les comptages avec statut='reconcilie' et ecart_reconcilie != 0
// (= ce qui apparait en Comptabilité). Pour chacun :
//   - Récupère le stock actuel (stock_aujourdhui)
//   - Calcule l'écart ACTUEL (stock_actuel - qte_comptee)
//   - Classifie le cas :
//       * RÉSOLU       : écart actuel = 0 (déjà OK, devrait auto-résoudre au prochain sync)
//       * SYS_TROP_HAUT: stock > comptage (probable réception entre temps)
//       * SYS_TROP_BAS : stock < comptage (vraie discordance à investiguer)
//       * SANS_STOCK   : pièce absente de stock_aujourdhui (= disparue de Traction)
export async function GET() {
  try {
    // 1) Tous les comptages en statut reconcilie avec écart non nul
    const { data: comptages } = await supabaseAdmin
      .from('inventaire_comptages')
      .select('id, code_piece, localisation, qte_comptee, qte_systeme, qte_reservee, ecart, ecart_reconcilie, employe, date_comptage, date_reconciliation, statut')
      .eq('statut', 'reconcilie')
      .neq('ecart_reconcilie', 0)
      .order('date_comptage', { ascending: false })

    // 2) Tous les stocks actuels
    const codesUniques = [...new Set((comptages || []).map(c => c.code_piece))]
    const stockMap = new Map<string, { dispo: number, total: number }>()
    if (codesUniques.length > 0) {
      for (let i = 0; i < codesUniques.length; i += 500) {
        const slice = codesUniques.slice(i, i + 500)
        const { data: stocks } = await supabaseAdmin
          .from('stock_aujourdhui')
          .select('code_piece, quantite, qty_total')
          .in('code_piece', slice)
        for (const s of stocks || []) {
          stockMap.set(s.code_piece, {
            dispo: Number(s.quantite),
            total: Number(s.qty_total || s.quantite),
          })
        }
      }
    }

    // 3) Vérifier si validations comptables existent
    const { data: validations } = await supabaseAdmin
      .from('validations_comptables')
      .select('source, ref_id')
      .eq('source', 'comptage')
    const validesIds = new Set((validations || []).map(v => v.ref_id))

    // 4) Vérifier si retours comptables actifs
    const { data: retours } = await supabaseAdmin
      .from('comptabilite_retours')
      .select('source, ref_id')
      .eq('source', 'comptage')
      .is('corrige_le', null)
    const retournesIds = new Set((retours || []).map(r => r.ref_id))

    // 5) Classifier chaque comptage
    type Categorie = 'RESOLU' | 'SYS_TROP_HAUT' | 'SYS_TROP_BAS' | 'SANS_STOCK'
    const lignes: any[] = []
    const stats: Record<Categorie, number> = {
      RESOLU: 0, SYS_TROP_HAUT: 0, SYS_TROP_BAS: 0, SANS_STOCK: 0,
    }

    for (const c of comptages || []) {
      const stock = stockMap.get(c.code_piece)
      const stockAct = stock ? stock.total : null

      let cat: Categorie
      let diagnostic: string
      if (stockAct === null) {
        cat = 'SANS_STOCK'
        diagnostic = `La pièce a disparu de Traction (absente de stock_aujourdhui). À investiguer.`
      } else if (stockAct === Number(c.qte_comptee || 0)) {
        cat = 'RESOLU'
        diagnostic = `Stock actuel (${stockAct}) = quantité comptée (${c.qte_comptee}). Devrait auto-résoudre au prochain sync.`
      } else if (stockAct > Number(c.qte_comptee || 0)) {
        cat = 'SYS_TROP_HAUT'
        const diff = stockAct - Number(c.qte_comptee || 0)
        diagnostic = `Système actuel (${stockAct}) > comptage (${c.qte_comptee}) de +${diff}. Probable réception entre le ${String(c.date_comptage).slice(0,10)} et aujourd'hui, OU comptage initial incomplet.`
      } else {
        cat = 'SYS_TROP_BAS'
        const diff = Number(c.qte_comptee || 0) - stockAct
        diagnostic = `Système actuel (${stockAct}) < comptage (${c.qte_comptee}) de −${diff}. Vraie discordance : Kim a vu plus que ce que le système indique encore aujourd'hui.`
      }
      stats[cat]++

      lignes.push({
        code_piece: c.code_piece,
        localisation: c.localisation,
        date_comptage: String(c.date_comptage).slice(0, 10),
        employe: c.employe,
        qte_comptee: Number(c.qte_comptee || 0),
        qte_systeme_au_comptage: Number(c.qte_systeme || 0),
        ecart_au_comptage: Number(c.ecart_reconcilie || 0),
        stock_aujourdhui: stockAct,
        ecart_actuel: stockAct !== null ? stockAct - Number(c.qte_comptee || 0) : null,
        categorie: cat,
        diagnostic,
        validee_manuellement: validesIds.has(c.id),
        retour_actif: retournesIds.has(c.id),
        visible_en_comptabilite: !validesIds.has(c.id) && !retournesIds.has(c.id),
      })
    }

    // Trier par catégorie puis par date
    const ordre: Record<Categorie, number> = { SYS_TROP_BAS: 1, SYS_TROP_HAUT: 2, SANS_STOCK: 3, RESOLU: 4 }
    lignes.sort((a, b) => (ordre[a.categorie as Categorie] - ordre[b.categorie as Categorie]) || a.code_piece.localeCompare(b.code_piece))

    return NextResponse.json({
      total_comptages_avec_ecart: lignes.length,
      stats,
      legende: {
        RESOLU: 'Stock actuel = qte_comptee — devrait auto-résoudre au prochain sync (statut → resolu)',
        SYS_TROP_HAUT: 'Système > comptage — probable réception entre temps, OU comptage incomplet. Option : recompter ou valider manuellement.',
        SYS_TROP_BAS: 'Système < comptage — VRAIE DISCORDANCE. Le physique vu par l\'employé n\'a jamais été reflété dans le système. À investiguer.',
        SANS_STOCK: 'Pièce absente de Traction — peut-être un PKCode supprimé ou un code erroné.',
      },
      lignes,
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e?.message || String(e) }, { status: 500 })
  }
}
