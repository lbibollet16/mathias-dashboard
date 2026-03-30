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
