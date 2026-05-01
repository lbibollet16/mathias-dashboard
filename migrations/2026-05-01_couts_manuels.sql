-- Migration : coûtant unitaire saisi manuellement par PKCode (2026-05-01)
-- Pour combler les SKU sans coûtant dans Traction OU pour overrider un
-- coûtant Traction obsolète.
-- À exécuter dans Supabase Studio → SQL Editor.

CREATE TABLE IF NOT EXISTS amazon_couts_manuels (
  id BIGSERIAL PRIMARY KEY,
  pk_code TEXT NOT NULL UNIQUE,
  cout_unitaire NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_amz_cout_man_pk ON amazon_couts_manuels(pk_code);
ALTER TABLE amazon_couts_manuels DISABLE ROW LEVEL SECURITY;
