-- Migration : tracer la couverture par reference interchangeable (2026-09-03)
-- A executer APRES 2026-09-03_booking.sql.
--
-- POURQUOI
-- Le moteur reduit desormais le besoin d'une piece quand une reference
-- equivalente est deja en stock. Sans ces deux colonnes, la quantite proposee
-- devient injustifiable a la relecture : on voit « 2 » sans savoir que le
-- besoin reel etait de 5 et que trois unites dorment sous un autre code.
--
-- Idempotent.

ALTER TABLE sc_booking_lignes ADD COLUMN IF NOT EXISTS alt_couverture NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE sc_booking_lignes ADD COLUMN IF NOT EXISTS alt_codes      TEXT[]  NOT NULL DEFAULT '{}';

COMMENT ON COLUMN sc_booking_lignes.alt_couverture IS
  'Unites du besoin couvertes par une reference interchangeable deja en stock, donc retirees de la commande.';
COMMENT ON COLUMN sc_booking_lignes.alt_codes IS
  'Les codes equivalents qui ont fourni cette couverture.';
