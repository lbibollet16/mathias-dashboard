-- Migration Amazon v2 (2026-04-29)
-- À exécuter manuellement dans Supabase Studio → SQL Editor
-- Sûr : uniquement des CREATE TABLE IF NOT EXISTS et ADD COLUMN IF NOT EXISTS
-- Aucun DROP, aucune perte de données possible.

-- 1. FBA Customer Returns Report
CREATE TABLE IF NOT EXISTS amazon_customer_returns (
  id BIGSERIAL PRIMARY KEY,
  license_plate_number TEXT NOT NULL UNIQUE,
  return_date TIMESTAMPTZ,
  order_id TEXT,
  sku TEXT,
  asin TEXT,
  fnsku TEXT,
  product_name TEXT,
  quantity INTEGER DEFAULT 1,
  fulfillment_center_id TEXT,
  detailed_disposition TEXT,
  reason TEXT,
  status TEXT,
  customer_comments TEXT,
  processed_in_settlement_id TEXT,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  source_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_amz_returns_sku ON amazon_customer_returns(sku);
CREATE INDEX IF NOT EXISTS idx_amz_returns_date ON amazon_customer_returns(return_date);
CREATE INDEX IF NOT EXISTS idx_amz_returns_settlement ON amazon_customer_returns(processed_in_settlement_id);
CREATE INDEX IF NOT EXISTS idx_amz_returns_dispo ON amazon_customer_returns(detailed_disposition);
ALTER TABLE amazon_customer_returns DISABLE ROW LEVEL SECURITY;

-- 2. Documents LAUTOPAK par settlement (4 docs)
CREATE TABLE IF NOT EXISTS amazon_lautopak_documents (
  id BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  numero_facture TEXT,
  date_facture DATE,
  montant_total NUMERIC,
  saisi_le TIMESTAMPTZ,
  saisi_par TEXT,
  notes TEXT,
  UNIQUE(settlement_id, doc_type)
);
CREATE INDEX IF NOT EXISTS idx_amz_lpdoc_settlement ON amazon_lautopak_documents(settlement_id);
ALTER TABLE amazon_lautopak_documents DISABLE ROW LEVEL SECURITY;

-- 3. Type d'audit
ALTER TABLE amazon_audits ADD COLUMN IF NOT EXISTS audit_type TEXT DEFAULT 'mensuel_ama';
CREATE INDEX IF NOT EXISTS idx_amz_audit_type ON amazon_audits(audit_type);

-- 4. Workflow version sur settlements
ALTER TABLE amazon_settlements ADD COLUMN IF NOT EXISTS workflow_version INTEGER DEFAULT 1;
