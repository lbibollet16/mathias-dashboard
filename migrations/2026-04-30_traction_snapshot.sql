-- Migration : snapshot figé de l'inventaire Traction par settlement (2026-04-30)
-- À exécuter dans Supabase Studio → SQL Editor.
-- Sûr : CREATE TABLE IF NOT EXISTS uniquement.

-- Photo de traction_amazon_lignes au moment de l'import d'un settlement.
-- Utilisé par lautopak-docs, fba-comparison et createAuditSnapshot pour
-- garantir que les calculs ne bougent pas si Traction est resync entre temps.
CREATE TABLE IF NOT EXISTS amazon_traction_snapshots (
  id BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ DEFAULT NOW(),
  pk_code TEXT NOT NULL,
  pk_fournisseur TEXT NOT NULL DEFAULT '',
  code_ligne TEXT NOT NULL,
  qty NUMERIC,
  qty_minus_reserved NUMERIC,
  prix_coutant NUMERIC,
  desc_fra TEXT
);
CREATE INDEX IF NOT EXISTS idx_amz_tract_snap_settlement ON amazon_traction_snapshots(settlement_id);
CREATE INDEX IF NOT EXISTS idx_amz_tract_snap_pk ON amazon_traction_snapshots(pk_code);
ALTER TABLE amazon_traction_snapshots DISABLE ROW LEVEL SECURITY;
