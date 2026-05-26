-- Migration : ajouter prix barré/PDSF aux promotions (2026-05-26)
-- Permet d'afficher un prix avant/après sur les promotions comme on le fait
-- déjà sur les packages.
-- À exécuter dans Supabase Studio → SQL Editor.

ALTER TABLE vente_promotions
  ADD COLUMN IF NOT EXISTS prix_avant NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS prix_apres NUMERIC(12,2);
