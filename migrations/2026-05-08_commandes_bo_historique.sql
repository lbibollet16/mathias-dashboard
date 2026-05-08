-- Migration : ajout BO + historique des modifs (2026-05-08)
-- À exécuter dans Supabase Studio → SQL Editor.

-- 1) Date BO (back-order) — obligatoire quand plan_action = BO
ALTER TABLE commandes_attente
  ADD COLUMN IF NOT EXISTS date_bo DATE;

-- 1bis) #Facture — extrait du bloc Réservation du PDF (peut être null
--       sur les commandes type "Stock" sans réservation)
ALTER TABLE commandes_attente
  ADD COLUMN IF NOT EXISTS num_facture TEXT;

-- 2) Historique des modifications (remarque / plan_action / date_bo)
CREATE TABLE IF NOT EXISTS commandes_attente_historique (
  id            BIGSERIAL PRIMARY KEY,
  commande_id   BIGINT NOT NULL REFERENCES commandes_attente(id) ON DELETE CASCADE,
  champ         TEXT NOT NULL,        -- 'remarque' | 'plan_action' | 'date_bo'
  valeur_avant  TEXT,
  valeur_apres  TEXT,
  modifie_par   TEXT,                  -- nom ou email de l'utilisateur
  modifie_le    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cmd_att_hist_cmd
  ON commandes_attente_historique(commande_id, modifie_le DESC);

ALTER TABLE commandes_attente_historique DISABLE ROW LEVEL SECURITY;
