import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// Même rapprochement flou que le front (page.tsx) : le nom des commandes vient
// du PDF Traction au format « Nom, Prénom » et doit matcher le nom de profil
// « Prénom Nom ». On tokenise, on enlève les accents, on compte les tokens
// partagés (au moins un de longueur ≥ 4 pour éviter les faux positifs).
function matchNomEmploye(pdfNom: string | null | undefined, userNom: string | null | undefined): number {
  if (!pdfNom || !userNom) return 0
  const tokenize = (s: string) => new Set(
    s.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[,.]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2)
  )
  const a = tokenize(pdfNom)
  const b = tokenize(userNom)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0, interLong = 0
  for (const t of a) { if (b.has(t)) { inter++; if (t.length >= 4) interLong++ } }
  if (interLong === 0) return 0
  return inter / Math.min(a.size, b.size)
}

async function fetchAll(table: string, select: string): Promise<any[]> {
  let out: any[] = [], from = 0
  while (true) {
    const { data, error } = await supabaseAdmin.from(table).select(select).range(from, from + 999)
    if (error) throw error
    out = out.concat(data || [])
    if (!data || data.length < 1000) break
    from += 1000
  }
  return out
}

// IDs des commandes attribuées (par rapprochement flou) au nom donné
async function commandeIds(fromNom: string): Promise<number[]> {
  const rows = await fetchAll('commandes_attente', 'id, nom_employe')
  return rows.filter(r => matchNomEmploye(r.nom_employe, fromNom) >= 0.85).map(r => r.id)
}

async function countExact(table: string, field: string, val: string): Promise<number> {
  const { count } = await supabaseAdmin.from(table).select('*', { count: 'exact', head: true }).eq(field, val)
  return count || 0
}

// GET ?nom=X — aperçu du nombre d'éléments transférables par catégorie
export async function GET(req: NextRequest) {
  try {
    const nom = (req.nextUrl.searchParams.get('nom') || '').trim()
    if (!nom) return NextResponse.json({ erreur: 'nom requis' }, { status: 400 })
    const [cmd, cpt, nv] = await Promise.all([
      commandeIds(nom),
      countExact('inventaire_comptages', 'employe', nom),
      countExact('negatifs_verifies', 'employe', nom),
    ])
    return NextResponse.json({ commandes: cmd.length, comptages: cpt, negatifs: nv })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}

// POST { fromNom, toNom, categories?: {commandes, comptages, negatifs} }
export async function POST(req: NextRequest) {
  try {
    const { fromNom, toNom, categories } = await req.json()
    if (!fromNom || !toNom) return NextResponse.json({ erreur: 'fromNom et toNom requis' }, { status: 400 })
    if (String(fromNom).trim() === String(toNom).trim()) return NextResponse.json({ erreur: 'source et destinataire identiques' }, { status: 400 })
    const cats = categories || { commandes: true, comptages: true, negatifs: true }
    const res = { commandes: 0, comptages: 0, negatifs: 0 }

    if (cats.comptages) {
      const { data, error } = await supabaseAdmin.from('inventaire_comptages').update({ employe: toNom }).eq('employe', fromNom).select('id')
      if (error) throw error
      res.comptages = (data || []).length
    }
    if (cats.negatifs) {
      const { data, error } = await supabaseAdmin.from('negatifs_verifies').update({ employe: toNom }).eq('employe', fromNom).select('id')
      if (error) throw error
      res.negatifs = (data || []).length
    }
    if (cats.commandes) {
      const ids = await commandeIds(fromNom)
      for (let i = 0; i < ids.length; i += 100) {
        const { error } = await supabaseAdmin.from('commandes_attente').update({ nom_employe: toNom }).in('id', ids.slice(i, i + 100))
        if (error) throw error
      }
      res.commandes = ids.length
    }
    return NextResponse.json({ success: true, ...res })
  } catch (e: any) {
    return NextResponse.json({ erreur: e.message }, { status: 500 })
  }
}
