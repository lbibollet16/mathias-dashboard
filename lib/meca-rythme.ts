// lib/meca-rythme.ts
//
// Calcule le rythme moyen d'ouverture et de fermeture des bons de travail
// (bons / jour), pour un ensemble d'aviseurs donné (département entier ou
// un seul aviseur).
//
// ⚠️ Asymétrie importante à comprendre avant d'utiliser ces chiffres :
// - "Ouvertures" vient de date_ouverture, une date RÉELLE fournie par le
//   fichier source — fiable quelle que soit ta fréquence d'import.
// - "Fermetures" vient de closed_detected_at, qui n'est que la date du PROCHAIN
//   IMPORT où le bon n'apparaissait plus — donc précise seulement à la
//   fréquence de tes imports. Si tu importes une fois par semaine, une
//   fermeture "détectée" le lundi peut être survenue n'importe quand durant
//   la semaine précédente. Le taux moyen reste statistiquement valable sur
//   une période assez longue, mais ne prétend pas donner un rythme jour par
//   jour précis si tu importes rarement.
// - Un bon ouvert ET fermé ENTRE deux imports (cycle très court) n'apparaît
//   jamais dans les données — le taux d'ouverture est donc un plancher, pas
//   un chiffre absolu, si tes imports sont espacés.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface RythmeResult {
  periodeJours: number;
  ouverturesParJour: number;
  fermeturesParJour: number;
  soldeNetParJour: number; // positif = la file grossit, négatif = elle se vide
  totalOuvertures: number;
  totalFermetures: number;
  fiabiliteFermeture: "bonne" | "limitee" | "insuffisante";
  premierImportDepuisJours: number | null;
}

/**
 * @param advisorIds - aviseurs à inclure (département ou un seul aviseur)
 * @param joursPeriodeDemandee - fenêtre souhaitée (ex: 30 jours)
 */
export async function computeRythme(
  supabase: SupabaseClient,
  advisorIds: string[],
  joursPeriodeDemandee = 30
): Promise<RythmeResult> {
  if (advisorIds.length === 0) {
    return {
      periodeJours: joursPeriodeDemandee,
      ouverturesParJour: 0,
      fermeturesParJour: 0,
      soldeNetParJour: 0,
      totalOuvertures: 0,
      totalFermetures: 0,
      fiabiliteFermeture: "insuffisante",
      premierImportDepuisJours: null,
    };
  }

  const maintenant = Date.now();

  // Depuis quand suit-on vraiment les bons de travail ? (premier import de ce type)
  const { data: premierImport } = await supabase
    .from("meca_import_batches")
    .select("uploaded_at")
    .eq("type", "bons_de_travail")
    .order("uploaded_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const premierImportDepuisJours = premierImport
    ? Math.floor((maintenant - new Date(premierImport.uploaded_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // On ne peut pas prétendre mesurer un rythme de fermeture sur une période
  // plus longue que ce qu'on suit réellement.
  const joursPeriode =
    premierImportDepuisJours !== null ? Math.max(1, Math.min(joursPeriodeDemandee, premierImportDepuisJours)) : joursPeriodeDemandee;

  const depuisDate = new Date(maintenant - joursPeriode * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Ouvertures : date réelle, fiable même avec peu d'imports
  const { count: totalOuvertures } = await supabase
    .from("meca_work_orders")
    .select("id", { count: "exact", head: true })
    .in("advisor_id", advisorIds)
    .gte("date_ouverture", depuisDate);

  // Fermetures détectées : seulement estimées, dépend de la fréquence d'import
  const { count: totalFermetures } = await supabase
    .from("meca_work_orders")
    .select("id", { count: "exact", head: true })
    .in("advisor_id", advisorIds)
    .eq("is_open", false)
    .gte("closed_detected_at", depuisDate);

  const { count: nbImportsBonsDeTravail } = await supabase
    .from("meca_import_batches")
    .select("id", { count: "exact", head: true })
    .eq("type", "bons_de_travail");

  let fiabiliteFermeture: RythmeResult["fiabiliteFermeture"] = "bonne";
  if ((nbImportsBonsDeTravail ?? 0) < 2) fiabiliteFermeture = "insuffisante";
  else if ((nbImportsBonsDeTravail ?? 0) < 5) fiabiliteFermeture = "limitee";

  return {
    periodeJours: joursPeriode,
    ouverturesParJour: Math.round(((totalOuvertures ?? 0) / joursPeriode) * 100) / 100,
    fermeturesParJour: Math.round(((totalFermetures ?? 0) / joursPeriode) * 100) / 100,
    soldeNetParJour:
      Math.round((((totalOuvertures ?? 0) - (totalFermetures ?? 0)) / joursPeriode) * 100) / 100,
    totalOuvertures: totalOuvertures ?? 0,
    totalFermetures: totalFermetures ?? 0,
    fiabiliteFermeture,
    premierImportDepuisJours,
  };
}
