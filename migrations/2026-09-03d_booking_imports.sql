-- Migration : import et validation des programmes de booking (2026-09-03)
-- A executer APRES 2026-09-03_booking.sql.
--
-- POURQUOI
-- Les programmes arrivent par courriel sur booking@mathiasms.com, en PDF, en
-- Excel, en corps de message, ou sous forme de lien vers un portail
-- concessionnaire. Les saisir a la main coute une heure par programme quand la
-- grille est celle de Parts Canada — 132 paliers a recopier.
--
-- L'extraction se fait par Claude en vision native. Elle est bonne mais pas
-- parfaite, et ces chiffres pilotent des commandes a cinq chiffres. Rien
-- n'entre donc directement dans sc_booking_programmes : tout atterrit ici, en
-- « a valider », avec le niveau de confiance et la liste des incertitudes que
-- le modele a lui-meme signalees. Un humain promeut.
--
-- Idempotent.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Le journal des documents recus
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sc_booking_imports (
  id                BIGSERIAL PRIMARY KEY,

  -- D'ou vient le document
  source            TEXT NOT NULL DEFAULT 'courriel'
                    CHECK (source IN ('courriel','televerse','dossier')),
  gmail_message_id  TEXT,           -- pour ne jamais retraiter deux fois
  gmail_thread_id   TEXT,
  expediteur        TEXT,
  destinataire      TEXT,
  objet             TEXT,
  recu_le           TIMESTAMPTZ,
  corps_texte       TEXT,           -- le corps du courriel, quand il porte le programme

  nom_fichier       TEXT,
  type_fichier      TEXT,           -- application/pdf, xlsx, message/rfc822...
  taille_octets     BIGINT,

  -- Ou en est ce document
  --   nouveau        recu, pas encore analyse
  --   extrait        l'IA a rendu une structure
  --   a_valider      en attente de relecture humaine
  --   valide         promu en programme (voir programme_id)
  --   rejete         ce n'etait pas un programme, ou il fait doublon
  --   lien_seulement le programme est derriere un portail : rien a extraire
  --   erreur         l'extraction a echoue
  statut            TEXT NOT NULL DEFAULT 'nouveau'
                    CHECK (statut IN ('nouveau','extrait','a_valider','valide',
                                      'rejete','lien_seulement','erreur')),

  -- Ce que l'IA a produit, brut. On garde la reponse complete : c'est la piece
  -- justificative si un chiffre du programme est conteste plus tard.
  extraction        JSONB,
  confiance         NUMERIC,        -- 0 a 1, tel qu'annonce par le modele
  incertitudes      TEXT[] NOT NULL DEFAULT '{}',
  liens_portail     TEXT[] NOT NULL DEFAULT '{}',
  modele            TEXT,
  duree_ms          INT,
  erreur            TEXT,

  -- Le rapprochement au fournisseur de l'ERP
  fournisseur_annonce  TEXT,        -- « CFMOTO », tel que le document le nomme
  fournisseur_traction TEXT,        -- « Canada Motor Import (CF Mo », le vrai

  -- Le programme cree lors de la validation
  programme_id      BIGINT REFERENCES sc_booking_programmes(id) ON DELETE SET NULL,

  commentaire       TEXT,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  traite_par        TEXT
);

-- Le garde-fou contre les doublons : un message Gmail ne s'analyse qu'une fois,
-- meme si le cron repasse ou si on relance un rattrapage d'historique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_bi_gmail
  ON sc_booking_imports (gmail_message_id, nom_fichier)
  WHERE gmail_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sc_bi_statut ON sc_booking_imports (statut, recu_le DESC);

COMMENT ON TABLE sc_booking_imports IS
  'Documents de programme recus, leur extraction IA, et leur etat de validation. Rien ne devient un programme actif sans relecture.';
COMMENT ON COLUMN sc_booking_imports.incertitudes IS
  'Ce dont le modele s est declare incertain. C est la liste que le relecteur doit verifier en priorite.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Les alias de fournisseurs, appris une fois pour toutes
-- ═══════════════════════════════════════════════════════════════════════
--
-- Le feed Traction tronque les noms a 26 caracteres : CFMOTO y devient
-- « Canada Motor Import (CF Mo ». Aucun modele ne devine ca. On le lui donne
-- dans le prompt, et quand un humain corrige un rapprochement, on le retient
-- pour que la question ne se repose jamais.
CREATE TABLE IF NOT EXISTS sc_booking_alias_fournisseurs (
  alias                TEXT PRIMARY KEY,   -- en minuscules, sans accent
  fournisseur_traction TEXT NOT NULL,
  origine              TEXT NOT NULL DEFAULT 'manuel'
                       CHECK (origine IN ('manuel','extraction','seed')),
  cree_le              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cree_par             TEXT
);

INSERT INTO sc_booking_alias_fournisseurs (alias, fournisseur_traction, origine) VALUES
  ('cfmoto',               'Canada Motor Import (CF Mo', 'seed'),
  ('canada motor import',  'Canada Motor Import (CF Mo', 'seed'),
  ('ktm',                  'Ktm Canada Inc. (GE)',       'seed'),
  ('ktm north america',    'Ktm Canada Inc. (GE)',       'seed'),
  ('husqvarna',            'Husqvarna Motorcycles Nort', 'seed'),
  ('gasgas',               'Ktm Canada Inc. (GE)',       'seed'),
  ('kawasaki',             'Kawasaki Canada Inc (Andre', 'seed'),
  ('polaris',              'Polaris Canada (GE)',        'seed'),
  ('parts canada',         'Parts Canada',               'seed'),
  ('honda',                'Honda Canada Inc.',          'seed'),
  ('mercury',              'Mercury Marine',             'seed'),
  ('mercury marine',       'Mercury Marine',             'seed'),
  ('volvo penta',          'Volvo Penta Canada Inc.',    'seed'),
  ('indian motorcycle',    'Indian Motorcycle',          'seed'),
  ('kimpex',               'Kimpex',                     'seed'),
  ('motovan',              'Motovan Corporation',        'seed'),
  ('live to play',         'Live To Play Sports',        'seed')
ON CONFLICT (alias) DO NOTHING;

COMMENT ON TABLE sc_booking_alias_fournisseurs IS
  'Rapprochement entre le nom qu un fournisseur se donne et celui, souvent tronque, du feed Traction.';
