-- Migration : exclure des familles d'un programme (2026-09-04)
-- A executer APRES 2026-09-03_booking.sql.
--
-- POURQUOI
-- Presque tous les programmes disent « sauf ». Kimpex : « Tous les produits
-- Moto et VTT/UTV (SAUF LES PRODUITS D'HIVER) ». KTM exclut Teamwear, STACYC
-- et les velos. Parts Canada exclut les articles a prix net.
--
-- Le schema ne savait exclure que par `exclus_codes` — la liste des codes un
-- par un, que personne n'a. Resultat mesure sur la premiere commande Kimpex
-- reelle : 19 lignes de produits d'hiver pour 1 924 $, soit 14 % du panier,
-- que le fournisseur aurait refusees ou non escomptees — de quoi faire tomber
-- sous un palier.
--
-- Trois axes, parce que trois vocabulaires differents servent a exclure :
--   · une MARQUE     « sauf Dainese »
--   · une CATEGORIE  « sauf les casques »
--   · un MOT         « sauf les produits d'hiver » — la seule prise possible
--                    est le libelle de la piece : motoneige, passe-montagne...
--
-- Idempotent.

ALTER TABLE sc_booking_programmes ADD COLUMN IF NOT EXISTS exclus_marques    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE sc_booking_programmes ADD COLUMN IF NOT EXISTS exclus_categories TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE sc_booking_programmes ADD COLUMN IF NOT EXISTS exclus_mots       TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN sc_booking_programmes.exclus_marques IS
  'Marques hors programme. Une piece qui en porte une est ecartee.';
COMMENT ON COLUMN sc_booking_programmes.exclus_categories IS
  'Categories hors programme.';
COMMENT ON COLUMN sc_booking_programmes.exclus_mots IS
  'Mots cherches dans la DESCRIPTION de la piece. Le dernier recours quand l exclusion ne suit ni les marques ni les categories — « sauf les produits d hiver ». A manier avec soin : le moteur annonce combien de pieces et combien de dollars chaque mot a ecartes, pour qu on puisse verifier.';
