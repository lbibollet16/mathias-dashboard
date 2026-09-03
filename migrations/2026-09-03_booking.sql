-- Migration : systeme de booking fournisseurs (2026-09-03)
-- A executer dans Supabase Studio -> SQL Editor.
--
-- POURQUOI
-- Un booking, c'est un pari : on immobilise de l'argent des mois avant la
-- saison contre un escompte et des termes de paiement. Le pari est bon quand
-- l'escompte plus la valeur du dating depassent le cout de porter le stock
-- jusqu'a ce qu'il se vende. Aujourd'hui cet arbitrage se fait a l'oeil sur un
-- formulaire Excel du fournisseur, sans regarder ni la rotation, ni la
-- saisonnalite, ni ce qui est deja en route.
--
-- Les 27 programmes du dossier booking/ ont ete depouilles : AUCUN ne
-- fonctionne comme son voisin. On y trouve des paliers en dollars (KTM, 4
-- niveaux de 3 k$ a 47 k$), des paliers PAR CATEGORIE (Parts Canada, 22
-- baremes independants), des sous-minimums conditionnels (Kawasaki : 15 000 $
-- au total DONT 3 000 $ de pieces d'entretien), un escompte qui decroit avec
-- la date (Parts Canada 3 % / 2 % / 1 %), un palier en QUANTITE d'unites
-- (Mercury : 100 batteries), un escompte de paiement rapide en alternative au
-- dating (Mercury 2 % 10 net OU 1/3 avril-mai-juin), et des taux fixes par
-- programme mensuel (Polaris 15 %, 20 %).
--
-- Ce schema modelise ces mecanismes plutot que de les coder en dur, pour qu'un
-- nouveau programme soit une saisie et non un deploiement.
--
-- Idempotent : ADD COLUMN IF NOT EXISTS et CREATE TABLE IF NOT EXISTS partout.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Le cout de l'argent, distinct du cout de possession
-- ═══════════════════════════════════════════════════════════════════════
--
-- taux_possession (25 %) est le cout COMPLET de garder du stock un an :
-- capital immobilise, entreposage, assurance, obsolescence, casse. C'est lui
-- qui entre dans Wilson et qui dit si un dollar de stock supplementaire vaut
-- la peine.
--
-- cout_capital_annuel (8 %) est le cout du seul ARGENT. C'est lui, et lui
-- seul, qui valorise un terme de paiement : payer en avril 2027 plutot qu'en
-- octobre 2026 ne fait pas disparaitre l'entreposage ni l'obsolescence, ca ne
-- fait que reporter la sortie de tresorerie.
--
-- Les confondre fait surestimer le dating d'un facteur trois et pousse a
-- booker n'importe quoi pourvu que les termes soient longs.
ALTER TABLE sc_config ADD COLUMN IF NOT EXISTS cout_capital_annuel   NUMERIC NOT NULL DEFAULT 0.08;
-- Termes de paiement ordinaires, hors programme : la reference a laquelle on
-- compare le dating d'un booking. Un booking « net 30 » n'apporte rien.
ALTER TABLE sc_config ADD COLUMN IF NOT EXISTS termes_standard_jours NUMERIC NOT NULL DEFAULT 30;

COMMENT ON COLUMN sc_config.cout_capital_annuel IS
  'Cout annuel de l argent seul (8 %). Valorise les termes de paiement. A ne pas confondre avec taux_possession (25 %), qui inclut entreposage et obsolescence.';
COMMENT ON COLUMN sc_config.termes_standard_jours IS
  'Termes de paiement hors programme, reference pour chiffrer le gain d un dating.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. De quoi calculer un besoin sur une fenetre QUELCONQUE
-- ═══════════════════════════════════════════════════════════════════════
--
-- sc_analyse_pieces ne stocke aujourd hui que l indice saisonnier agrege sur
-- l horizon configure (3 mois). Un booking couvre une fenetre choisie par
-- l utilisateur — « aout 2026 a mars 2027 » — qui n a aucune raison de
-- coincider. Sans la courbe des 12 mois et la demande desaisonnalisee, on ne
-- peut pas repondre a « combien m en faut-il pour traverser cette periode-la ».
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS demande_deseason NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS indice_12m       JSONB;

COMMENT ON COLUMN sc_analyse_pieces.demande_deseason IS
  'Demande mensuelle desaisonnalisee : a multiplier par l indice du mois vise.';
COMMENT ON COLUMN sc_analyse_pieces.indice_12m IS
  'Courbe saisonniere retenue pour la piece, 12 valeurs de moyenne 1 (janvier en tete).';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Les programmes
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sc_booking_programmes (
  id                BIGSERIAL PRIMARY KEY,
  nom               TEXT NOT NULL,
  fournisseur       TEXT NOT NULL,          -- doit matcher sc_analyse_pieces.fournisseur
  -- Un programme peut couvrir plusieurs fournisseurs Traction : le programme
  -- KTM couvre aussi Husqvarna et GasGas, factures separement.
  fournisseurs_alt  TEXT[] NOT NULL DEFAULT '{}',
  saison            TEXT,                   -- « Automne 2026 »

  -- La fenetre de commande
  ouvre_le          DATE,
  ferme_le          DATE,
  livraison_debut   DATE,
  livraison_fin     DATE,

  -- La periode que la commande doit couvrir. Si NULL, on prend la livraison
  -- plus le nombre de mois choisi a l'ecran. C'est ce qui distingue un booking
  -- d'un reappro : on n'achete pas pour maintenant, on achete pour fevrier.
  couvre_debut      DATE,
  couvre_fin        DATE,

  -- Le perimetre des pieces eligibles. Chaque filtre non vide restreint ;
  -- tous vides = tout le catalogue du fournisseur.
  perimetre_lignes     TEXT[] NOT NULL DEFAULT '{}',
  perimetre_marques    TEXT[] NOT NULL DEFAULT '{}',
  perimetre_categories TEXT[] NOT NULL DEFAULT '{}',  -- match sur categorie_chemin
  perimetre_codes      TEXT[] NOT NULL DEFAULT '{}',  -- liste explicite d'items
  exclus_codes         TEXT[] NOT NULL DEFAULT '{}',

  -- Conditions globales
  min_commande      NUMERIC,        -- montant minimum, apres escomptes
  min_reappro       NUMERIC,        -- minimum d'une commande de rappel
  franco_seuil      NUMERIC,        -- transport gratuit au-dela de ce montant
  transport_pct     NUMERIC,        -- cout de transport evite, en % (si connu)
  retour_pct        NUMERIC,        -- droit de retour accumule, en % de la commande

  -- Les baremes se partagent-ils les pieces, ou se cumulent-ils ?
  --
  -- Chez Parts Canada ils PARTITIONNENT : une paire de pneus compte dans le
  -- bareme « Pneus » et nulle part ailleurs, et « Tout le reste » ramasse ce
  -- qui n'entre dans aucune famille nommee. Chaque piece contribue a un seul
  -- seuil, ce qui change entierement l'optimisation : il faut arbitrer entre
  -- pousser les pneus au palier suivant ou pousser les casques.
  --
  -- Chez Polaris ils se CUMULENT : 15 % sur toute la commande, PLUS 5 % sur
  -- les roulements. Une meme piece touche les deux.
  baremes_exclusifs BOOLEAN NOT NULL DEFAULT FALSE,

  notes             TEXT,
  source_fichier    TEXT,           -- le PDF d'ou vient la saisie
  actif             BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_par           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_bp_four ON sc_booking_programmes (fournisseur) WHERE actif;

COMMENT ON TABLE sc_booking_programmes IS
  'Un programme de reservation fournisseur, tel qu il est ecrit dans son PDF.';
COMMENT ON COLUMN sc_booking_programmes.couvre_debut IS
  'Debut de la periode que la commande doit couvrir. NULL = livraison + duree choisie a l ecran.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Les paliers, groupes en baremes
-- ═══════════════════════════════════════════════════════════════════════
--
-- Un BAREME est une grille de paliers qui se concurrencent : un seul palier
-- s'applique, le meilleur atteint. Deux baremes differents se CUMULENT.
--
-- C'est ce qui permet de representer, avec la meme table :
--   · KTM           un bareme « global », 4 paliers en dollars
--   · Parts Canada  22 baremes, un par categorie, 6 paliers chacun,
--                   qui s'appliquent independamment les uns des autres
--   · Polaris mai   un bareme « global » a 15 % + un bareme « roulements,
--                   plaquettes, filtres » a 5 % qui s'y ajoute
--   · Mercury       un bareme « batteries » dont le seuil est en UNITES
CREATE TABLE IF NOT EXISTS sc_booking_paliers (
  id              BIGSERIAL PRIMARY KEY,
  programme_id    BIGINT NOT NULL REFERENCES sc_booking_programmes(id) ON DELETE CASCADE,

  bareme          TEXT NOT NULL DEFAULT 'global',
  -- Sur quoi porte le bareme.
  axe             TEXT NOT NULL DEFAULT 'tout'
                  CHECK (axe IN ('tout','categorie','marque','ligne','codes')),
  cible           TEXT[] NOT NULL DEFAULT '{}',

  rang            INT  NOT NULL DEFAULT 1,   -- ordre croissant du palier
  niveau          TEXT,                      -- « A », « DIAMOND », « Niveau 3 »

  -- Le seuil. En dollars, ou en unites (Mercury : 100 batteries).
  seuil_montant   NUMERIC NOT NULL DEFAULT 0,
  seuil_qte       NUMERIC,
  -- Le seuil se mesure-t-il sur le sous-ensemble du bareme, ou sur la commande
  -- entiere ? Polaris accorde 5 % de plus sur les roulements des que la
  -- COMMANDE depasse 1 000 $, pas les roulements seuls.
  seuil_sur       TEXT NOT NULL DEFAULT 'groupe' CHECK (seuil_sur IN ('groupe','commande')),

  escompte_pct    NUMERIC NOT NULL DEFAULT 0,

  -- Conditions supplementaires a remplir pour debloquer le palier.
  -- [{"axe":"categorie","cible":["Entretien"],"montant":3000}]
  -- Kawasaki niveau D : 15 000 $ au total DONT 3 000 $ de pieces d'entretien.
  sous_minimums   JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- L'echeancier de paiement du palier, en parts et en jours depuis la
  -- facturation : [{"part":0.3333,"jours":180},{"part":0.3333,"jours":210}...]
  echeancier      JSONB NOT NULL DEFAULT '[]'::JSONB,
  franco_port     BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_bpal_prog ON sc_booking_paliers (programme_id, bareme, rang);

COMMENT ON COLUMN sc_booking_paliers.bareme IS
  'Grille a laquelle appartient le palier. Un seul palier par bareme s applique ; les baremes se cumulent.';
COMMENT ON COLUMN sc_booking_paliers.seuil_sur IS
  'groupe = le seuil se mesure sur le sous-ensemble du bareme ; commande = sur le total.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Les bonus : tout ce qui ne se range pas dans une grille
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sc_booking_bonus (
  id            BIGSERIAL PRIMARY KEY,
  programme_id  BIGINT NOT NULL REFERENCES sc_booking_programmes(id) ON DELETE CASCADE,

  type          TEXT NOT NULL CHECK (type IN (
                  'hatif',           -- escompte si commande avant une date
                  'paiement_rapide', -- 2 % si paye en 10 jours — alternative au dating
                  'sous_ensemble',   -- % de plus sur une famille, sans palier
                  'commandes_bonus', -- N commandes ulterieures a taux reduit
                  'transport')),     -- transport prepaye

  libelle       TEXT NOT NULL,
  valeur_pct    NUMERIC NOT NULL DEFAULT 0,

  -- Deux bonus du meme groupe se CONCURRENCENT : le meilleur applicable gagne.
  -- Deux groupes differents s'ADDITIONNENT.
  --
  -- Parts Canada en a besoin : son escompte de reception (3 % au 15 sept, 2 %
  -- au 15 oct, 1 % au 15 dec) forme une echelle dont un seul echelon compte,
  -- tandis que son avantage de paiement rapide de 2 % au 22 septembre s'y
  -- ajoute. Sans cette distinction, on perd 2 points ou on en invente 3.
  groupe        TEXT NOT NULL DEFAULT 'defaut',

  -- 'hatif' : le meilleur bonus dont la date n'est pas passee s'applique.
  -- Parts Canada : 3 % au 15 sept, 2 % au 15 oct, 1 % au 15 dec = trois lignes.
  avant_le      DATE,
  -- 'paiement_rapide' : 2 % 10 net = valeur_pct 2, jours 10.
  jours         NUMERIC,
  -- 'sous_ensemble' : sur quoi il porte.
  axe           TEXT NOT NULL DEFAULT 'tout'
                CHECK (axe IN ('tout','categorie','marque','ligne','codes')),
  cible         TEXT[] NOT NULL DEFAULT '{}',
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_bbon_prog ON sc_booking_bonus (programme_id, type);

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Les propositions de booking
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sc_bookings (
  id                BIGSERIAL PRIMARY KEY,
  programme_id      BIGINT REFERENCES sc_booking_programmes(id) ON DELETE SET NULL,
  run_id            UUID,                    -- l'analyse sur laquelle il s'appuie
  nom               TEXT NOT NULL,
  statut            TEXT NOT NULL DEFAULT 'brouillon'
                    CHECK (statut IN ('brouillon','envoye','recu','annule')),

  -- Ce qu'on a demande au moteur
  objectif          TEXT NOT NULL DEFAULT 'optimal'
                    CHECK (objectif IN ('optimal','budget','couverture','palier')),
  budget_max        NUMERIC,
  couverture_mois   NUMERIC,
  palier_vise       TEXT,
  date_commande     DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Ce qu'il a repondu
  montant_brut      NUMERIC NOT NULL DEFAULT 0,
  escompte_pct      NUMERIC NOT NULL DEFAULT 0,
  escompte_dollars  NUMERIC NOT NULL DEFAULT 0,
  montant_net       NUMERIC NOT NULL DEFAULT 0,
  dating_jours      NUMERIC NOT NULL DEFAULT 0,   -- delai moyen pondere gagne
  dating_dollars    NUMERIC NOT NULL DEFAULT 0,
  portage_dollars   NUMERIC NOT NULL DEFAULT 0,   -- cout de garder ce stock
  gain_net_dollars  NUMERIC NOT NULL DEFAULT 0,   -- escompte + dating - portage
  nb_lignes         INT     NOT NULL DEFAULT 0,
  -- Le detail du calcul : paliers testes, baremes atteints, ce qui a fait
  -- pencher la decision. C'est ce qui rend le chiffre discutable.
  resume            JSONB   NOT NULL DEFAULT '{}'::JSONB,

  cree_le           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cree_par          TEXT
);

CREATE INDEX IF NOT EXISTS idx_sc_bk_prog ON sc_bookings (programme_id, cree_le DESC);

CREATE TABLE IF NOT EXISTS sc_booking_lignes (
  id              BIGSERIAL PRIMARY KEY,
  booking_id      BIGINT NOT NULL REFERENCES sc_bookings(id) ON DELETE CASCADE,
  rang            INT NOT NULL DEFAULT 0,

  code_piece      TEXT NOT NULL,
  description     TEXT,
  fournisseur     TEXT,
  code_ligne      TEXT,
  marque          TEXT,
  categorie_nom   TEXT,

  cout_unitaire   NUMERIC NOT NULL DEFAULT 0,
  qte             NUMERIC NOT NULL DEFAULT 0,
  montant         NUMERIC NOT NULL DEFAULT 0,
  bareme          TEXT,                    -- le bareme auquel la ligne contribue

  -- Pourquoi elle est la. « besoin » = la periode l'exige. « palier » = ajoutee
  -- pour franchir un seuil, et c'est le portage de celle-la qu'il faut peser.
  motif           TEXT NOT NULL DEFAULT 'besoin'
                  CHECK (motif IN ('besoin','rupture','palier','minimum')),
  qte_besoin      NUMERIC NOT NULL DEFAULT 0,   -- la part justifiee par la demande
  qte_etirement   NUMERIC NOT NULL DEFAULT 0,   -- la part ajoutee pour le seuil

  -- L'etat au moment du calcul, fige pour que la ligne reste lisible plus tard
  stock           NUMERIC NOT NULL DEFAULT 0,
  en_route        NUMERIC NOT NULL DEFAULT 0,
  demande_periode NUMERIC NOT NULL DEFAULT 0,
  couverture_apres NUMERIC,
  classe_abc      TEXT,
  statut_piece    TEXT,
  rotation        NUMERIC,
  portage_dollars NUMERIC NOT NULL DEFAULT 0,

  retenu          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_sc_bkl_bk ON sc_booking_lignes (booking_id, rang);

COMMENT ON COLUMN sc_booking_lignes.qte_etirement IS
  'Unites ajoutees au-dela du besoin pour atteindre un seuil. Leur portage est le prix de l escompte.';
