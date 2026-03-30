import { NextResponse } from 'next/server'
import { supabaseAdmin, calculerInventaire } from '@/lib/supabase'

export async function POST() {
  try {
    // 1. Lire toutes les ventes depuis Supabase (pagination par batch de 5000)
    let ventesData: any[] = []
    let from = 0
    const BATCH = 5000
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('historique_ventes')
        .select('code_piece, mois, quantite')
        .range(from, from + BATCH - 1)
      if (error) throw new Error('Erreur lecture ventes: ' + error.message)
      if (!data || data.length === 0) break
      ventesData = ventesData.concat(data)
      if (data.length < BATCH) break
      from += BATCH
    }

    if (ventesData.length === 0) {
      return NextResponse.json({ erreur: 'Aucune vente en base. Importez des données.' }, { status: 200 })
    }

    // 2. Télécharger Traction
    const tractionRes = await fetch(process.env.TRACTION_URL!, { signal: AbortSignal.timeout(60000) })
    if (!tractionRes.ok) throw new Error('Traction inaccessible: ' + tractionRes.status)
    const tractionCSV = await tractionRes.text()

    // 3. Télécharger Fournisseurs
    const fournisseursRes = await fetch(process.env.FOURNISSEURS_URL!)
    const fournisseurTSV = await fournisseursRes.text()

    // 4. Calculer (même logique que n8n)
    const resultat = calculerInventaire(ventesData, tractionCSV, fournisseurTSV)

    // 5. Sauvegarder dans Supabase
    await supabaseAdmin.from('cache_inventaire').delete().neq('id', 0) // vider
    const { error: insertError } = await supabaseAdmin
      .from('cache_inventaire')
      .insert({ cache_json: resultat, calcule_le: new Date().toISOString() })

    if (insertError) throw new Error('Erreur sauvegarde cache: ' + insertError.message)

    return NextResponse.json({
      success: true,
      nb_pieces: resultat.liste_complete.length,
      calcule_le: new Date().toISOString()
    })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// Vercel Cron - s'exécute chaque nuit à 2h (configure dans vercel.json)
export async function GET() {
  return POST()
}
