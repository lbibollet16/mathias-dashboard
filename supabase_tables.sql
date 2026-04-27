-- COLLE CE SQL DANS L'ÉDITEUR SQL DE SUPABASE (supabase.com > SQL Editor)

-- 1. Historique des ventes (remplace Google Sheets Historique_Ventes)
CREATE TABLE historique_ventes (
  id BIGSERIAL PRIMARY KEY,
  code_piece TEXT NOT NULL,
  mois TEXT NOT NULL,        -- Format: YYYY-MM
  quantite NUMERIC DEFAULT 0,
  revenus NUMERIC DEFAULT 0,
  profit NUMERIC DEFAULT 0,
  cree_le TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ventes_code ON historique_ventes(code_piece);
CREATE INDEX idx_ventes_mois ON historique_ventes(mois);

-- 2. Cache inventaire calculé (remplace la feuille Cache_Inventaire)
CREATE TABLE cache_inventaire (
  id BIGSERIAL PRIMARY KEY,
  cache_json JSONB NOT NULL,
  calcule_le TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Lots retournables (remplace feuille Lots_Retournables)
CREATE TABLE lots_retournables (
  id BIGSERIAL PRIMARY KEY,
  id_lot TEXT UNIQUE,
  code_piece TEXT NOT NULL,
  code_ligne TEXT,
  fournisseur TEXT,
  qte_recue NUMERIC DEFAULT 0,
  qte_restante NUMERIC DEFAULT 0,
  date_limite DATE,
  cout_unitaire NUMERIC DEFAULT 0,
  cree_le TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Stock hier (pour le calcul des lots)
CREATE TABLE stock_hier (
  id BIGSERIAL PRIMARY KEY,
  code_piece TEXT UNIQUE NOT NULL,
  quantite NUMERIC DEFAULT 0,
  mis_a_jour TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Mémoire négatifs
CREATE TABLE memoire_negatifs (
  id BIGSERIAL PRIMARY KEY,
  code_piece TEXT UNIQUE NOT NULL,
  fournisseur TEXT,
  ligne TEXT,
  description TEXT,
  stock_negatif NUMERIC DEFAULT 0,
  cout_unitaire NUMERIC DEFAULT 0,
  date_apparition DATE DEFAULT CURRENT_DATE
);

-- 6. Politiques fournisseurs
CREATE TABLE politiques_fournisseurs (
  id BIGSERIAL PRIMARY KEY,
  id_fournisseur TEXT UNIQUE NOT NULL,
  nom_fournisseur TEXT,
  jours_retour INTEGER DEFAULT 30
);

-- Désactiver RLS pour usage interne (ou configurer selon vos besoins)
ALTER TABLE historique_ventes DISABLE ROW LEVEL SECURITY;
ALTER TABLE cache_inventaire DISABLE ROW LEVEL SECURITY;
ALTER TABLE lots_retournables DISABLE ROW LEVEL SECURITY;
ALTER TABLE stock_hier DISABLE ROW LEVEL SECURITY;
ALTER TABLE memoire_negatifs DISABLE ROW LEVEL SECURITY;
ALTER TABLE politiques_fournisseurs DISABLE ROW LEVEL SECURITY;

-- 7. Validations comptables (onglet Comptabilité)
-- Une validation marque qu'une entrée (négatif vérifié, commande vérifiée, comptage avec écart)
-- a été contrôlée comptablement. L'entrée disparaît alors des autres onglets et reste
-- en historique dans l'onglet Comptabilité.
CREATE TABLE validations_comptables (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,            -- 'negatif' | 'commande' | 'comptage'
  ref_id BIGINT NOT NULL,          -- id de la ligne source (negatifs_verifies.id, suivi_commandes.id, inventaire_comptages.id)
  code_piece TEXT NOT NULL,
  snapshot JSONB,                  -- copie figée des données au moment de la validation
  user_email TEXT,
  date_validation TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, ref_id)
);
CREATE INDEX idx_valcompt_source_ref ON validations_comptables(source, ref_id);
CREATE INDEX idx_valcompt_date ON validations_comptables(date_validation DESC);
ALTER TABLE validations_comptables DISABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- PHASE 1 — Onglet Amazon : réconciliation paiements, inventaire FBA,
-- remboursements. Données source: Traction (lignes AMA/FBA/FBM) + fichiers
-- Amazon Seller Central (settlement TSV, FBA inventory CSV, reimbursements CSV).
-- ==========================================================================

-- 8. Miroir des pièces Traction sur les lignes Amazon (AMA/FBA/FBM)
-- Une même PKCode peut exister plusieurs fois (fournisseurs différents),
-- d'où la clé composite (pk_code, pk_fournisseur, code_ligne).
CREATE TABLE traction_amazon_lignes (
  id BIGSERIAL PRIMARY KEY,
  pk_code TEXT NOT NULL,
  pk_fournisseur TEXT NOT NULL DEFAULT '',
  code_ligne TEXT NOT NULL,           -- AMA | FBA | FBM
  qty NUMERIC DEFAULT 0,
  qty_minus_reserved NUMERIC DEFAULT 0,
  qte_reserve NUMERIC DEFAULT 0,
  prix_coutant NUMERIC DEFAULT 0,
  prix_liste1 NUMERIC DEFAULT 0,
  code_barres TEXT,
  desc_fra TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pk_code, pk_fournisseur, code_ligne)
);
CREATE INDEX idx_tal_pkcode ON traction_amazon_lignes(pk_code);
CREATE INDEX idx_tal_code_ligne ON traction_amazon_lignes(code_ligne);

-- 9. Settlements Amazon (un par période de paiement ~2 semaines)
CREATE TABLE amazon_settlements (
  id BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL UNIQUE,
  settlement_start TIMESTAMPTZ,
  settlement_end TIMESTAMPTZ,
  deposit_date TIMESTAMPTZ,
  total_amount NUMERIC,
  currency TEXT,
  marketplace TEXT,
  file_name TEXT,
  -- Réconciliation LAUTOPAK
  lautopak_invoice_ref TEXT,          -- n° de facture LAUTOPAK (texte libre)
  lautopak_invoice_date TIMESTAMPTZ,
  lautopak_status TEXT DEFAULT 'pending',  -- pending | facture | ignore
  lautopak_notes TEXT,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_amz_settlements_status ON amazon_settlements(lautopak_status);

-- 10. Transactions détaillées d'un settlement
CREATE TABLE amazon_transactions (
  id BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL,        -- FK logique vers amazon_settlements.settlement_id
  transaction_type TEXT,              -- Order | Refund | Adjustment | other-transaction
  order_id TEXT,
  merchant_order_id TEXT,
  adjustment_id TEXT,
  shipment_id TEXT,
  marketplace TEXT,
  amount_type TEXT,                   -- ItemPrice | ItemFees | ItemWithheldTax | FBA Inventory Reimbursement | Cost of Advertising | ...
  amount_description TEXT,            -- Principal | Shipping | Tax | Commission | FBAPerUnitFulfillmentFee | ...
  amount NUMERIC,
  fulfillment_id TEXT,                -- AFN (FBA) | MFN (FBM)
  posted_date TIMESTAMPTZ,
  order_item_code TEXT,
  sku TEXT,
  quantity_purchased NUMERIC,
  promotion_id TEXT,
  -- Résolution SKU
  traction_code TEXT,                 -- PKCode Traction résolu (null si non matché)
  resolution_source TEXT              -- cache | exact | suffix | prefix | manuel | none
);
CREATE INDEX idx_amz_tx_settlement ON amazon_transactions(settlement_id);
CREATE INDEX idx_amz_tx_sku ON amazon_transactions(sku);
CREATE INDEX idx_amz_tx_traction ON amazon_transactions(traction_code);
CREATE INDEX idx_amz_tx_posted ON amazon_transactions(posted_date);

-- 11. Snapshots d'inventaire FBA (chaque import = un snapshot daté)
CREATE TABLE amazon_fba_inventory (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sku TEXT NOT NULL,
  fnsku TEXT,
  asin TEXT,
  product_name TEXT,
  condition TEXT,
  your_price NUMERIC,
  afn_warehouse_quantity NUMERIC DEFAULT 0,
  afn_fulfillable_quantity NUMERIC DEFAULT 0,
  afn_unsellable_quantity NUMERIC DEFAULT 0,
  afn_reserved_quantity NUMERIC DEFAULT 0,
  afn_total_quantity NUMERIC DEFAULT 0,
  afn_inbound_working_quantity NUMERIC DEFAULT 0,
  afn_inbound_shipped_quantity NUMERIC DEFAULT 0,
  afn_inbound_receiving_quantity NUMERIC DEFAULT 0,
  traction_code TEXT,
  resolution_source TEXT,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(snapshot_date, sku)
);
CREATE INDEX idx_amz_fba_sku ON amazon_fba_inventory(sku);
CREATE INDEX idx_amz_fba_traction ON amazon_fba_inventory(traction_code);

-- 12. Remboursements Amazon (Lost/Damaged warehouse)
CREATE TABLE amazon_reimbursements (
  id BIGSERIAL PRIMARY KEY,
  reimbursement_id TEXT NOT NULL UNIQUE,
  approval_date TIMESTAMPTZ,
  case_id TEXT,
  amazon_order_id TEXT,
  reason TEXT,                         -- Lost_Warehouse | Damaged_Warehouse | ...
  sku TEXT,
  fnsku TEXT,
  asin TEXT,
  product_name TEXT,
  currency TEXT,
  amount_per_unit NUMERIC,
  amount_total NUMERIC,
  quantity_reimbursed_cash NUMERIC DEFAULT 0,
  quantity_reimbursed_inventory NUMERIC DEFAULT 0,
  quantity_reimbursed_total NUMERIC DEFAULT 0,
  original_reimbursement_id TEXT,
  original_reimbursement_type TEXT,
  traction_code TEXT,
  resolution_source TEXT,
  -- Réconciliation LAUTOPAK
  lautopak_ref TEXT,
  lautopak_status TEXT DEFAULT 'pending',
  lautopak_notes TEXT,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_amz_reimb_sku ON amazon_reimbursements(sku);
CREATE INDEX idx_amz_reimb_status ON amazon_reimbursements(lautopak_status);

-- 13. Mapping persistant SKU Amazon → code Traction (appris + manuel)
CREATE TABLE amazon_sku_mapping (
  id BIGSERIAL PRIMARY KEY,
  amazon_sku TEXT NOT NULL UNIQUE,
  traction_code TEXT NOT NULL,
  source TEXT NOT NULL,               -- auto | manuel
  confidence NUMERIC DEFAULT 1.0,     -- 1.0 = exact, 0.9 = suffix/prefix stripped
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_amz_sku_map_traction ON amazon_sku_mapping(traction_code);

ALTER TABLE traction_amazon_lignes   DISABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_settlements       DISABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_transactions      DISABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_fba_inventory     DISABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_reimbursements    DISABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_sku_mapping       DISABLE ROW LEVEL SECURITY;

-- Phase 2 Amazon: attribution exacte des remboursements aux settlements
-- (matching 1-pour-1 par SKU + montant avec les lignes FBA Inventory
-- Reimbursement du fichier payments)
ALTER TABLE amazon_reimbursements ADD COLUMN IF NOT EXISTS settlement_id TEXT;
CREATE INDEX IF NOT EXISTS idx_amz_reimb_settlement ON amazon_reimbursements(settlement_id);

-- Watchlist SKU Amazon (Phase 3 — monitoring inventaire)
CREATE TABLE IF NOT EXISTS amazon_sku_watchlist (
  id BIGSERIAL PRIMARY KEY,
  amazon_sku TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_amz_watch_sku ON amazon_sku_watchlist(amazon_sku);
ALTER TABLE amazon_sku_watchlist DISABLE ROW LEVEL SECURITY;

-- Phase 4b : Audits mensuels inventaire Amazon
CREATE TABLE IF NOT EXISTS amazon_audits (
  id BIGSERIAL PRIMARY KEY,
  mois TEXT NOT NULL,                    -- Format YYYY-MM
  label TEXT,                             -- Libellé libre (ex: "Audit avril 2026")
  statut TEXT DEFAULT 'en_cours',         -- en_cours | termine | archive
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  started_by TEXT,
  finished_by TEXT,
  notes TEXT,
  snapshot_count INTEGER DEFAULT 0        -- # base products dans ce snapshot
);
CREATE INDEX IF NOT EXISTS idx_amz_audit_mois ON amazon_audits(mois);
CREATE INDEX IF NOT EXISTS idx_amz_audit_statut ON amazon_audits(statut);

CREATE TABLE IF NOT EXISTS amazon_audit_counts (
  id BIGSERIAL PRIMARY KEY,
  audit_id BIGINT NOT NULL REFERENCES amazon_audits(id) ON DELETE CASCADE,
  base_code TEXT NOT NULL,
  description TEXT,
  coutant NUMERIC DEFAULT 0,
  -- Valeurs théoriques au moment du snapshot
  hub_theorique NUMERIC DEFAULT 0,
  fbm_theorique NUMERIC DEFAULT 0,
  sans_prefix_theorique NUMERIC DEFAULT 0,
  fba_amazon_theorique NUMERIC DEFAULT 0,   -- snapshot Amazon au moment de l'audit
  fba_traction_theorique NUMERIC DEFAULT 0, -- stock FBA Traction au même moment
  -- Comptages physiques saisis par l'utilisateur
  hub_compte NUMERIC,
  fbm_compte NUMERIC,
  sans_prefix_compte NUMERIC,
  counted_at TIMESTAMPTZ,
  counted_by TEXT,
  notes TEXT,
  UNIQUE(audit_id, base_code)
);
CREATE INDEX IF NOT EXISTS idx_amz_audit_counts_audit ON amazon_audit_counts(audit_id);
CREATE INDEX IF NOT EXISTS idx_amz_audit_counts_base ON amazon_audit_counts(base_code);

ALTER TABLE amazon_audits DISABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_audit_counts DISABLE ROW LEVEL SECURITY;

-- Lier chaque audit à un settlement (pour auto-génération à l'import)
ALTER TABLE amazon_audits ADD COLUMN IF NOT EXISTS settlement_id TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCOA : import des rapports d'analyse des ventes véhicules (PDF)
-- 4 types: ps_neuf, ps_usage, bateau_neuf, bateau_usage
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scoa_ventes (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('ps_neuf','ps_usage','bateau_neuf','bateau_usage')),
  date_vente DATE NOT NULL,
  client TEXT,
  stock_num TEXT NOT NULL,
  marque TEXT,
  modele TEXT,
  annee INT,
  num_contrat TEXT,
  vendeur_id TEXT,
  vendeur_nom TEXT,
  prix_vente NUMERIC(12,2) DEFAULT 0,
  profit_vehicule NUMERIC(12,2) DEFAULT 0,
  pct_brut_vehicule NUMERIC(7,2),
  ventes_fni NUMERIC(12,2) DEFAULT 0,
  profit_fni NUMERIC(12,2) DEFAULT 0,
  pct_brut_fni NUMERIC(7,2),
  ventes_totales NUMERIC(12,2) DEFAULT 0,
  profit_net_total NUMERIC(12,2) DEFAULT 0,
  pct_profit NUMERIC(7,2),
  nb_jours INT,
  periode_debut DATE,
  periode_fin DATE,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (type, stock_num, num_contrat, date_vente)
);
CREATE INDEX IF NOT EXISTS idx_scoa_ventes_type ON scoa_ventes(type);
CREATE INDEX IF NOT EXISTS idx_scoa_ventes_marque ON scoa_ventes(marque);
CREATE INDEX IF NOT EXISTS idx_scoa_ventes_vendeur ON scoa_ventes(vendeur_id);
CREATE INDEX IF NOT EXISTS idx_scoa_ventes_date ON scoa_ventes(date_vente);
ALTER TABLE scoa_ventes DISABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- Amazon : fermeture de settlement en 6 étapes séquentielles
-- Étapes : 1=LAUTOPAK 2=Reimbursements 3=Unsellable 4=AjustTraction 5=Audit 6=Rapport
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE amazon_settlements
  ADD COLUMN IF NOT EXISTS step3_unsellable_handled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS step3_unsellable_handled_by TEXT,
  ADD COLUMN IF NOT EXISTS step4_ajustements_fait_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS step4_ajustements_fait_by TEXT,
  ADD COLUMN IF NOT EXISTS step6_rapport_valide_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS step6_rapport_valide_by TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by TEXT;

-- Archive des pk_codes qui ont disparu du feed Traction (renommés/supprimés).
-- On garde l'historique pour la traçabilité comptable.
CREATE TABLE IF NOT EXISTS traction_sku_archive (
  id BIGSERIAL PRIMARY KEY,
  pk_code TEXT NOT NULL UNIQUE,
  code_ligne TEXT,
  last_qty_dispo NUMERIC,
  last_prix_coutant NUMERIC,
  last_desc_fra TEXT,
  first_disappeared_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_traction_archive_pk ON traction_sku_archive(pk_code);
ALTER TABLE traction_sku_archive DISABLE ROW LEVEL SECURITY;

-- Tracking persistant des ajustements d'inventaire liés aux reimbursements
-- (évite les ré-ajustements si un settlement est ré-importé + historique)
ALTER TABLE amazon_reimbursements
  ADD COLUMN IF NOT EXISTS inventaire_ajuste_le TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inventaire_ajuste_par TEXT,
  ADD COLUMN IF NOT EXISTS inventaire_pk_code TEXT;
CREATE INDEX IF NOT EXISTS idx_amz_reimb_ajuste ON amazon_reimbursements(inventaire_ajuste_le);

-- Facture LAUTOPAK séparée pour les pièces remboursées (Lost/Damaged/CustomerReturn cash)
-- Permet de "facturer" les pièces perdues dans LAUTOPAK afin de décrémenter l'inventaire
-- proprement (comme une vente) et tracer le remboursement Amazon correspondant.
ALTER TABLE amazon_settlements
  ADD COLUMN IF NOT EXISTS lautopak_reimb_invoice_ref TEXT,
  ADD COLUMN IF NOT EXISTS lautopak_reimb_invoice_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lautopak_reimb_notes TEXT,
  ADD COLUMN IF NOT EXISTS step2_force_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS step2_force_validated_by TEXT;

-- Actions sur les SKU unsellable (étape 3 fermeture settlement)
-- 'removal' = demande de retour au warehouse
-- 'case'    = réclamation/case ouvert avec Amazon
-- 'skip'    = pas d'action cette période (reporté)
CREATE TABLE IF NOT EXISTS amazon_unsellable_actions (
  id BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  traction_code TEXT,
  action_type TEXT,
  amazon_ref TEXT,
  notes TEXT,
  action_le TIMESTAMPTZ,
  action_par TEXT,
  traite_le TIMESTAMPTZ,
  traite_par TEXT,
  UNIQUE (settlement_id, sku)
);
ALTER TABLE amazon_unsellable_actions ADD COLUMN IF NOT EXISTS traite_le TIMESTAMPTZ;
ALTER TABLE amazon_unsellable_actions ADD COLUMN IF NOT EXISTS traite_par TEXT;
CREATE INDEX IF NOT EXISTS idx_amz_unsell_settlement ON amazon_unsellable_actions(settlement_id);
ALTER TABLE amazon_unsellable_actions DISABLE ROW LEVEL SECURITY;

-- Cases à cocher persistantes pour les lignes de facture LAUTOPAK (étape 1)
-- Permet de marquer "ligne saisie dans LAUTOPAK" par (settlement, sku).
CREATE TABLE IF NOT EXISTS amazon_lautopak_lines_facturees (
  id BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  facturee_le TIMESTAMPTZ DEFAULT NOW(),
  facturee_par TEXT,
  UNIQUE (settlement_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_amz_lautopak_fact_settlement ON amazon_lautopak_lines_facturees(settlement_id);
ALTER TABLE amazon_lautopak_lines_facturees DISABLE ROW LEVEL SECURITY;

-- Multi-mapping : un SKU Amazon → plusieurs PKCodes Traction (sommés pour le stock)
CREATE TABLE IF NOT EXISTS amazon_sku_pkcodes (
  id BIGSERIAL PRIMARY KEY,
  amazon_sku TEXT NOT NULL,
  pk_code TEXT NOT NULL,
  multiplier NUMERIC DEFAULT 1,   -- 1 unité Amazon = N unités Traction (pack)
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (amazon_sku, pk_code)
);
-- Si déjà créée sans multiplier, ajouter la colonne
ALTER TABLE amazon_sku_pkcodes ADD COLUMN IF NOT EXISTS multiplier NUMERIC DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_amz_sku_pk_sku ON amazon_sku_pkcodes(amazon_sku);
CREATE INDEX IF NOT EXISTS idx_amz_sku_pk_pk ON amazon_sku_pkcodes(pk_code);
ALTER TABLE amazon_sku_pkcodes DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_amz_audit_settlement ON amazon_audits(settlement_id);
