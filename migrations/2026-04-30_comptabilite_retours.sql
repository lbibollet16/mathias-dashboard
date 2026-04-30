-- Migration Comptabilité — retours au demandeur (2026-04-30)
-- À exécuter manuellement dans Supabase Studio → SQL Editor.
-- Sûr : uniquement CREATE TABLE IF NOT EXISTS et CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS comptabilite_retours (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('negatif', 'comptage')),
  ref_id BIGINT NOT NULL,
  code_piece TEXT,
  -- Qui a fait la demande à l'origine (employé du comptage / vérification du négatif)
  demandeur_employe TEXT NOT NULL,
  -- Qui a renvoyé depuis la comptabilité
  comptable_email TEXT NOT NULL,
  -- Raison du retour, OBLIGATOIRE
  commentaire_retour TEXT NOT NULL,
  retourne_le TIMESTAMPTZ DEFAULT NOW(),
  -- Suivi : vu par le demandeur ?
  vu_le TIMESTAMPTZ NULL,
  vu_par TEXT NULL,
  -- Suivi : corrigé ?
  corrige_le TIMESTAMPTZ NULL,
  corrige_par TEXT NULL,
  commentaire_correction TEXT NULL,
  -- Un seul retour actif par item à la fois (mais plusieurs si déjà corrigés successifs)
  -- Donc pas de UNIQUE (source, ref_id) — on permet l'historique.
  CONSTRAINT compta_retours_check_corrige CHECK (
    (corrige_le IS NULL AND corrige_par IS NULL) OR
    (corrige_le IS NOT NULL AND corrige_par IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_compta_ret_demandeur ON comptabilite_retours(demandeur_employe) WHERE corrige_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_compta_ret_active ON comptabilite_retours(retourne_le DESC) WHERE corrige_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_compta_ret_source_ref ON comptabilite_retours(source, ref_id);
ALTER TABLE comptabilite_retours DISABLE ROW LEVEL SECURITY;
