-- Migration : attribution manuelle d'un FNI vendor par #Stock (2026-05-14)
-- Permet de découpler le vendeur du véhicule (qui apparait dans le PDF SCOA)
-- du spécialiste FNI (Marion / Théo / Joly-Ann) qui a vendu le financement.
-- L'override est appliqué côté API au moment de calculer les KPIs FNI.
--
-- Le `stock_num` stocké ici est la CLÉ ; l'override matche par « core »
-- (la partie YY-NNNN sans préfixe/suffixe lettre) pour qu'un mapping
-- « 24-2300 » couvre aussi « C24-2300 », « 24-2300A », etc.
-- À exécuter dans Supabase Studio → SQL Editor.

CREATE TABLE IF NOT EXISTS scoa_fni_assignments (
  stock_num        TEXT PRIMARY KEY,
  fni_vendeur_nom  TEXT NOT NULL,
  source           TEXT DEFAULT 'manual',     -- 'manual' | 'excel_import'
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scoa_fni_assignments_fni
  ON scoa_fni_assignments(fni_vendeur_nom);

ALTER TABLE scoa_fni_assignments DISABLE ROW LEVEL SECURITY;
