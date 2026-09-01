-- Migration : saisonnalite du module Rotation & Fournisseurs (2026-09-01)
-- A executer dans Supabase Studio -> SQL Editor.
--
-- Pourquoi : l'activite oscille d'un facteur 4 entre decembre (indice 0,48) et
-- mai (1,89), et les familles ne suivent pas le meme calendrier — la ligne 30
-- culmine en octobre (2,43) quand la ligne TOI culmine en juillet (2,06).
-- Une demande calculee en moyenne plate sur 12 mois donne un point de commande
-- trop bas juste avant la saison et trop haut juste apres : l'inverse de ce
-- qu'il faut. Ces colonnes stockent la correction appliquee, piece par piece.
--
-- Idempotent : tout est en ADD COLUMN IF NOT EXISTS.

-- Reglages
ALTER TABLE sc_config ADD COLUMN IF NOT EXISTS saison_active       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sc_config ADD COLUMN IF NOT EXISTS saison_horizon_mois NUMERIC NOT NULL DEFAULT 3;

COMMENT ON COLUMN sc_config.saison_active IS
  'Corriger la demande par un indice saisonnier. Coupe = moyenne plate sur 12 mois.';
COMMENT ON COLUMN sc_config.saison_horizon_mois IS
  'Horizon de preparation de saison, en mois : sur combien de mois a venir on calcule le besoin.';

-- Resultat du calcul, par piece
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS indice_saison   NUMERIC NOT NULL DEFAULT 1;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS indice_horizon  NUMERIC NOT NULL DEFAULT 1;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS source_saison   TEXT    NOT NULL DEFAULT 'aucune';
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS pic_mois        INT;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS demande_saison  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE sc_analyse_pieces ADD COLUMN IF NOT EXISTS besoin_saison   NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN sc_analyse_pieces.indice_saison IS
  'Indice saisonnier applique au delai fournisseur a venir (1 = mois moyen).';
COMMENT ON COLUMN sc_analyse_pieces.source_saison IS
  'D ou vient l indice : piece (volume et recul suffisants), ligne, global, ou aucune.';
COMMENT ON COLUMN sc_analyse_pieces.pic_mois IS
  'Mois calendaire de pointe (0 = janvier).';
COMMENT ON COLUMN sc_analyse_pieces.demande_saison IS
  'Demande attendue sur l horizon de preparation, corrigee de la saison.';
COMMENT ON COLUMN sc_analyse_pieces.besoin_saison IS
  'Ce qui manque pour tenir cet horizon, compte tenu du stock et de ce qui est en route.';

-- Le tri par besoin de saison est celui de la nouvelle action « Preparer la saison ».
CREATE INDEX IF NOT EXISTS idx_sc_ap_saison ON sc_analyse_pieces (run_id, besoin_saison DESC);
