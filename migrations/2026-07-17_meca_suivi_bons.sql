-- Migration : suivi éditable par bon de travail (2026-07-17)
-- À exécuter dans Supabase Studio → SQL Editor.
--
-- L'aviseur renseigne, devant chaque bon ouvert, où en est le dossier :
--   suivi_statut          : étiquette d'avancement (Pièce en commande, Planifié,
--                            Problème client, En attente client, …) — null = rien
--   suivi_date_planifiee  : date à laquelle le bon est planifié (optionnel)
--   suivi_note            : note libre (ex. « attend roulement, cmd LAUTOPAK »)
--   suivi_par / suivi_maj_at : qui a mis à jour le suivi et quand
--
-- Ces colonnes sont indépendantes des imports Excel : l'upsert d'import ne
-- fournit pas ces champs, donc PostgREST les préserve d'un import à l'autre.

ALTER TABLE meca_work_orders
  ADD COLUMN IF NOT EXISTS suivi_statut          TEXT,
  ADD COLUMN IF NOT EXISTS suivi_date_planifiee  DATE,
  ADD COLUMN IF NOT EXISTS suivi_note            TEXT,
  ADD COLUMN IF NOT EXISTS suivi_par             TEXT,
  ADD COLUMN IF NOT EXISTS suivi_maj_at          TIMESTAMPTZ;

-- Filtrer/trier les bons qui ont un suivi actif.
CREATE INDEX IF NOT EXISTS idx_meca_wo_suivi_statut
  ON meca_work_orders(suivi_statut) WHERE suivi_statut IS NOT NULL;
