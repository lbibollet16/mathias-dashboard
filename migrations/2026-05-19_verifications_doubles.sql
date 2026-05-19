-- Migration : table de double-vérification (2026-05-19)
-- Tout comptage / pièce négative avec |écart| > 3 doit être validé par un
-- admin avant d'apparaître dans Comptabilité.
-- À exécuter manuellement dans Supabase Studio → SQL Editor.

CREATE TABLE IF NOT EXISTS verifications_doubles (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('comptage', 'negatif')),
  ref_id BIGINT NOT NULL,
  code_piece TEXT NOT NULL,
  ecart NUMERIC NOT NULL,
  snapshot JSONB NULL,
  valide_le TIMESTAMPTZ DEFAULT NOW(),
  valide_par TEXT NOT NULL,
  commentaire TEXT NULL,
  UNIQUE(source, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_verif_dbl_source_ref ON verifications_doubles(source, ref_id);
CREATE INDEX IF NOT EXISTS idx_verif_dbl_code ON verifications_doubles(code_piece);
CREATE INDEX IF NOT EXISTS idx_verif_dbl_valide_le ON verifications_doubles(valide_le DESC);

ALTER TABLE verifications_doubles DISABLE ROW LEVEL SECURITY;
