-- Migration : dashboard rentabilité mécanique — Powersport / Marine (2026-07-16)
-- À exécuter dans Supabase Studio → SQL Editor.
--
-- Consolide les 3 migrations du projet source (meca_dashboard, stagnation_tracking,
-- reassignation_manuelle) en un seul fichier, adapté aux conventions du projet :
--   - tables préfixées meca_ (comme amazon_, inventaire_, commandes_) : les noms
--     d'origine (advisors, work_orders, import_batches) étaient trop génériques ;
--   - RLS désactivé : tout passe par les routes /api/meca/* côté serveur avec la
--     clé service, comme le reste du dashboard.
--
-- Modèle :
--   meca_advisors            un aviseur = un numéro tel qu'il sort des rapports source
--   meca_import_batches      un import de fichier Excel
--   meca_work_orders         un bon de travail (état courant), clé = # facture
--   meca_advisor_performance ventilation du rapport aviseur, par période

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE meca_department_code AS ENUM ('powersport', 'marine');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Aviseurs techniques.
-- id = le numéro d'aviseur des rapports source (ex: "20", "156").
-- departement + actif sont réglés à la main dans l'onglet Aviseur Technique.
CREATE TABLE IF NOT EXISTS meca_advisors (
  id            TEXT PRIMARY KEY,
  nom           TEXT NOT NULL,
  departement   meca_department_code,             -- null = pas encore classé
  actif         BOOLEAN NOT NULL DEFAULT TRUE,    -- visible dans les dashboards
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historique des imports Excel.
CREATE TABLE IF NOT EXISTS meca_import_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN ('rapport_aviseur', 'bons_de_travail')),
  filename      TEXT,
  period_start  DATE,
  period_end    DATE,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count     INT NOT NULL DEFAULT 0,
  warnings      JSONB NOT NULL DEFAULT '[]'::JSONB  -- lignes non classées avec certitude
);

-- Bons de travail : un enregistrement par # facture.
-- Chaque import met à jour last_seen_batch_id. Un # facture qui n'apparaît plus
-- dans le nouvel import est marqué fermé (is_open=false, closed_detected_at=now).
-- date_ouverture vient du fichier source (fiable) ; closed_detected_at n'est que
-- la date de l'import qui a constaté la fermeture (précis à la fréquence d'import).
CREATE TABLE IF NOT EXISTS meca_work_orders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facture_no                TEXT NOT NULL UNIQUE,
  advisor_id                TEXT REFERENCES meca_advisors(id),
  client_no                 TEXT,
  client_nom                TEXT,
  no_serie                  TEXT,
  no_stock                  TEXT,
  statut                    TEXT,               -- "R.O impr.", "R.O ouvert", ...
  date_ouverture            DATE NOT NULL,
  date_a_compter            DATE,
  montants                  JSONB NOT NULL DEFAULT '{}'::JSONB,
  age_jours_source          INT,                -- âge imprimé au moment de l'import (référence)
  is_open                   BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_batch_id       UUID REFERENCES meca_import_batches(id),
  last_seen_batch_id        UUID REFERENCES meca_import_batches(id),
  closed_detected_at        TIMESTAMPTZ,
  -- Suivi de stagnation : incrémenté à chaque import où le bon est encore
  -- ouvert. >= 2 = signalé (pas fermé depuis le dernier import).
  imports_vus_ouvert        INT NOT NULL DEFAULT 1,
  premiere_alerte_at        TIMESTAMPTZ,
  -- true si l'aviseur a été changé à la main depuis le suivi : les imports
  -- suivants ne réécrasent plus advisor_id avec la valeur du fichier source.
  advisor_assigned_manually BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meca_wo_advisor        ON meca_work_orders(advisor_id);
CREATE INDEX IF NOT EXISTS idx_meca_wo_open           ON meca_work_orders(is_open);
CREATE INDEX IF NOT EXISTS idx_meca_wo_date_ouverture ON meca_work_orders(date_ouverture);
CREATE INDEX IF NOT EXISTS idx_meca_wo_stagnant       ON meca_work_orders(advisor_id, imports_vus_ouvert) WHERE is_open = TRUE;

-- Performance des aviseurs (Rapport des Aviseurs Technique — Détaillée).
-- La ventilation par catégorie est en jsonb : les clés viennent de l'en-tête du
-- fichier source (cellules fusionnées), donc pas de colonnes figées.
--   ex: {"Client|Pièce": 513.55, "Garantie|Pièce": 9551.70, "Autre": 1183.80}
CREATE TABLE IF NOT EXISTS meca_advisor_performance (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id  UUID REFERENCES meca_import_batches(id),
  advisor_id       TEXT REFERENCES meca_advisors(id),  -- null si le nom n'a pas matché (voir warnings du batch)
  advisor_nom      TEXT NOT NULL,
  row_label        TEXT NOT NULL,   -- 'ventes' | 'couts' | 'profits' | 'profit_pct' | ...
  periode_type     TEXT NOT NULL,   -- 'periode' | 'mtd' | 'mtd_an_passee' | 'ytd' | 'ytd_an_passee'
  valeurs          JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meca_perf_advisor ON meca_advisor_performance(advisor_id, periode_type);
CREATE INDEX IF NOT EXISTS idx_meca_perf_batch   ON meca_advisor_performance(import_batch_id);

ALTER TABLE meca_advisors            DISABLE ROW LEVEL SECURITY;
ALTER TABLE meca_import_batches      DISABLE ROW LEVEL SECURITY;
ALTER TABLE meca_work_orders         DISABLE ROW LEVEL SECURITY;
ALTER TABLE meca_advisor_performance DISABLE ROW LEVEL SECURITY;
