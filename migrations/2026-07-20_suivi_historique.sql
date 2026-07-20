-- Migration : historique du suivi (bons méca + factures pièces) — 2026-07-20
-- À exécuter dans Supabase Studio → SQL Editor.
--
-- Chaque fois qu'un aviseur ou un commis change le statut ou la note d'un
-- bon/facture, on garde une trace datée (avec l'auteur). Le statut et la note
-- « courants » restent sur meca_work_orders / parts_open_invoices ; cette table
-- est le journal append-only qui permet de voir l'évolution dans le temps.

CREATE TABLE IF NOT EXISTS suivi_historique (
  id          BIGSERIAL PRIMARY KEY,
  domaine     TEXT NOT NULL CHECK (domaine IN ('meca', 'pieces')),
  facture_no  TEXT NOT NULL,
  statut      TEXT,          -- statut au moment de l'entrée (null si inchangé)
  note        TEXT,          -- note au moment de l'entrée (null si inchangée)
  par         TEXT,          -- qui a saisi
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suivi_hist_cle
  ON suivi_historique(domaine, facture_no, cree_le DESC);

ALTER TABLE suivi_historique DISABLE ROW LEVEL SECURITY;
