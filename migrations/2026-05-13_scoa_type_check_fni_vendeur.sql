-- Migration : élargir le CHECK constraint scoa_ventes.type pour accepter
-- le 5e type d'import « rapport_fni_vendeur » (PDF SCOA filtré par vendeur).
-- À exécuter dans Supabase Studio → SQL Editor.

ALTER TABLE scoa_ventes DROP CONSTRAINT IF EXISTS scoa_ventes_type_check;

ALTER TABLE scoa_ventes
  ADD CONSTRAINT scoa_ventes_type_check
  CHECK (type IN ('ps_neuf','ps_usage','bateau_neuf','bateau_usage','rapport_fni_vendeur'));
