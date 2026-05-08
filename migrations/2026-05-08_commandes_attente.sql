-- Migration : suivi des commandes Traction en attente de réception (2026-05-08)
-- Le PDF "liste commande" est importé plusieurs fois par semaine.
-- Une commande = clé composite (num_commande, num_piece).
-- date_premiere_vue capture le 1er import où le statut courant est apparu.
-- Quand le statut change : on reset date_premiere_vue.
-- Quand la pièce disparaît du PDF : active=false (= reçue / fermée).
-- À exécuter dans Supabase Studio → SQL Editor.

CREATE TABLE IF NOT EXISTS commandes_attente (
  id BIGSERIAL PRIMARY KEY,
  num_commande      TEXT NOT NULL,
  num_piece         TEXT NOT NULL,
  statut            TEXT NOT NULL,
  date_commande     DATE,
  num_fournisseur   TEXT,
  nom_fournisseur   TEXT,
  commande_par      TEXT,
  qte_commandee     NUMERIC DEFAULT 0,
  description       TEXT,
  nom_employe       TEXT,
  -- métadonnées de suivi
  date_premiere_vue TIMESTAMPTZ DEFAULT NOW(),
  date_dernier_import TIMESTAMPTZ DEFAULT NOW(),
  remarque          TEXT,
  plan_action       TEXT,
  date_action       TIMESTAMPTZ,
  active            BOOLEAN DEFAULT TRUE,
  cree_le           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(num_commande, num_piece)
);

CREATE INDEX IF NOT EXISTS idx_cmd_att_active ON commandes_attente(active);
CREATE INDEX IF NOT EXISTS idx_cmd_att_premiere_vue ON commandes_attente(date_premiere_vue);
CREATE INDEX IF NOT EXISTS idx_cmd_att_statut ON commandes_attente(statut);

ALTER TABLE commandes_attente DISABLE ROW LEVEL SECURITY;

-- Config (seuil d'alerte en jours, modifiable via l'UI)
CREATE TABLE IF NOT EXISTS commandes_attente_config (
  id          SMALLINT PRIMARY KEY DEFAULT 1,
  seuil_jours INTEGER NOT NULL DEFAULT 5,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO commandes_attente_config (id, seuil_jours)
VALUES (1, 5)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE commandes_attente_config DISABLE ROW LEVEL SECURITY;
