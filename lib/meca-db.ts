import { supabaseAdmin } from '@/lib/supabase'

// PostgREST plafonne un select() sans range() à 1000 lignes : au-delà, les
// lignes manquantes sont silencieusement absentes du résultat — un KPI faux
// plutôt qu'une erreur. Toutes les lectures de listes du module méca passent
// donc par ce chargeur.
//
// `construire` reçoit le query builder de la table et doit renvoyer la requête
// avec son select() et ses filtres ; le tri et la pagination sont ajoutés ici.
// Le tri est indispensable pour que les pages ne se recouvrent pas.
export async function chargerTout<T = any>(
  table: string,
  construire: (q: any) => any,
  colonneTri = 'id'
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await construire(supabaseAdmin.from(table))
      .order(colonneTri, { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...(data as T[]))
    if (data.length < 1000) break
  }
  return out
}
