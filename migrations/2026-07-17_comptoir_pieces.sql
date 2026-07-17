-- Migration : module Comptoir Pièces (2026-07-17)
-- À exécuter dans Supabase Studio → SQL Editor.
--
-- Section indépendante de la mécanique, pour le suivi des commis pièces :
-- ventes/coût/marge par commis, factures individuelles, taux de conversion
-- estimé→facture, flag de marge sous 25 % avec justificatif, et suivi d'âge
-- des factures pièces ouvertes (+7 / +15 / +20 j urgent).
--
-- Consolide les migrations source 0004 + 0005, adaptées aux conventions :
--   - tables préfixées parts_ (namespace propre, pas de collision) ;
--   - table de batches DÉDIÉE parts_import_batches (le module méca a déjà sa
--     propre meca_import_batches — on ne couple pas les deux) ;
--   - RLS désactivé, tout passe par les routes serveur ;
--   - colonnes suivi_* sur parts_open_invoices (comme les bons méca).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Imports Excel du comptoir pièces.
CREATE TABLE IF NOT EXISTS parts_import_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN (
                  'rapport_vente_piece', 'liste_factures_pieces',
                  'estime_rapport_vente', 'factures_pieces_ouvertes')),
  filename      TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count     INT NOT NULL DEFAULT 0,
  warnings      JSONB NOT NULL DEFAULT '[]'::JSONB
);

-- Commis pièces. id = numéro du commis tel qu'il sort des rapports.
CREATE TABLE IF NOT EXISTS parts_clerks (
  id            TEXT PRIMARY KEY,
  nom           TEXT NOT NULL,
  actif         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ventes agrégées par commis × client × import (rapport_vente_piece.xlsx).
-- Colonnes reconstruites par cohérence arithmétique (en-tête source corrompu).
CREATE TABLE IF NOT EXISTS parts_sales (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id        UUID REFERENCES parts_import_batches(id),
  clerk_id               TEXT REFERENCES parts_clerks(id),
  client_no              TEXT,
  client_nom             TEXT,
  ventes                 NUMERIC NOT NULL DEFAULT 0,
  cout                   NUMERIC NOT NULL DEFAULT 0,
  profit                 NUMERIC NOT NULL DEFAULT 0,
  profit_pct             NUMERIC,
  nb_factures            INT NOT NULL DEFAULT 0,
  moyenne_facture        NUMERIC,
  commission             NUMERIC,
  marge_sous_seuil       BOOLEAN NOT NULL DEFAULT FALSE,  -- profit_pct < 25 %
  justificatif_requis    BOOLEAN NOT NULL DEFAULT FALSE,  -- marge sous seuil ET ventes >= 500 $
  justificatif_texte     TEXT,
  justificatif_fourni_at TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parts_sales_clerk ON parts_sales(clerk_id);
CREATE INDEX IF NOT EXISTS idx_parts_sales_marge ON parts_sales(marge_sous_seuil) WHERE marge_sous_seuil = TRUE;

-- Factures individuelles (Liste_des_factures_de_pièces.xlsx) : volume/rythme
-- par commis + jointure avec les estimés (facture_no = estimate_no).
CREATE TABLE IF NOT EXISTS parts_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_no      TEXT NOT NULL UNIQUE,
  clerk_id        TEXT REFERENCES parts_clerks(id),
  client_no       TEXT,
  client_nom      TEXT,
  total_pieces    NUMERIC NOT NULL DEFAULT 0,
  date_ouverture  TIMESTAMPTZ NOT NULL,
  import_batch_id UUID REFERENCES parts_import_batches(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parts_invoices_clerk ON parts_invoices(clerk_id);
CREATE INDEX IF NOT EXISTS idx_parts_invoices_date  ON parts_invoices(date_ouverture);

-- Estimés → factures (estimé_rapport_vente.xlsx). Le lien vers l'employé se
-- fait à la lecture via parts_invoices.facture_no = estimate_no.
CREATE TABLE IF NOT EXISTS parts_estimates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_no          TEXT NOT NULL UNIQUE,
  date_estime          DATE,
  client_no            TEXT,
  client_nom           TEXT,
  montant_estime       NUMERIC NOT NULL DEFAULT 0,
  facture_reelle_no    TEXT,
  date_facture_reelle  DATE,
  montant_facture_reel NUMERIC,
  converti             BOOLEAN NOT NULL DEFAULT FALSE,
  import_batch_id      UUID REFERENCES parts_import_batches(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parts_estimates_converti ON parts_estimates(converti);

-- Factures pièces ouvertes (liste_peice.xlsx, statut « Fact.ouv. »), en miroir
-- des bons méca. Une facture disparue d'un import est marquée fermée.
-- suivi_* = annotation du commis, préservée d'un import à l'autre.
CREATE TABLE IF NOT EXISTS parts_open_invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_no           TEXT NOT NULL UNIQUE,
  clerk_id             TEXT REFERENCES parts_clerks(id),
  client_no            TEXT,
  client_nom           TEXT,
  total                NUMERIC NOT NULL DEFAULT 0,
  date_ouverture       DATE NOT NULL,
  is_open              BOOLEAN NOT NULL DEFAULT TRUE,
  import_batch_id      UUID REFERENCES parts_import_batches(id),
  closed_detected_at   TIMESTAMPTZ,
  suivi_statut         TEXT,
  suivi_date_planifiee DATE,
  suivi_note           TEXT,
  suivi_par            TEXT,
  suivi_maj_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parts_open_invoices_clerk ON parts_open_invoices(clerk_id);
CREATE INDEX IF NOT EXISTS idx_parts_open_invoices_open  ON parts_open_invoices(is_open);

ALTER TABLE parts_import_batches DISABLE ROW LEVEL SECURITY;
ALTER TABLE parts_clerks         DISABLE ROW LEVEL SECURITY;
ALTER TABLE parts_sales          DISABLE ROW LEVEL SECURITY;
ALTER TABLE parts_invoices       DISABLE ROW LEVEL SECURITY;
ALTER TABLE parts_estimates      DISABLE ROW LEVEL SECURITY;
ALTER TABLE parts_open_invoices  DISABLE ROW LEVEL SECURITY;
