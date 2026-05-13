-- Migration : stockage des analyses IA FNI par vendeur (2026-05-13)
-- Une seule analyse par vendeur (la plus récente) — le bouton « Régénérer »
-- écrase la précédente.
-- À exécuter dans Supabase Studio → SQL Editor.

CREATE TABLE IF NOT EXISTS scoa_fni_analyses (
  id            BIGSERIAL PRIMARY KEY,
  vendeur_nom   TEXT NOT NULL UNIQUE,
  analyse       TEXT NOT NULL,
  manque_total  NUMERIC DEFAULT 0,
  date_debut    DATE,
  date_fin      DATE,
  duree_ms      INTEGER,
  generee_le    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scoa_fni_analyses_vendeur
  ON scoa_fni_analyses(vendeur_nom);

ALTER TABLE scoa_fni_analyses DISABLE ROW LEVEL SECURITY;
