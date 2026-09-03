-- Migration : empecher les doublons d'import sans piece jointe (2026-09-03)
-- A executer APRES 2026-09-03d_booking_imports.sql.
--
-- LE DEFAUT
-- L'index unique posait sur (gmail_message_id, nom_fichier). Postgres traite
-- deux NULL comme DISTINCTS dans un index unique : un courriel sans piece
-- jointe — ceux dont le programme est dans le corps du message — passait donc
-- au travers, et chaque releve en recreait une ligne.
--
-- Mesure avant correction : 7 groupes en doublon, tous a nom_fichier NULL,
-- et zero doublon parmi les 80 lignes qui ont un nom de fichier. Le garde-fou
-- fonctionnait donc parfaitement... sauf la ou il ne s'appliquait pas.
--
-- Ca ne se voyait pas au debut : il faut relever la meme boite deux fois pour
-- que les doublons apparaissent, ce que seuls un rattrapage d'historique et
-- plusieurs relances d'echecs provoquent.
--
-- LA CORRECTION
-- COALESCE(nom_fichier, '') donne une valeur comparable a la place du NULL.
-- On aurait pu ecrire NULLS NOT DISTINCT (Postgres 15+), mais l'index sur
-- expression marche partout et dit explicitement ce qu'il fait.
--
-- Idempotent : le nettoyage ne supprime que ce qui est en trop, et l'index se
-- recree sans erreur s'il existe deja.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Supprimer les doublons deja crees
-- ═══════════════════════════════════════════════════════════════════════
--
-- On garde la ligne la PLUS ANCIENNE de chaque groupe : c'est elle que
-- d'eventuelles decisions humaines ont pu toucher. Les copies nees des
-- relances suivantes n'apportent rien.
--
-- Sauf si une copie a ete validee et l'originale non : dans ce cas la copie
-- porte un programme_id, et c'est elle qui compte. On trie donc les validees
-- en premier, puis par anciennete.
DELETE FROM sc_booking_imports a
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY gmail_message_id, COALESCE(nom_fichier, '')
           ORDER BY (statut = 'valide') DESC, (programme_id IS NOT NULL) DESC, id ASC
         ) AS rang
  FROM sc_booking_imports
  WHERE gmail_message_id IS NOT NULL
) b
WHERE a.id = b.id AND b.rang > 1;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Le garde-fou qui couvre enfin les courriels sans piece jointe
-- ═══════════════════════════════════════════════════════════════════════
DROP INDEX IF EXISTS idx_sc_bi_gmail;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_bi_gmail
  ON sc_booking_imports (gmail_message_id, COALESCE(nom_fichier, ''))
  WHERE gmail_message_id IS NOT NULL;

COMMENT ON INDEX idx_sc_bi_gmail IS
  'Un document analyse une seule fois. COALESCE et non nom_fichier seul : deux NULL sont distincts pour un index unique, et les courriels sans piece jointe passaient au travers.';
