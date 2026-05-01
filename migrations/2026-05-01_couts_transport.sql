-- Migration : coûts de transport par PKCode pour la profitabilité (2026-05-01)
-- À exécuter dans Supabase Studio → SQL Editor.

CREATE TABLE IF NOT EXISTS amazon_couts_transport (
  id BIGSERIAL PRIMARY KEY,
  pk_code TEXT NOT NULL UNIQUE,
  cout_unitaire NUMERIC NOT NULL DEFAULT 0,    -- coût transport par unité physique
  type_canal TEXT,                              -- 'FBA' | 'FBM' | 'mixte'
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_amz_transport_pk ON amazon_couts_transport(pk_code);
ALTER TABLE amazon_couts_transport DISABLE ROW LEVEL SECURITY;
