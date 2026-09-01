-- Migration : module « Rotation & Fournisseurs » (supply chain) — 2026-09-01
-- À exécuter dans Supabase Studio → SQL Editor.
--
-- Objectif : suivre le stock par FOURNISSEUR et par CODE DE LIGNE, archiver un
-- « print » d'inventaire le 1er de chaque mois (cron Traction) pour pouvoir
-- calculer un vrai ROULEMENT D'INVENTAIRE (COGS ÷ stock moyen — impossible sans
-- une série de photos mensuelles), et faire tourner des agents supply chain
-- (Pareto/ABC, XYZ, Wilson/EOQ, stock de sécurité, surstock, stock mort,
-- ruptures, réceptions excessives) qui produisent des constats actionnables.
--
-- Conventions du projet : préfixe de namespace dédié (sc_ = supply chain), RLS
-- désactivé (tout passe par les routes serveur), pas de FK inter-modules.
--
-- ⚠️ Pattern « run_id » pour les tables d'analyse : au lieu d'un DELETE+INSERT
-- (qui laisse une fenêtre vide et a déjà produit des doublons sur
-- stock_aujourdhui), chaque recalcul insère ses lignes avec un run_id neuf,
-- puis purge les runs précédents. Les lectures filtrent sur le dernier run
-- terminé : jamais de table vide, jamais de doublon.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. PARAMÈTRES
-- ═══════════════════════════════════════════════════════════════════════

-- Paramètres globaux du module. Une seule ligne (id = 1), éditable depuis
-- l'onglet. Sert de valeur par défaut à tous les fournisseurs.
CREATE TABLE IF NOT EXISTS sc_config (
  id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Paramètres de réapprovisionnement
  delai_jours               NUMERIC NOT NULL DEFAULT 14,     -- délai fournisseur moyen
  niveau_service            NUMERIC NOT NULL DEFAULT 0.95,   -- 95 % → Z = 1.645
  cout_commande             NUMERIC NOT NULL DEFAULT 45,     -- $ par commande passée (Wilson : S)
  taux_possession           NUMERIC NOT NULL DEFAULT 0.25,   -- 25 %/an du coût unitaire (Wilson : H)

  -- Seuils de classification
  horizon_surstock_mois     NUMERIC NOT NULL DEFAULT 12,     -- au-delà = excédent
  mois_stock_mort           NUMERIC NOT NULL DEFAULT 24,     -- aucune vente depuis N mois = mort
  seuil_abc_a               NUMERIC NOT NULL DEFAULT 0.80,   -- Pareto : 80 % du coût des ventes
  seuil_abc_b               NUMERIC NOT NULL DEFAULT 0.95,

  -- Seuils des 4 déclencheurs d'alerte « réception trop importante »
  alerte_couverture_mois    NUMERIC NOT NULL DEFAULT 12,     -- couverture après réception
  alerte_valeur_dollars     NUMERIC NOT NULL DEFAULT 2000,   -- valeur de la réception
  alerte_multiple_eoq       NUMERIC NOT NULL DEFAULT 3,      -- qté reçue > N × EOQ
  alerte_sans_vente_dollars NUMERIC NOT NULL DEFAULT 500,    -- réception sur pièce sans vente 12 m
  alerte_qte_min            NUMERIC NOT NULL DEFAULT 3,      -- sous ce nb d'unites, jamais d'alerte

  -- Codes de ligne dont les ventes ne passent PAS par le rapport 2891.
  -- AMA/FBA/FBM sont les lignes Amazon : 694 000 $ de stock bien reel, mais
  -- dont les ventes vivent dans les settlements. Sans cette exclusion, ces
  -- pieces seraient toutes classees « jamais vendues » et le stock mort
  -- afficherait un demi-million de dollars imaginaire.
  lignes_hors_perimetre     TEXT NOT NULL DEFAULT 'AMA,FBA,FBM',

  maj_le                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_par                   TEXT
);

