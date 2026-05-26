-- Migration : module Vente (2026-05-26)
-- Tables pour l'onglet Vente (estimés + rabais + promos + packages) et son
-- onglet d'administration Paramètre Vente.
-- À exécuter manuellement dans Supabase Studio → SQL Editor.

-- 1) Marques utilisées pour Vente — listées par l'admin.
CREATE TABLE IF NOT EXISTS vente_marques (
  id BIGSERIAL PRIMARY KEY,
  nom TEXT NOT NULL UNIQUE,
  actif BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Paliers de rabais : pour chaque marque, intervalles [min, max] avec
-- montant de rabais à offrir au client.
CREATE TABLE IF NOT EXISTS vente_paliers_rabais (
  id BIGSERIAL PRIMARY KEY,
  marque_id BIGINT NOT NULL REFERENCES vente_marques(id) ON DELETE CASCADE,
  montant_min NUMERIC(12,2) NOT NULL,
  montant_max NUMERIC(12,2) NOT NULL,
  rabais_montant NUMERIC(12,2) NOT NULL,
  cree_le TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_palier_range CHECK (montant_max > montant_min),
  CONSTRAINT chk_rabais_pos CHECK (rabais_montant >= 0)
);
CREATE INDEX IF NOT EXISTS idx_paliers_marque ON vente_paliers_rabais(marque_id);

-- 3) Fiches promotion : visibles aux vendeurs dans l'onglet Vente.
-- type_rabais : 'pourcentage' | 'fixe' | 'autre'
CREATE TABLE IF NOT EXISTS vente_promotions (
  id BIGSERIAL PRIMARY KEY,
  titre TEXT NOT NULL,
  description TEXT,
  marque_id BIGINT REFERENCES vente_marques(id) ON DELETE SET NULL,
  modele TEXT,
  annee INTEGER,
  sku TEXT,
  type_rabais TEXT NOT NULL DEFAULT 'autre' CHECK (type_rabais IN ('pourcentage', 'fixe', 'autre')),
  valeur NUMERIC(12,2),
  image_url TEXT,
  date_debut DATE,
  date_fin DATE,
  actif BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le TIMESTAMPTZ DEFAULT NOW(),
  cree_par TEXT
);
CREATE INDEX IF NOT EXISTS idx_promos_marque ON vente_promotions(marque_id);
CREATE INDEX IF NOT EXISTS idx_promos_actif_dates ON vente_promotions(actif, date_debut, date_fin);

-- 4) Packages produit : groupes de pièces + MO + prix barré.
CREATE TABLE IF NOT EXISTS vente_packages (
  id BIGSERIAL PRIMARY KEY,
  titre TEXT NOT NULL,
  description TEXT,
  marque_id BIGINT REFERENCES vente_marques(id) ON DELETE SET NULL,
  prix_avant NUMERIC(12,2),
  prix_apres NUMERIC(12,2),
  mo_montant NUMERIC(12,2),
  image_url TEXT,
  date_debut DATE,
  date_fin DATE,
  actif BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le TIMESTAMPTZ DEFAULT NOW(),
  cree_par TEXT
);
CREATE INDEX IF NOT EXISTS idx_packages_marque ON vente_packages(marque_id);
CREATE INDEX IF NOT EXISTS idx_packages_actif_dates ON vente_packages(actif, date_debut, date_fin);

-- 5) Items inclus dans un package — pièces avec SKU.
CREATE TABLE IF NOT EXISTS vente_package_items (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES vente_packages(id) ON DELETE CASCADE,
  sku TEXT,
  description TEXT,
  quantite NUMERIC(10,2) NOT NULL DEFAULT 1,
  prix_unitaire NUMERIC(12,2),
  ordre INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pkg_items_pkg ON vente_package_items(package_id);

ALTER TABLE vente_marques DISABLE ROW LEVEL SECURITY;
ALTER TABLE vente_paliers_rabais DISABLE ROW LEVEL SECURITY;
ALTER TABLE vente_promotions DISABLE ROW LEVEL SECURITY;
ALTER TABLE vente_packages DISABLE ROW LEVEL SECURITY;
ALTER TABLE vente_package_items DISABLE ROW LEVEL SECURITY;
