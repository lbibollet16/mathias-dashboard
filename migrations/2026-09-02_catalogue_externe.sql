-- Migration : catalogue enrichi venu de mathias-power-parts (2026-09-02)
-- A executer dans Supabase Studio -> SQL Editor.
--
-- POURQUOI
-- Traction ne porte ni marque, ni categorie, ni compatibilite : le module
-- Rotation ne peut donc pas grouper par « pneus », « casques » ou « plaquettes
-- de frein », ni deviner ce que vaut une piece neuve. Le projet
-- mathias-power-parts, lui, tient deja un catalogue de 280 619 SKU issus des
-- flux fournisseurs (Kimpex, KTM, Parts Canada, Motovan, Live To Play, DAI),
-- avec une taxonomie de 1 858 categories, 657 marques, les couts d achat, la
-- disponibilite chez le fournisseur et un score de popularite en ligne.
--
-- Ces tables recoivent cet enrichissement pour les pieces qui existent des DEUX
-- cotes. Mesure au 2026-09-02 : 4 114 pieces en stock appariees sur 17 370
-- (23,7 %), mais 786 941 $ sur 2 171 363 $ — soit 36,2 % de la VALEUR. L ecart
-- s explique : le catalogue en ligne ne couvre pas l OEM marine, Polaris ni
-- Kawasaki, qui pesent lourd dans Traction.
--
-- SENS DE CIRCULATION
-- C est power-parts qui POUSSE vers le dashboard, comme le fait deja
-- src/lib/amazon/dashboard-bridge.ts vers /api/amazon/import. Aucune cle de la
-- base pieces n a donc a vivre dans le dashboard.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. La taxonomie
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sc_categories_externes (
  id           UUID PRIMARY KEY,          -- id d origine cote power-parts
  slug         TEXT,
  nom_fr       TEXT,
  nom_en       TEXT,
  univers      TEXT,                      -- oem | marine | auto | ...
  parent_id    UUID,
  -- Chemin complet lisible, calcule a l import : « Marine > Filtres > Essence ».
  -- Evite de recomposer la hierarchie a chaque affichage ou regroupement.
  chemin       TEXT,
  profondeur   INT NOT NULL DEFAULT 0,
  maj_le       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sc_cat_ext_parent  ON sc_categories_externes (parent_id);
CREATE INDEX IF NOT EXISTS idx_sc_cat_ext_univers ON sc_categories_externes (univers);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. L enrichissement, par piece Traction
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sc_catalogue_externe (
  -- Cle = le PKCode Traction. C est la charniere entre les deux mondes.
  code_piece            TEXT PRIMARY KEY,
  sku_externe           TEXT NOT NULL,
  -- Comment l appariement a ete fait : utile pour juger la confiance et pour
  -- mesurer si une nouvelle cle vaut la peine d etre ajoutee.
  appariement           TEXT NOT NULL CHECK (appariement IN ('sku','normalise','gtin')),

  marque                TEXT,
  marque_slug           TEXT,

  categorie_id          UUID,
  categorie_nom         TEXT,
  categorie_univers     TEXT,
  categorie_chemin      TEXT,

  -- Prix. dealer_cost vient du flux fournisseur : il peut differer du
  -- PrixCoutant de Traction, et l ecart est en soi une information.
  cout_fournisseur      NUMERIC,
  prix_detail           NUMERIC,
  msrp                  NUMERIC,
  map_price             NUMERIC,

  -- Disponibilite chez le fournisseur : savoir si Kimpex a la piece en main
  -- change la decision d un booking.
  stock_fournisseur     NUMERIC,
  stock_fournisseur_maj TIMESTAMPTZ,

  -- Signal de demande en ligne, independant des ventes au comptoir.
  popularite            NUMERIC,

  discontinue           BOOLEAN NOT NULL DEFAULT FALSE,
  saison                TEXT,
  compatible_hiver      BOOLEAN,

  maj_le                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sc_cat_marque  ON sc_catalogue_externe (marque);
CREATE INDEX IF NOT EXISTS idx_sc_cat_cat     ON sc_catalogue_externe (categorie_id);
CREATE INDEX IF NOT EXISTS idx_sc_cat_univers ON sc_catalogue_externe (categorie_univers);
CREATE INDEX IF NOT EXISTS idx_sc_cat_disc    ON sc_catalogue_externe (discontinue) WHERE discontinue;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Journal des imports
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sc_catalogue_imports (
  id                BIGSERIAL PRIMARY KEY,
  demarre_le        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  termine_le        TIMESTAMPTZ,
  statut            TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours','termine','erreur')),
  source            TEXT NOT NULL DEFAULT 'power-parts',
  nb_categories     INT NOT NULL DEFAULT 0,
  nb_lignes         INT NOT NULL DEFAULT 0,
  nb_lots           INT NOT NULL DEFAULT 0,
  -- Ce que le pousseur a mesure de son cote, pour pouvoir suivre l evolution
  -- du taux d appariement sans avoir a le recalculer.
  couverture        JSONB NOT NULL DEFAULT '{}'::JSONB,
  erreur            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_cat_imp ON sc_catalogue_imports (demarre_le DESC);
