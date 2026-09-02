-- Migration : catégorie et marque dans l'analyse (2026-09-02)
-- A executer dans Supabase Studio -> SQL Editor.
--
-- POURQUOI
-- Les 19 371 pieces enrichies par sc_catalogue_externe ne servaient a rien :
-- elles n etaient ni affichees, ni filtrables, ni regroupables. Ces colonnes
-- font descendre l enrichissement dans l analyse elle-meme, pour qu on puisse
-- enfin repondre a « montre-moi tout mon KTM PowerWear mort » ou « quelle est
-- la rotation de mes casques » — c est-a-dire preparer un booking par
-- categorie ou par marque.
--
-- Idempotent : tout est en ADD COLUMN IF NOT EXISTS.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. L enrichissement descend dans l analyse par piece
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS marque                 TEXT;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS categorie_nom          TEXT;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS categorie_chemin       TEXT;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS categorie_univers      TEXT;
-- Disponibilite chez le fournisseur, venue des flux : savoir si Kimpex a la
-- piece en main change une decision d achat.
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS dispo_fournisseur      NUMERIC;
-- Signal de demande en ligne, independant des ventes au comptoir. Precieux
-- pour les pieces sans historique de vente.
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS popularite             NUMERIC;
-- Le fournisseur declare la piece discontinuee : 2 767 pieces, contre 447
-- detectees par mots-cles dans les descriptions Traction. A ne jamais
-- rebooker, et candidate prioritaire a la liquidation.
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS discontinue           BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_sc_ap_marque    ON sc_analyse_pieces (run_id, marque);
CREATE INDEX IF NOT EXISTS idx_sc_ap_categorie ON sc_analyse_pieces (run_id, categorie_chemin);
CREATE INDEX IF NOT EXISTS idx_sc_ap_disc      ON sc_analyse_pieces (run_id, discontinue) WHERE discontinue;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Deux nouvelles dimensions de regroupement
-- ═══════════════════════════════════════════════════════════════════════
--
-- sc_analyse_groupes savait deja agreger par fournisseur et par code de ligne.
-- On ajoute categorie et marque : meme calcul, meme tableau, meme rotation —
-- seul le regroupement change. C est ce qui rendra possible un booking cible
-- « pneus » ou « casques » plutot que « tout Kimpex ».

ALTER TABLE sc_analyse_groupes DROP CONSTRAINT IF EXISTS sc_analyse_groupes_dimension_check;
ALTER TABLE sc_analyse_groupes ADD  CONSTRAINT sc_analyse_groupes_dimension_check
  CHECK (dimension IN ('fournisseur','ligne','categorie','marque'));

-- Le nombre de lignes triple environ (672 fournisseurs + 39 lignes + ~600
-- categories utilisees + ~650 marques) : l index par dimension devient utile.
CREATE INDEX IF NOT EXISTS idx_sc_ag_dim ON sc_analyse_groupes (run_id, dimension, valeur_stock DESC);
