-- Migration : un bareme qui se cumule malgre l'exclusivite (2026-09-04)
-- A executer APRES 2026-09-03_booking.sql.
--
-- LE DEFAUT, TROUVE DEUX FOIS PAR L'EXTRACTION ELLE-MEME
--
-- `sc_booking_programmes.baremes_exclusifs` est binaire : soit chaque piece
-- ne compte que dans un bareme, soit tous se cumulent. Deux programmes reels
-- exigent les DEUX a la fois.
--
--   Kimpex        onze grilles par marque qui se partagent les pieces,
--                 PLUS un rabais de volume de 1 a 4 % sur le total
--   Parts Canada  vingt-deux grilles par categorie qui se partagent,
--                 PLUS 3 % de reservation sur toutes les categories
--
-- Sans ce drapeau, le bareme general est absorbe par le premier bareme
-- specifique et disparait : la commande Kimpex perdait jusqu'a quatre points,
-- celle de Parts Canada trois.
--
-- Idempotent.

ALTER TABLE sc_booking_paliers
  ADD COLUMN IF NOT EXISTS cumulable BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sc_booking_paliers.cumulable IS
  'Le bareme s ajoute aux autres meme quand le programme est exclusif. Pour les rabais de volume et les supplements generaux, qui portent sur le total de la commande et non sur une famille.';

-- Le bareme « supplement automne » de Parts Canada est de ceux-la : 3 % en
-- plus des escomptes de categorie, et non a leur place.
UPDATE sc_booking_paliers SET cumulable = TRUE
WHERE bareme = 'supplement automne'
  AND programme_id IN (
    SELECT id FROM sc_booking_programmes
    WHERE source_fichier = '2026 Fall Booking Program FR.pdf');
