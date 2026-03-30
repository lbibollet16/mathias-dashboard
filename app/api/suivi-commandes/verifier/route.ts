import { NextResponse } from 'next/server'
import { supabaseAdmin, parseFrNum } from '@/lib/supabase'

// GET/POST — vérifie les commandes faites depuis 5+ jours sans mouvement de stock
export async function GET() { return POST() }
export async function POST() {
  try {
    const cinqJoursAvant = new Date()
    cinqJoursAvant.setDate(cinqJoursAvant.getDate() - 5)

    // Trouver les commandes "commande_faite" depuis plus de 5 jours
    const { data: aVerifier } = await supabaseAdmin
      .from('suivi_commandes')
      .select('*')
      .eq('statut', 'commande_faite')
      .lt('date_action', cinqJoursAvant.toISOString())

    if (!aVerifier || aVerifier.length === 0) {
      return NextResponse.json({ success: true, verifies: 0 })
    }

    // Télécharger le stock actuel depuis Traction
    const tractionRes = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(60000) })
    const tractionCSV = await tractionRes.text()
    const lines = tractionCSV.split(/\r?\n/)
    const hdrs = (lines[0] || '').split(';')
    const iP = hdrs.findIndex(h => h.trim().toLowerCase() === 'pkcode')
    const iS = hdrs.findIndex(h => h.trim().toLowerCase() === 'qtyminusreserved')

    const stockActuel = new Map<string, number>()
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';')
      const pk = cols[iP]?.replace(/['"]/g, '').trim()
      if (pk) stockActuel.set(pk, parseFrNum(cols[iS]))
    }

    let nbVerifies = 0
    for (const suivi of aVerifier) {
      const stockMaintenant = stockActuel.get(suivi.code_piece)
      const stockAvant = Number(suivi.stock_au_moment)

      // Si le stock n'a pas bougé (ou est encore insuffisant) → passer en "verifie"
      if (stockMaintenant !== undefined && stockMaintenant <= stockAvant) {
        await supabaseAdmin
          .from('suivi_commandes')
          .update({ statut: 'verifie' })
          .eq('id', suivi.id)
        nbVerifies++
      }
    }

    return NextResponse.json({ success: true, verifies: nbVerifies, examines: aVerifier.length })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