INSERT INTO sc_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Surcharges par fournisseur (délai réel, franco de port, exclusion du suivi).
-- Clé = nom du fournisseur tel que résolu par le feed Traction + FOURNISSEURS_URL.
CREATE TABLE IF NOT EXISTS sc_fournisseurs_params (
  fournisseur       TEXT PRIMARY KEY,
  id_fournisseur    TEXT,
  delai_jours       NUMERIC,          -- NULL = hérite de sc_config
  cout_commande     NUMERIC,
  niveau_service    NUMERIC,
  franco_port       NUMERIC,          -- montant minimum de commande ($)
  suivi_actif       BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  maj_le            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. SNAPSHOTS MENSUELS — le « print » d'inventaire du 1er du mois
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sc_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  mois            TEXT NOT NULL UNIQUE,       -- YYYY-MM (mois DONT on photographie la clôture)
  date_snapshot   DATE NOT NULL,              -- date réelle de la prise
  source          TEXT NOT NULL DEFAULT 'cron' CHECK (source IN ('cron','manuel')),
  nb_pieces       INT  NOT NULL DEFAULT 0,    -- pièces avec stock ≠ 0
  nb_fournisseurs INT  NOT NULL DEFAULT 0,
  qte_totale      NUMERIC NOT NULL DEFAULT 0,
  valeur_totale   NUMERIC NOT NULL DEFAULT 0, -- $ au coût
  log             JSONB NOT NULL DEFAULT '[]'::JSONB,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Détail du snapshot : une ligne par pièce en stock, avec son fournisseur et
-- son code de ligne FIGÉS à la date de la photo (ils peuvent changer après —
-- c'est justement ce qui rend l'archive fiable).
CREATE TABLE IF NOT EXISTS sc_snapshot_lignes (
  id              BIGSERIAL PRIMARY KEY,
  mois            TEXT NOT NULL,
  code_piece      TEXT NOT NULL,
  description     TEXT,
  id_fournisseur  TEXT,
  fournisseur     TEXT NOT NULL DEFAULT 'Non assigné',
  code_ligne      TEXT NOT NULL DEFAULT 'N/A',
  qty             NUMERIC NOT NULL DEFAULT 0,   -- stock physique total
  qty_dispo       NUMERIC NOT NULL DEFAULT 0,   -- QTYMINUSRESERVED
  qte_reserve     NUMERIC NOT NULL DEFAULT 0,
  qte_transit     NUMERIC NOT NULL DEFAULT 0,
  qte_commande    NUMERIC NOT NULL DEFAULT 0,   -- en commande, non reçu
  cout_unitaire   NUMERIC NOT NULL DEFAULT 0,
  valeur          NUMERIC NOT NULL DEFAULT 0,   -- qty × cout_unitaire
  localisation    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_snap_mois_piece ON sc_snapshot_lignes (mois, code_piece);
CREATE INDEX IF NOT EXISTS idx_sc_snap_fourn ON sc_snapshot_lignes (mois, fournisseur);
CREATE INDEX IF NOT EXISTS idx_sc_snap_ligne ON sc_snapshot_lignes (mois, code_ligne);
CREATE INDEX IF NOT EXISTS idx_sc_snap_piece ON sc_snapshot_lignes (code_piece);

-- Agrégat pré-calculé par fournisseur et par code de ligne, pour tracer la
-- courbe de roulement sans relire les 18 000 lignes de détail à chaque fois.
CREATE TABLE IF NOT EXISTS sc_snapshot_agregats (
  id            BIGSERIAL PRIMARY KEY,
  mois          TEXT NOT NULL,
  dimension     TEXT NOT NULL CHECK (dimension IN ('fournisseur','ligne')),
  cle           TEXT NOT NULL,
  nb_pieces     INT     NOT NULL DEFAULT 0,
  qte_totale    NUMERIC NOT NULL DEFAULT 0,
  valeur_totale NUMERIC NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_agr_unique ON sc_snapshot_agregats (mois, dimension, cle);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. RÉCEPTIONS — alimenté par le sync ERP (diff de stock jour/jour)
-- ═══════════════════════════════════════════════════════════════════════

-- Toute entrée de stock détectée par le sync Traction. Contrairement à
-- lots_retournables (limité aux 11 fournisseurs ayant une politique de retour),
-- on trace ICI toutes les réceptions, tous fournisseurs confondus : c'est la
-- base de l'alerte « commande trop importante rentrée en inventaire ».
CREATE TABLE IF NOT EXISTS sc_receptions (
  id                 BIGSERIAL PRIMARY KEY,
  date_reception     DATE NOT NULL,
  detecte_le         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  code_piece         TEXT NOT NULL,
  description        TEXT,
  fournisseur        TEXT NOT NULL DEFAULT 'Non assigné',
  code_ligne         TEXT NOT NULL DEFAULT 'N/A',
  qte_recue          NUMERIC NOT NULL,
  cout_unitaire      NUMERIC NOT NULL DEFAULT 0,
  valeur             NUMERIC NOT NULL DEFAULT 0,
  stock_avant        NUMERIC NOT NULL DEFAULT 0,
  stock_apres        NUMERIC NOT NULL DEFAULT 0,

  -- Contexte de décision figé au moment de la réception
  demande_mens       NUMERIC NOT NULL DEFAULT 0,  -- ventes moyennes/mois (12 m glissants)
  couverture_avant   NUMERIC,                     -- mois de stock avant réception
  couverture_apres   NUMERIC,                     -- mois de stock après (NULL = pièce sans vente)
  eoq                NUMERIC,                     -- quantité économique de Wilson

  -- Résultat des 4 déclencheurs
  alerte             BOOLEAN NOT NULL DEFAULT FALSE,
  severite           TEXT CHECK (severite IN ('critique','attention')),
  motifs             JSONB NOT NULL DEFAULT '[]'::JSONB,  -- ['couverture','valeur','eoq','sans_vente']
  exces_unites       NUMERIC NOT NULL DEFAULT 0,  -- unités au-delà de l'horizon cible
  exces_valeur       NUMERIC NOT NULL DEFAULT 0,  -- $ immobilisés en trop

  -- Traitement humain
  vu_le              TIMESTAMPTZ,
  vu_par             TEXT,
  statut             TEXT NOT NULL DEFAULT 'nouveau'
                     CHECK (statut IN ('nouveau','vu','justifie','a_retourner','ignore')),
  commentaire        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_recep_unique ON sc_receptions (date_reception, code_piece);
CREATE INDEX IF NOT EXISTS idx_sc_recep_alerte ON sc_receptions (alerte, statut, date_reception DESC);
CREATE INDEX IF NOT EXISTS idx_sc_recep_fourn ON sc_receptions (fournisseur, date_reception DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. ANALYSE — résultat des agents supply chain (recalculé par le cron)
-- ═══════════════════════════════════════════════════════════════════════

-- Journal des recalculs. Le run_id du dernier run 'termine' est la version
-- servie à l'écran ; les runs plus anciens sont purgés après coup.
CREATE TABLE IF NOT EXISTS sc_runs (
  id             BIGSERIAL PRIMARY KEY,
  run_id         UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  demarre_le     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  termine_le     TIMESTAMPTZ,
  statut         TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours','termine','erreur')),
  declencheur    TEXT NOT NULL DEFAULT 'manuel',  -- 'cron' | 'manuel' | 'sync'
  nb_pieces      INT NOT NULL DEFAULT 0,
  nb_findings    INT NOT NULL DEFAULT 0,
  duree_ms       INT,
  erreur         TEXT,
  log            JSONB NOT NULL DEFAULT '[]'::JSONB,
  kpis           JSONB NOT NULL DEFAULT '{}'::JSONB  -- totaux servis en en-tête d'onglet
);

CREATE INDEX IF NOT EXISTS idx_sc_runs_dernier ON sc_runs (statut, termine_le DESC);

-- Une ligne par pièce suivie (stock ≠ 0, ou vendue sur 12 m, ou en commande).
CREATE TABLE IF NOT EXISTS sc_analyse_pieces (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL,
  code_piece        TEXT NOT NULL,
  description       TEXT,
  fournisseur       TEXT NOT NULL DEFAULT 'Non assigné',
  id_fournisseur    TEXT,
  code_ligne        TEXT NOT NULL DEFAULT 'N/A',

  -- Stock (Traction, temps réel)
  stock             NUMERIC NOT NULL DEFAULT 0,   -- physique total (QTY)
  stock_dispo       NUMERIC NOT NULL DEFAULT 0,   -- QTYMINUSRESERVED
  qte_reserve       NUMERIC NOT NULL DEFAULT 0,
  qte_transit       NUMERIC NOT NULL DEFAULT 0,
  qte_commande      NUMERIC NOT NULL DEFAULT 0,
  qte_min           NUMERIC NOT NULL DEFAULT 0,   -- min Traction (pour comparer au PC calculé)
  qte_max           NUMERIC NOT NULL DEFAULT 0,
  cout_unitaire     NUMERIC NOT NULL DEFAULT 0,
  prix_vente        NUMERIC NOT NULL DEFAULT 0,
  valeur_stock      NUMERIC NOT NULL DEFAULT 0,

  -- Demande (historique_ventes)
  ventes_12m_qte    NUMERIC NOT NULL DEFAULT 0,
  ventes_12m_ca     NUMERIC NOT NULL DEFAULT 0,
  ventes_12m_cogs   NUMERIC NOT NULL DEFAULT 0,   -- coût des ventes = revenus − profit
  ventes_24m_qte    NUMERIC NOT NULL DEFAULT 0,
  mois_actifs_12m   INT     NOT NULL DEFAULT 0,   -- nb de mois avec ≥ 1 vente
  derniere_vente    TEXT,                          -- YYYY-MM
  mois_sans_vente   INT,                           -- NULL = jamais vendue
  demande_mens      NUMERIC NOT NULL DEFAULT 0,   -- moyenne 12 m
  demande_ema       NUMERIC NOT NULL DEFAULT 0,   -- lissée (α = 0.3)
  ecart_type        NUMERIC NOT NULL DEFAULT 0,
  cv                NUMERIC NOT NULL DEFAULT 0,
  tendance_pct      NUMERIC NOT NULL DEFAULT 0,   -- 3 derniers mois vs 3 précédents

  -- Classification
  classe_abc        TEXT NOT NULL DEFAULT 'C',
  classe_xyz        TEXT NOT NULL DEFAULT 'Z',
  -- sur_commande   : vendue une seule fois et sans min/max -> commande speciale,
  --                  son stock a zero n'est pas une rupture
  -- hors_perimetre : ligne Amazon, ventes suivies dans un autre module
  statut            TEXT NOT NULL DEFAULT 'ok'
                    CHECK (statut IN ('rupture','sous_stock','ok','surstock','mort',
                                      'dormant','jamais_vendue','sur_commande','hors_perimetre')),

  -- Métriques supply chain
  rotation          NUMERIC NOT NULL DEFAULT 0,   -- COGS 12 m ÷ stock moyen $
  dsi_jours         NUMERIC,                      -- 365 ÷ rotation (NULL si rotation = 0)
  couverture_mois   NUMERIC,                      -- stock ÷ demande mensuelle (NULL si pas de demande)
  stock_securite    NUMERIC NOT NULL DEFAULT 0,
  point_commande    NUMERIC NOT NULL DEFAULT 0,
  eoq               NUMERIC NOT NULL DEFAULT 0,   -- Wilson
  qte_a_commander   NUMERIC NOT NULL DEFAULT 0,   -- 0 si rien à faire
  nb_commandes_an   NUMERIC NOT NULL DEFAULT 0,
  exces_unites      NUMERIC NOT NULL DEFAULT 0,
  exces_valeur      NUMERIC NOT NULL DEFAULT 0,
  valeur_morte      NUMERIC NOT NULL DEFAULT 0,   -- mort + jamais vendue
  valeur_dormante   NUMERIC NOT NULL DEFAULT 0,   -- sans vente 12 m mais vue sur 24 m
  score_urgence     NUMERIC NOT NULL DEFAULT 0,

  -- Série mensuelle 12 m (pour le sparkline), du plus ancien au plus récent
  serie_12m         JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_sc_ap_run ON sc_analyse_pieces (run_id);
CREATE INDEX IF NOT EXISTS idx_sc_ap_run_fourn ON sc_analyse_pieces (run_id, fournisseur);
CREATE INDEX IF NOT EXISTS idx_sc_ap_run_ligne ON sc_analyse_pieces (run_id, code_ligne);
CREATE INDEX IF NOT EXISTS idx_sc_ap_run_statut ON sc_analyse_pieces (run_id, statut);
CREATE INDEX IF NOT EXISTS idx_sc_ap_code ON sc_analyse_pieces (code_piece);

-- Agrégat par fournisseur (≈ 670 lignes) et par code de ligne (≈ 92 lignes).
-- Même table, discriminée par `dimension` : les deux vues de l'onglet sont
-- rigoureusement identiques, seul le regroupement change.
CREATE TABLE IF NOT EXISTS sc_analyse_groupes (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL,
  dimension         TEXT NOT NULL CHECK (dimension IN ('fournisseur','ligne')),
  cle               TEXT NOT NULL,
  id_fournisseur    TEXT,

  nb_pieces         INT NOT NULL DEFAULT 0,
  nb_pieces_stock   INT NOT NULL DEFAULT 0,
  qte_totale        NUMERIC NOT NULL DEFAULT 0,
  valeur_stock      NUMERIC NOT NULL DEFAULT 0,
  part_valeur       NUMERIC NOT NULL DEFAULT 0,   -- % de la valeur d'inventaire
  part_cumulee      NUMERIC NOT NULL DEFAULT 0,   -- Pareto : cumul décroissant
  classe_pareto     TEXT NOT NULL DEFAULT 'C',    -- A/B/C du fournisseur lui-même

  ventes_12m_ca     NUMERIC NOT NULL DEFAULT 0,
  ventes_12m_cogs   NUMERIC NOT NULL DEFAULT 0,
  marge_pct         NUMERIC,
  stock_moyen       NUMERIC NOT NULL DEFAULT 0,   -- moyenne des snapshots (ou stock actuel)
  valeur_hors_perimetre NUMERIC NOT NULL DEFAULT 0,  -- stock Amazon, hors rotation
  nb_snapshots      INT NOT NULL DEFAULT 0,       -- fiabilité du stock moyen
  rotation          NUMERIC NOT NULL DEFAULT 0,
  dsi_jours         NUMERIC,
  couverture_mois   NUMERIC,

  nb_rupture        INT NOT NULL DEFAULT 0,
  nb_sous_stock     INT NOT NULL DEFAULT 0,
  nb_surstock       INT NOT NULL DEFAULT 0,
  nb_mort           INT NOT NULL DEFAULT 0,
  nb_hors_perimetre INT NOT NULL DEFAULT 0,
  nb_dormant        INT NOT NULL DEFAULT 0,
  valeur_exces      NUMERIC NOT NULL DEFAULT 0,
  valeur_morte      NUMERIC NOT NULL DEFAULT 0,
  valeur_dormante   NUMERIC NOT NULL DEFAULT 0,
  valeur_retournable NUMERIC NOT NULL DEFAULT 0,  -- croisé avec lots_retournables
  nb_negatifs       INT NOT NULL DEFAULT 0,
  nb_alertes_recep  INT NOT NULL DEFAULT 0,

  valeur_mois_prec  NUMERIC,                      -- snapshot du mois précédent
  variation_pct     NUMERIC,                      -- évolution de la valeur de stock
  score_sante       NUMERIC NOT NULL DEFAULT 0    -- 0-100, synthèse pour le tri
);

CREATE INDEX IF NOT EXISTS idx_sc_ag_run ON sc_analyse_groupes (run_id, dimension);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_ag_unique ON sc_analyse_groupes (run_id, dimension, cle);

-- Constats produits par les agents. Bornés (top N par agent) pour rester
-- lisibles : on garde ce sur quoi il y a de l'argent à faire.
CREATE TABLE IF NOT EXISTS sc_findings (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL,
  agent           TEXT NOT NULL,      -- pareto | rotation | wilson | service | surstock | stock_mort | rupture | reception | fiabilite
  severite        TEXT NOT NULL CHECK (severite IN ('critique','attention','info')),
  code_piece      TEXT,
  fournisseur     TEXT,
  code_ligne      TEXT,
  titre           TEXT NOT NULL,
  detail          TEXT NOT NULL,      -- explication en clair du calcul
  action          TEXT NOT NULL,      -- ce qu'il faut faire
  impact_dollars  NUMERIC NOT NULL DEFAULT 0,
  donnees         JSONB NOT NULL DEFAULT '{}'::JSONB,
  rang            INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sc_find_run ON sc_findings (run_id, agent, rang);
CREATE INDEX IF NOT EXISTS idx_sc_find_fourn ON sc_findings (run_id, fournisseur);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. IMPORTS DE VENTES — journal (pour savoir quel mois a été chargé)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sc_imports_ventes (
  id             BIGSERIAL PRIMARY KEY,
  mois           TEXT NOT NULL,           -- YYYY-MM
  fichier        TEXT,
  nb_lignes      INT NOT NULL DEFAULT 0,
  qte_totale     NUMERIC NOT NULL DEFAULT 0,
  ca_total       NUMERIC NOT NULL DEFAULT 0,
  cogs_total     NUMERIC NOT NULL DEFAULT 0,
  profit_total   NUMERIC NOT NULL DEFAULT 0,
  remplace       INT NOT NULL DEFAULT 0,  -- nb de lignes écrasées (ré-import du même mois)
  importe_le     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  importe_par    TEXT,
  avertissements JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_sc_imp_mois ON sc_imports_ventes (mois, importe_le DESC);

-- ── Normalisation de historique_ventes ────────────────────────────────
-- Le rapport Traction 2891 émet PLUSIEURS lignes pour un même code dans le
-- même mois (prix ou client différents, retours en négatif…). L'ancien import
-- les insérait telles quelles : 2 275 groupes (code, mois) portent aujourd'hui
-- 2 lignes ou plus, dont 1 968 avec des valeurs DIFFÉRENTES — ce sont des
-- ventes réelles, pas des doublons d'import.
--
-- Elles doivent donc être ADDITIONNÉES, surtout pas supprimées : supprimer
-- effacerait des ventes et sous-évaluerait la demande. On consolide en une
-- ligne par (code_piece, mois), puis on pose l'unicité qui rend le ré-import
-- mensuel idempotent (upsert au lieu d'insert).
WITH agrege AS (
  SELECT code_piece, mois,
         SUM(quantite) AS quantite,
         SUM(revenus)  AS revenus,
         SUM(profit)   AS profit,
         MIN(id)       AS garde
  FROM historique_ventes
  GROUP BY code_piece, mois
  HAVING COUNT(*) > 1
)
UPDATE historique_ventes h
   SET quantite = a.quantite, revenus = a.revenus, profit = a.profit
  FROM agrege a
 WHERE h.id = a.garde;

DELETE FROM historique_ventes h
 USING (
   SELECT code_piece, mois, MIN(id) AS garde
     FROM historique_ventes GROUP BY code_piece, mois HAVING COUNT(*) > 1
 ) a
 WHERE h.code_piece = a.code_piece AND h.mois = a.mois AND h.id <> a.garde;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hv_piece_mois ON historique_ventes (code_piece, mois);
CREATE INDEX IF NOT EXISTS idx_hv_mois ON historique_ventes (mois);
