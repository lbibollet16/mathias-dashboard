-- Migration : sous-catégories par marque + lien sur promos et packages (2026-05-26)
-- Les sous-catégories sont une liste fixe côté UI :
-- VTT, Côte à Côte, Motoneige, Double usage, Cruiser, Sport, Enfant, Boutique.
-- Pour chaque marque, on enregistre lesquelles sont applicables.
-- À exécuter dans Supabase Studio → SQL Editor.

ALTER TABLE vente_marques
  ADD COLUMN IF NOT EXISTS sous_categories TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE vente_promotions
  ADD COLUMN IF NOT EXISTS sous_categorie TEXT;

ALTER TABLE vente_packages
  ADD COLUMN IF NOT EXISTS sous_categorie TEXT;

CREATE INDEX IF NOT EXISTS idx_promos_sous_cat ON vente_promotions(sous_categorie);
CREATE INDEX IF NOT EXISTS idx_packages_sous_cat ON vente_packages(sous_categorie);
