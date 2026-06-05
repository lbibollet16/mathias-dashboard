-- Migration : robustesse des Pièces Négatives (audit 2026-06-04, étape 4 a/c)
-- À exécuter dans Supabase > SQL Editor. Sans risque : ajoute des colonnes
-- nullable, ne modifie aucune donnée existante.
--
-- Une fois cette migration appliquée, prévenir pour câbler le code :
--   4a) erp/sync : persister qty_total + qte_reservee dans memoire_negatifs ;
--       modale Pièces Négatives : afficher Total / Disponible / Réservé réels ;
--       getAjust : calculer l'ajustement sur le TOTAL physique (dispo+réservé)
--       et non sur le disponible négatif -> supprime la sur-correction des
--       ~12 « négatifs fictifs par réservation ».
--   4c) erp/sync : remplacer le hard-DELETE des négatifs vérifiés par un
--       soft-archive (archive_le = now()) pour conserver causes/photos/justif.

-- 4a) Stock total + quantité réservée au moment de la détection du négatif.
ALTER TABLE memoire_negatifs
  ADD COLUMN IF NOT EXISTS qty_total    NUMERIC,
  ADD COLUMN IF NOT EXISTS qte_reservee NUMERIC;

-- 4c) Archivage logique des négatifs vérifiés (au lieu d'une suppression sèche).
ALTER TABLE negatifs_verifies
  ADD COLUMN IF NOT EXISTS archive_le TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_negatifs_verifies_archive
  ON negatifs_verifies (archive_le);
