-- Seed : les programmes de booking reellement recus (2026-09-03)
-- A executer APRES 2026-09-03_booking.sql, dans Supabase Studio -> SQL Editor.
--
-- Saisi a partir des 27 PDF du dossier booking/. Chaque programme porte son
-- fichier source dans source_fichier : c'est la piece justificative du chiffre.
--
-- TROIS PROGRAMMES SONT OUVERTS AUJOURD'HUI (3 septembre 2026) :
--   · Parts Canada   4 aout -> 15 octobre   (mais l'escompte hatif de 3 %
--                                            tombe a 2 % le 15 SEPTEMBRE)
--   · Mercury Marine 3 aout -> 27 novembre  (l'accumulation PNA de 2 % n'est
--                                            offerte que du 1er au 30 septembre)
--   · Volvo Penta    1er septembre -> 30 octobre
--
-- Les autres sont saisis avec les dates de leur derniere edition connue : la
-- grille est bonne, les dates seront a rafraichir quand le bulletin 2026
-- arrivera. Ils apparaissent « fermes » a l'ecran jusque-la.
--
-- Idempotent : chaque bloc ne s'execute que si son source_fichier est absent.

-- ═══════════════════════════════════════════════════════════════════════
-- PARTS CANADA — Reservation d'automne 2026            OUVERT
-- ═══════════════════════════════════════════════════════════════════════
-- Le programme le plus riche du lot, et le seul dont les baremes par
-- categorie sont reellement calculables : les pieces Parts Canada sont
-- enrichies par les flux catalogue (pneus, casques, chaines, freins...).
--
-- Trois etages qui s'additionnent :
--   1. un escompte hatif qui DECROIT avec la date de reception (3/2/1 %)
--   2. un escompte supplementaire de 3 % sur toutes les categories
--   3. une grille de paliers PAR CATEGORIE, 22 baremes independants
-- Plus 2 % si la commande est confirmee au 22 septembre.
--
-- baremes_exclusifs : une paire de pneus compte dans « Pneus » et nulle part
-- ailleurs. C'est ce qui rend l'optimisation interessante — il faut arbitrer
-- entre pousser les pneus au palier suivant ou pousser les casques.
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = '2026 Fall Booking Program FR.pdf') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut, livraison_fin,
    couvre_debut, couvre_fin, min_commande, baremes_exclusifs, retour_pct,
    notes, source_fichier
  ) VALUES (
    'Reservation-vente d''automne 2026', 'Parts Canada', 'Automne 2026',
    '2026-08-04', '2026-10-15', '2026-10-01', '2027-01-31',
    -- La marchandise arrive a l'automne pour la saison de motoneige et le
    -- printemps moto : on couvre novembre a mai.
    '2026-11-01', '2027-05-31',
    2000, TRUE, 0,
    'Minimum 2 000 $ APRES escomptes. Transport paye sauf regions eloignees. '
    'Articles a prix net exclus de tout escompte. Livraison jusqu''a 8 semaines, '
    'derniere livraison 31 janvier 2027. Paiement par cheque ou virement '
    'uniquement — pas de carte de credit sur les commandes anticipees.',
    '2026 Fall Booking Program FR.pdf'
  ) RETURNING id INTO p_id;

  -- Modalites de paiement du programme : 1/2 le 15 avril, 1/2 le 15 mai 2027.
  -- Depuis une commande passee mi-septembre 2026, c'est ~210 et ~240 jours.
  -- Porte par le palier « global » a 3 %, qui s'applique a tout.
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, franco_port, notes) VALUES
  (p_id, 'supplement automne', 'tout', 1, 'Toutes categories', 2000, 3,
   '[{"part":0.5,"jours":210},{"part":0.5,"jours":240}]'::JSONB, TRUE,
   'Escompte supplementaire de 3 % en plus des escomptes courants en saison, '
   'toutes categories. Porte aussi les modalites 1/2 avril + 1/2 mai 2027.');

  -- Etage 1 : l'escompte hatif, decroissant. Le moteur retient le meilleur
  -- dont la date n'est pas passee.
  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, avant_le, notes) VALUES
  (p_id, 'hatif', 'Recu le ou avant le 15 septembre 2026', 3, '2026-09-15', NULL),
  (p_id, 'hatif', 'Recu le ou avant le 15 octobre 2026',   2, '2026-10-15', NULL),
  (p_id, 'hatif', 'Recu le ou avant le 15 decembre 2026',  1, '2026-12-15',
   'La commande reste possible apres le 15 octobre pour les livraisons tardives.');

  -- Groupe distinct : cet avantage s'AJOUTE a l'escompte de reception, il ne
  -- le remplace pas.
  INSERT INTO sc_booking_bonus (programme_id, type, groupe, libelle, valeur_pct, avant_le, notes) VALUES
  (p_id, 'hatif', 'paiement rapide', 'Avantage paiement rapide : confirme au 22 septembre', 2, '2026-09-22',
   'Uniquement sur les produits livres et factures. Ne comprend pas les commandes en souffrance.');

  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, notes) VALUES
  (p_id, 'transport', 'Transport paye sur les commandes anticipees', 0,
   'Sauf regions eloignees. Hayon facture 50 $.');

  -- Etage 3 : les 22 baremes par categorie.
  -- cible se compare sans accent ni casse, en « contient » : « Pneus » attrape
  -- « Pneus de Motocyclette » et « Pneus de VTT/UTV ».
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, cible, rang, niveau, seuil_montant, escompte_pct) VALUES
  -- Pneus : 11 731 $ de stock, la plus grosse famille Parts Canada
  (p_id,'Pneus','categorie','{Pneus}',1,'Niveau 1', 2000,10),
  (p_id,'Pneus','categorie','{Pneus}',2,'Niveau 2', 5000,15),
  (p_id,'Pneus','categorie','{Pneus}',3,'Niveau 3',10000,18),
  (p_id,'Pneus','categorie','{Pneus}',4,'Niveau 4',15000,20),
  (p_id,'Pneus','categorie','{Pneus}',5,'Niveau 5',25000,22),
  (p_id,'Pneus','categorie','{Pneus}',6,'Niveau 6',30000,25),
  -- Casques
  (p_id,'Casques','categorie','{Casques}',1,'Niveau 1', 1500, 5),
  (p_id,'Casques','categorie','{Casques}',2,'Niveau 2', 3000, 7),
  (p_id,'Casques','categorie','{Casques}',3,'Niveau 3', 6000,11),
  (p_id,'Casques','categorie','{Casques}',4,'Niveau 4',12000,14),
  (p_id,'Casques','categorie','{Casques}',5,'Niveau 5',25000,16),
  (p_id,'Casques','categorie','{Casques}',6,'Niveau 6',50000,18),
  -- Chaines d'entrainement
  (p_id,'Chaines','categorie','{Chaine,Chaînes}',1,'Niveau 1', 750, 5),
  (p_id,'Chaines','categorie','{Chaine,Chaînes}',2,'Niveau 2',1000, 7),
  (p_id,'Chaines','categorie','{Chaine,Chaînes}',3,'Niveau 3',1250,10),
  (p_id,'Chaines','categorie','{Chaine,Chaînes}',4,'Niveau 4',1500,12),
  (p_id,'Chaines','categorie','{Chaine,Chaînes}',5,'Niveau 5',2500,15),
  (p_id,'Chaines','categorie','{Chaine,Chaînes}',6,'Niveau 6',4000,18),
  -- Freins
  (p_id,'Frein','categorie','{FREIN}',1,'Niveau 1', 750, 8),
  (p_id,'Frein','categorie','{FREIN}',2,'Niveau 2',1000,10),
  (p_id,'Frein','categorie','{FREIN}',3,'Niveau 3',1250,12),
  (p_id,'Frein','categorie','{FREIN}',4,'Niveau 4',1500,14),
  (p_id,'Frein','categorie','{FREIN}',5,'Niveau 5',2500,16),
  (p_id,'Frein','categorie','{FREIN}',6,'Niveau 6',3500,17),
  -- Batteries
  (p_id,'Batteries','categorie','{Batterie}',1,'Niveau 1', 1000, 7),
  (p_id,'Batteries','categorie','{Batterie}',2,'Niveau 2', 1500,10),
  (p_id,'Batteries','categorie','{Batterie}',3,'Niveau 3', 3000,12),
  (p_id,'Batteries','categorie','{Batterie}',4,'Niveau 4', 4500,15),
  (p_id,'Batteries','categorie','{Batterie}',5,'Niveau 5', 6500,18),
  (p_id,'Batteries','categorie','{Batterie}',6,'Niveau 6',12000,21),
  -- Lunettes
  (p_id,'Lunettes','categorie','{Lunette}',1,'Niveau 1',  750, 5),
  (p_id,'Lunettes','categorie','{Lunette}',2,'Niveau 2', 1000,10),
  (p_id,'Lunettes','categorie','{Lunette}',3,'Niveau 3', 2000,12),
  (p_id,'Lunettes','categorie','{Lunette}',4,'Niveau 4', 4000,15),
  (p_id,'Lunettes','categorie','{Lunette}',5,'Niveau 5', 8000,18),
  (p_id,'Lunettes','categorie','{Lunette}',6,'Niveau 6',15000,20),
  -- Lubrifiants
  (p_id,'Lubrifiants','categorie','{Huile,Lubrifiant}',1,'Niveau 1',1500,10),
  (p_id,'Lubrifiants','categorie','{Huile,Lubrifiant}',2,'Niveau 2',1750,12),
  (p_id,'Lubrifiants','categorie','{Huile,Lubrifiant}',3,'Niveau 3',2500,15),
  (p_id,'Lubrifiants','categorie','{Huile,Lubrifiant}',4,'Niveau 4',3000,17),
  (p_id,'Lubrifiants','categorie','{Huile,Lubrifiant}',5,'Niveau 5',5000,19),
  (p_id,'Lubrifiants','categorie','{Huile,Lubrifiant}',6,'Niveau 6',7500,21),
  -- Communication
  (p_id,'Communication','categorie','{Communication,Intercom}',1,'Niveau 1', 1000, 5),
  (p_id,'Communication','categorie','{Communication,Intercom}',2,'Niveau 2', 1500, 8),
  (p_id,'Communication','categorie','{Communication,Intercom}',3,'Niveau 3', 3000,12),
  (p_id,'Communication','categorie','{Communication,Intercom}',4,'Niveau 4', 5000,14),
  (p_id,'Communication','categorie','{Communication,Intercom}',5,'Niveau 5',10000,16),
  (p_id,'Communication','categorie','{Communication,Intercom}',6,'Niveau 6',20000,18),
  -- Chasse-neige
  (p_id,'Chasse-neige','categorie','{Chasse-neige,Pelle a neige,Pelle à neige}',1,'Niveau 1', 1500, 7),
  (p_id,'Chasse-neige','categorie','{Chasse-neige,Pelle a neige,Pelle à neige}',2,'Niveau 2', 2000,10),
  (p_id,'Chasse-neige','categorie','{Chasse-neige,Pelle a neige,Pelle à neige}',3,'Niveau 3', 3500,12),
  (p_id,'Chasse-neige','categorie','{Chasse-neige,Pelle a neige,Pelle à neige}',4,'Niveau 4', 5000,15),
  (p_id,'Chasse-neige','categorie','{Chasse-neige,Pelle a neige,Pelle à neige}',5,'Niveau 5',10000,17),
  (p_id,'Chasse-neige','categorie','{Chasse-neige,Pelle a neige,Pelle à neige}',6,'Niveau 6',20000,19),
  -- Treuil
  (p_id,'Treuil','categorie','{Treuil}',1,'Niveau 1',  750, 7),
  (p_id,'Treuil','categorie','{Treuil}',2,'Niveau 2', 1000,10),
  (p_id,'Treuil','categorie','{Treuil}',3,'Niveau 3', 2000,12),
  (p_id,'Treuil','categorie','{Treuil}',4,'Niveau 4', 3000,14),
  (p_id,'Treuil','categorie','{Treuil}',5,'Niveau 5', 5000,18),
  (p_id,'Treuil','categorie','{Treuil}',6,'Niveau 6', 7000,20),
  (p_id,'Treuil','categorie','{Treuil}',7,'Niveau 7',11000,22),
  -- Vetements (hors marques nommees)
  (p_id,'Vetements','categorie','{Manteau,Pantalon,Gant,Botte,Vetement,Vêtement}',1,'Niveau 1',  750, 5),
  (p_id,'Vetements','categorie','{Manteau,Pantalon,Gant,Botte,Vetement,Vêtement}',2,'Niveau 2', 1500,10),
  (p_id,'Vetements','categorie','{Manteau,Pantalon,Gant,Botte,Vetement,Vêtement}',3,'Niveau 3', 2500,12),
  (p_id,'Vetements','categorie','{Manteau,Pantalon,Gant,Botte,Vetement,Vêtement}',4,'Niveau 4', 4500,15),
  (p_id,'Vetements','categorie','{Manteau,Pantalon,Gant,Botte,Vetement,Vêtement}',5,'Niveau 5', 9000,18),
  (p_id,'Vetements','categorie','{Manteau,Pantalon,Gant,Botte,Vetement,Vêtement}',6,'Niveau 6',15000,20);

  -- Les baremes par MARQUE. Ils passent avant les baremes par categorie :
  -- un casque Icon compte dans « Icon », pas dans « Casques ».
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, cible, rang, niveau, seuil_montant, escompte_pct) VALUES
  (p_id,'All Balls','marque','{All Balls}',1,'Niveau 1', 750, 8),
  (p_id,'All Balls','marque','{All Balls}',2,'Niveau 2',1500,10),
  (p_id,'All Balls','marque','{All Balls}',3,'Niveau 3',2000,12),
  (p_id,'All Balls','marque','{All Balls}',4,'Niveau 4',3000,15),
  (p_id,'All Balls','marque','{All Balls}',5,'Niveau 5',4000,18),
  (p_id,'All Balls','marque','{All Balls}',6,'Niveau 6',5000,20),

  (p_id,'Alpinestars','marque','{ALPINESTARS}',1,'Niveau 1', 3500, 5),
  (p_id,'Alpinestars','marque','{ALPINESTARS}',2,'Niveau 2', 7000, 7),
  (p_id,'Alpinestars','marque','{ALPINESTARS}',3,'Niveau 3',12000,10),
  (p_id,'Alpinestars','marque','{ALPINESTARS}',4,'Niveau 4',20000,12),
  (p_id,'Alpinestars','marque','{ALPINESTARS}',5,'Niveau 5',30000,14),
  (p_id,'Alpinestars','marque','{ALPINESTARS}',6,'Niveau 6',50000,17),

  (p_id,'Camoplast','marque','{CAMOPLAST,Camso}',1,'Niveau 1', 1500, 5),
  (p_id,'Camoplast','marque','{CAMOPLAST,Camso}',2,'Niveau 2', 2500,10),
  (p_id,'Camoplast','marque','{CAMOPLAST,Camso}',3,'Niveau 3', 5000,12),
  (p_id,'Camoplast','marque','{CAMOPLAST,Camso}',4,'Niveau 4', 7500,15),
  (p_id,'Camoplast','marque','{CAMOPLAST,Camso}',5,'Niveau 5',10000,17),
  (p_id,'Camoplast','marque','{CAMOPLAST,Camso}',6,'Niveau 6',20000,19),

  (p_id,'NGK','marque','{NGK}',1,'Niveau 1', 750,20),
  (p_id,'NGK','marque','{NGK}',2,'Niveau 2',1000,25),
  (p_id,'NGK','marque','{NGK}',3,'Niveau 3',1500,27),
  (p_id,'NGK','marque','{NGK}',4,'Niveau 4',2000,29),
  (p_id,'NGK','marque','{NGK}',5,'Niveau 5',3000,30),
  (p_id,'NGK','marque','{NGK}',6,'Niveau 6',6000,32),

  (p_id,'Icon','marque','{ICON}',1,'Niveau 1', 1500, 5),
  (p_id,'Icon','marque','{ICON}',2,'Niveau 2', 3000,10),
  (p_id,'Icon','marque','{ICON}',3,'Niveau 3', 5000,12),
  (p_id,'Icon','marque','{ICON}',4,'Niveau 4',12000,15),
  (p_id,'Icon','marque','{ICON}',5,'Niveau 5',20000,18),
  (p_id,'Icon','marque','{ICON}',6,'Niveau 6',30000,20),

  (p_id,'Thor','marque','{THOR}',1,'Niveau 1', 1500, 5),
  (p_id,'Thor','marque','{THOR}',2,'Niveau 2', 3000,10),
  (p_id,'Thor','marque','{THOR}',3,'Niveau 3', 5000,12),
  (p_id,'Thor','marque','{THOR}',4,'Niveau 4',12000,15),
  (p_id,'Thor','marque','{THOR}',5,'Niveau 5',20000,18),
  (p_id,'Thor','marque','{THOR}',6,'Niveau 6',30000,20),

  (p_id,'Z1R','marque','{Z1R}',1,'Niveau 1', 1000, 7),
  (p_id,'Z1R','marque','{Z1R}',2,'Niveau 2', 1500,10),
  (p_id,'Z1R','marque','{Z1R}',3,'Niveau 3', 2500,12),
  (p_id,'Z1R','marque','{Z1R}',4,'Niveau 4', 4500,15),
  (p_id,'Z1R','marque','{Z1R}',5,'Niveau 5', 9000,18),
  (p_id,'Z1R','marque','{Z1R}',6,'Niveau 6',15000,20),

  (p_id,'SW-Motech','marque','{SW-MOTECH,SW MOTECH}',1,'Niveau 1', 2500, 6),
  (p_id,'SW-Motech','marque','{SW-MOTECH,SW MOTECH}',2,'Niveau 2', 4500,10),
  (p_id,'SW-Motech','marque','{SW-MOTECH,SW MOTECH}',3,'Niveau 3',10000,12),
  (p_id,'SW-Motech','marque','{SW-MOTECH,SW MOTECH}',4,'Niveau 4',15000,15),
  (p_id,'SW-Motech','marque','{SW-MOTECH,SW MOTECH}',5,'Niveau 5',25000,17),

  (p_id,'Woody''s','marque','{WOODY}',1,'Niveau 1', 500, 5),
  (p_id,'Woody''s','marque','{WOODY}',2,'Niveau 2', 750, 7),
  (p_id,'Woody''s','marque','{WOODY}',3,'Niveau 3',1500,10),
  (p_id,'Woody''s','marque','{WOODY}',4,'Niveau 4',2500,12),
  (p_id,'Woody''s','marque','{WOODY}',5,'Niveau 5',3500,15),
  (p_id,'Woody''s','marque','{WOODY}',6,'Niveau 6',5000,17),

  (p_id,'C&A Pro Ski','marque','{C&A PRO,C&A}',1,'Niveau 1', 250, 5),
  (p_id,'C&A Pro Ski','marque','{C&A PRO,C&A}',2,'Niveau 2', 500, 7),
  (p_id,'C&A Pro Ski','marque','{C&A PRO,C&A}',3,'Niveau 3', 750,10),
  (p_id,'C&A Pro Ski','marque','{C&A PRO,C&A}',4,'Niveau 4',1000,12),
  (p_id,'C&A Pro Ski','marque','{C&A PRO,C&A}',5,'Niveau 5',1500,15),
  (p_id,'C&A Pro Ski','marque','{C&A PRO,C&A}',6,'Niveau 6',2500,17);

  -- Le residu : tout ce qui n'est tombe dans aucune famille nommee. Grille la
  -- plus severe du programme — c'est ce qui pousse a concentrer la commande.
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau, seuil_montant, escompte_pct, notes) VALUES
  (p_id,'Tout le reste','tout',1,'Niveau 1', 5000, 5,'Bareme residuel : recoit les pieces qui n''appartiennent a aucune famille nommee.'),
  (p_id,'Tout le reste','tout',2,'Niveau 2', 7500, 7,NULL),
  (p_id,'Tout le reste','tout',3,'Niveau 3',10000, 9,NULL),
  (p_id,'Tout le reste','tout',4,'Niveau 4',15000,11,NULL),
  (p_id,'Tout le reste','tout',5,'Niveau 5',25000,13,NULL),
  (p_id,'Tout le reste','tout',6,'Niveau 6',50000,16,NULL);
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- MERCURY MARINE — Precommande d'automne 2026          OUVERT
-- ═══════════════════════════════════════════════════════════════════════
-- Le programme ou la vraie decision n'est pas « combien commander » mais
-- « quel mode de paiement prendre » : 2 % 10 net, OU 1/3 en avril + 1/3 en
-- mai + 1/3 en juin 2027. C'est l'un ou l'autre.
--
-- Le dating fait gagner ~202 jours en moyenne ponderee, soit 4,43 % au cout
-- du capital de 8 %/an, contre 2,00 % pour l'escompte. Le dating gagne de
-- 2,4 points, et il faudrait que l'argent coute moins de 3,6 %/an pour que
-- l'arbitrage bascule. Le moteur refait ce calcul avec le cout du capital
-- reel de sc_config.
--
-- ATTENTION : les 992 pieces Mercury n'ont ni categorie ni marque dans le
-- catalogue enrichi (les flux Kimpex/Motovan ne couvrent pas Mercury). Les
-- rabais par categorie « jusqu'a 10 % » ne sont donc pas calculables piece
-- par piece — ils sont saisis en notes, pas en baremes, pour ne pas produire
-- un chiffre invente.
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'Mercury VP Automne 2026 (courriel)') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut,
    couvre_debut, couvre_fin, min_commande, min_reappro, franco_seuil,
    notes, source_fichier
  ) VALUES (
    'Precommande d''automne 2026 — pieces Mercury', 'Mercury Marine', 'Automne 2026',
    '2026-08-03', '2026-11-27', '2026-12-01',
    -- Preparation de la saison marine 2027 : avril a septembre.
    '2027-04-01', '2027-09-30',
    6000, 2000, 0,
    'Periode de grace jusqu''au 7 aout pour garder le transport gratuit (passee). '
    'Rabais par categorie jusqu''a 10 % sur : pieces compatibles produits '
    'competitifs (nouveau 2026), helices, composantes majeures, composantes '
    'remanufacturees (sauf moteurs Plus Series), bougies, huiles et lubrifiants. '
    'Ces categories ne sont PAS calculables : aucune piece Mercury n''est '
    'enrichie en categorie dans le catalogue. Transport terrestre gratuit sur '
    'les commandes admissibles.',
    'Mercury VP Automne 2026 (courriel)'
  ) RETURNING id INTO p_id;

  -- L'option dating. Depuis une commande de septembre 2026 : avril 2027
  -- ~210 j, mai ~240 j, juin ~270 j.
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, franco_port, notes) VALUES
  (p_id, 'global', 'tout', 1, 'Commande initiale', 6000, 0,
   '[{"part":0.3333,"jours":210},{"part":0.3333,"jours":240},{"part":0.3334,"jours":270}]'::JSONB,
   TRUE,
   'Paiements reportes : 1/3 avril 2027, 1/3 mai 2027, 1/3 juin 2027. '
   'Alternative — et non cumulable — a l''escompte 2 % 10 net.');

  -- L'alternative : l'escompte de paiement rapide. Le moteur compare les deux
  -- et retient le meilleur au cout du capital configure.
  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, jours, notes) VALUES
  (p_id, 'paiement_rapide', '2 % 10 net', 2, 10,
   'Exclusif du dating 1/3 avril-mai-juin. Le moteur retient le plus avantageux des deux.');

  -- Le programme de batteries Precision : un palier en UNITES, pas en dollars.
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, cible, rang, niveau,
    seuil_montant, seuil_qte, escompte_pct, notes) VALUES
  (p_id, 'Batteries Precision', 'categorie', '{Batterie}', 1, '100 unites',
   0, 100, 15,
   'Une seule commande de plus de 100 batteries Mercury Precision a tout '
   'moment dans la saison donne 15 %. Seuil en UNITES.');

  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, avant_le, notes) VALUES
  (p_id, 'hatif', 'Accumulation PNA gratuite de 2 %', 2, '2026-09-30',
   'Offerte sur tous les produits admissibles commandes entre le 1er et le '
   '30 septembre 2026. Cette fenetre se ferme dans quelques semaines.');

  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, axe, cible, notes) VALUES
  (p_id, 'sous_ensemble', 'Rabais supplementaire de 5 % sur les huiles', 5,
   'categorie', '{Huile,Lubrifiant}',
   'Applicable aux quantites en PALETTES de certains produits d''huile admissibles. '
   'Le moteur ne verifie pas la condition de palette.');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- VOLVO PENTA — Genuine Parts Seasonal Maintenance      OUVERT
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'Genuine Parts Seasonal Maintenance.pdf') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le,
    couvre_debut, couvre_fin, min_commande, notes, source_fichier
  ) VALUES (
    'Genuine Parts Seasonal Maintenance', 'Volvo Penta Canada Inc.', 'Automne 2026',
    '2026-09-01', '2026-10-30',
    '2027-04-01', '2027-09-30',
    2000,
    'Minimum 2 000 $ CAD APRES escompte, sur les produits admissibles seulement : '
    'anodes, filtres, produits chimiques, impulseurs. La liste exacte parait le '
    '1er septembre sur Parts LinQ DFS > Promotions. Termes de paiement standards '
    '— ce programme n''apporte aucun dating. Ne pas saisir de Promotion ID : le '
    'systeme calcule l''escompte a la ligne quand le minimum est atteint.',
    'Genuine Parts Seasonal Maintenance.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, notes) VALUES
  (p_id, 'global', 'tout', 1, 'Produits admissibles', 2000, 10,
   'Le perimetre exact (anodes, filtres, chimiques, impulseurs) n''est pas '
   'calculable : les pieces Volvo Penta ne sont pas enrichies en categorie. '
   'Le montant propose est donc a verifier contre la liste du fournisseur.');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- KTM / HUSQVARNA / GASGAS — Programme de PV&A d'automne
-- ═══════════════════════════════════════════════════════════════════════
-- Dates de l'edition 2025 : a rafraichir des reception du bulletin 2026.
-- La grille, elle, est reconduite d'annee en annee.
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier LIKE '09_2025_SEPT_GRP_GRPB-2516%') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, fournisseurs_alt, saison, ouvre_le, ferme_le,
    livraison_debut, couvre_debut, couvre_fin, min_commande, retour_pct,
    notes, source_fichier
  ) VALUES (
    'Programme de commande PV&A d''automne', 'Ktm Canada Inc. (GE)',
    '{"Husqvarna Motorcycles Nort"}', 'Automne 2025',
    '2025-09-19', '2025-10-31', '2025-11-15',
    '2025-12-01', '2026-06-30',
    3000, 0,
    'DATES DE L''EDITION 2025 — a rafraichir quand le bulletin 2026 arrivera ; '
    'la grille est reconduite chaque annee. Couvre KTM, Husqvarna et GasGas. '
    'Tous les produits commandes dans le programme sont admissibles aux '
    'avantages d''ECHANGE, ce qui reduit fortement le risque d''un etirement. '
    'EXCLUS : Factory Replica STACYC, Teamwear Red Bull, equipements de '
    'l''environnement de vente, velos Husqvarna/GasGas, outils de service. '
    'Prevoir 10 a 14 jours ouvrables de traitement.',
    '09_2025_SEPT_GRP_GRPB-2516_KTM+HQV+GAS_FALL_PG&A Stocking Program_CAN_FRE_FINAL.pdf'
  ) RETURNING id INTO p_id;

  -- Financement Wells Fargo : 3 ou 4 paiements sur 90 ou 120 jours.
  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, notes) VALUES
  (p_id,'global','tout',1,'Niveau 4', 3000, 3,
   '[{"part":0.3333,"jours":30},{"part":0.3333,"jours":60},{"part":0.3334,"jours":90}]'::JSONB,
   'Financement 90 jours, 3 paiements.'),
  (p_id,'global','tout',2,'Niveau 3',13000, 6,
   '[{"part":0.3333,"jours":30},{"part":0.3333,"jours":60},{"part":0.3334,"jours":90}]'::JSONB,
   'Financement 90 jours, 3 paiements.'),
  (p_id,'global','tout',3,'Niveau 2',28000, 8,
   '[{"part":0.25,"jours":30},{"part":0.25,"jours":60},{"part":0.25,"jours":90},{"part":0.25,"jours":120}]'::JSONB,
   'Financement 120 jours, 4 paiements.'),
  (p_id,'global','tout',4,'Niveau 1',47000,10,
   '[{"part":0.25,"jours":30},{"part":0.25,"jours":60},{"part":0.25,"jours":90},{"part":0.25,"jours":120}]'::JSONB,
   'Financement 120 jours, 4 paiements.');

  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, avant_le, notes) VALUES
  (p_id,'hatif','Rabais commande hative', 5, '2025-10-10',
   'S''ajoute a l''escompte de volume, quel que soit le niveau atteint.');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- KAWASAKI — Commande de pieces et accessoires (Standard)
-- ═══════════════════════════════════════════════════════════════════════
-- Le seul programme du lot a imposer des SOUS-MINIMUMS : le niveau D
-- demande 15 000 $ au total DONT 3 000 $ de pieces d'entretien. Une commande
-- de 15 000 $ de casques ne debloque rien.
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'KAWASAKI PARTS & ACCESSORIES BOOKING Summer 2025 FR.pdf') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut,
    couvre_debut, couvre_fin, franco_seuil, notes, source_fichier
  ) VALUES (
    'Commande de pieces et accessoires — Standard', 'Kawasaki Canada Inc (Andre',
    'Ete 2025', '2025-08-01', '2025-08-31', '2025-09-15',
    '2025-10-01', '2026-03-31',
    500,
    'DATES DE L''EDITION ETE 2025 — a rafraichir. Transport gratuit sur les '
    'commandes standards de plus de 500 $ jusqu''au 28 fevrier, reserve aux '
    'participants du programme. Les pieces d''entretien admissibles au '
    'sous-minimum sont les filtres, plaquettes de frein, courroies, joints '
    'toriques de vidange et rondelles, tels que listes dans l''onglet '
    '« Pieces d''entretien » de K-Web. RETOURS : frais de 25 %. '
    'Une variante « Elite » existe, avec des escomptes superieurs mais un '
    'minimum de vetements et l''identification visuelle installee.',
    'KAWASAKI PARTS & ACCESSORIES BOOKING Summer 2025 FR.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, sous_minimums, echeancier, notes) VALUES
  (p_id,'global','tout',1,'A', 5000, 0, '[]'::JSONB,
   '[{"part":1,"jours":150}]'::JSONB, 'Paiement 25 janvier.'),
  (p_id,'global','tout',2,'B', 5000, 2,
   '[{"axe":"categorie","cible":["Filtre","Plaquette","Courroie","Joint"],"montant":1000,"libelle":"pieces d entretien"}]'::JSONB,
   '[{"part":1,"jours":150}]'::JSONB, 'Paiement 25 janvier. 1 commande d''inventaire bonus.'),
  (p_id,'global','tout',3,'C',10000, 4,
   '[{"axe":"categorie","cible":["Filtre","Plaquette","Courroie","Joint"],"montant":2000,"libelle":"pieces d entretien"}]'::JSONB,
   '[{"part":0.5,"jours":180},{"part":0.5,"jours":210}]'::JSONB, '1/2 le 25 fevrier, 1/2 le 25 mars.'),
  (p_id,'global','tout',4,'D',15000, 8,
   '[{"axe":"categorie","cible":["Filtre","Plaquette","Courroie","Joint"],"montant":3000,"libelle":"pieces d entretien"}]'::JSONB,
   '[{"part":0.3333,"jours":180},{"part":0.3333,"jours":210},{"part":0.3334,"jours":240}]'::JSONB,
   '1/3 fevrier, mars, avril. 3 commandes d''inventaire bonus, 5 d''urgence.'),
  (p_id,'global','tout',5,'E',25000,10,
   '[{"axe":"categorie","cible":["Filtre","Plaquette","Courroie","Joint"],"montant":5000,"libelle":"pieces d entretien"}]'::JSONB,
   '[{"part":0.3333,"jours":210},{"part":0.3333,"jours":240},{"part":0.3334,"jours":270}]'::JSONB,
   '1/3 mars, avril, mai. 4 commandes d''inventaire bonus, 8 d''urgence.'),
  (p_id,'global','tout',6,'F',40000,12,
   '[{"axe":"categorie","cible":["Filtre","Plaquette","Courroie","Joint"],"montant":8000,"libelle":"pieces d entretien"}]'::JSONB,
   '[{"part":0.3333,"jours":210},{"part":0.3333,"jours":240},{"part":0.3334,"jours":270}]'::JSONB,
   '1/3 mars, avril, mai. 5 commandes d''inventaire bonus, 10 d''urgence.');

  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, notes) VALUES
  (p_id,'commandes_bonus','Commandes d''inventaire bonus a 5 %', 5,
   'Utilisables apres approbation de la commande initiale, livraison gratuite, '
   'net 30, sans minimum. Le nombre depend du niveau atteint.');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- CFMOTO (Canada Motor Import) — Booking d'huile Q2
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'OIL BOOKING Q2 26 FR.pdf') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut,
    couvre_debut, couvre_fin, notes, source_fichier
  ) VALUES (
    'Booking d''huile Q2 2026', 'Canada Motor Import (CF Mo', 'Q2 2026',
    '2026-06-08', '2026-06-26', '2026-07-20',
    '2026-08-01', '2027-01-31',
    'Commandes a completer dans Central Force. Aucun formulaire : les rabais '
    'sont payes automatiquement. Une liste d''items eligibles est jointe au '
    'programme (kits de vidange, huiles moteur, huiles de transmission) — elle '
    'n''est pas encore saisie en perimetre, le calcul porte donc sur toutes les '
    'pieces du fournisseur. Le calendrier CFMOTO comporte trois bookings '
    'd''huile par an (janvier, juin, octobre), plus pieces, accessoires et '
    'vetements.',
    'OIL BOOKING Q2 26 FR.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, notes) VALUES
  (p_id,'global','tout',1,'BASIC',  2500, 2,
   '[{"part":0.3333,"jours":30},{"part":0.3333,"jours":60},{"part":0.3334,"jours":90}]'::JSONB,'2 500 $ a 4 999 $.'),
  (p_id,'global','tout',2,'SELECT', 5000, 4,
   '[{"part":0.3333,"jours":30},{"part":0.3333,"jours":60},{"part":0.3334,"jours":90}]'::JSONB,'5 000 $ a 6 999 $.'),
  (p_id,'global','tout',3,'PREMIUM',7000, 6,
   '[{"part":0.3333,"jours":30},{"part":0.3333,"jours":60},{"part":0.3334,"jours":90}]'::JSONB,'7 000 $ a 9 999 $.'),
  (p_id,'global','tout',4,'ELITE', 10000, 9,
   '[{"part":0.3333,"jours":60},{"part":0.3333,"jours":90},{"part":0.3334,"jours":120}]'::JSONB,'10 000 $ a 12 999 $. Floor plan 60/90/120.'),
  (p_id,'global','tout',5,'DIAMOND',13000,11,
   '[{"part":0.3333,"jours":60},{"part":0.3333,"jours":90},{"part":0.3334,"jours":120}]'::JSONB,'13 000 $ et plus. Floor plan 60/90/120.');

  INSERT INTO sc_booking_bonus (programme_id, type, libelle, valeur_pct, avant_le, notes) VALUES
  (p_id,'hatif','Escompte supplementaire commande hative', 1, '2026-06-16',
   'S''ajoute a tous les niveaux.');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- HONDA — Reservation d'automne 2026
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier LIKE '26-003%') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut, livraison_fin,
    couvre_debut, couvre_fin, notes, source_fichier
  ) VALUES (
    'Reservation d''automne 2026 — MC/VTT/PM/marine', 'Honda Canada Inc.', 'Automne 2026',
    '2026-04-03', '2026-05-01', '2026-08-01', '2026-09-30',
    '2026-10-01', '2027-05-31',
    'FENETRE 2026 DEJA FERMEE (3 avril au 1er mai). Aucune prolongation n''est '
    'accordee. Le bulletin ne publie pas de grille de paliers : il annonce '
    '« jusqu''a 12 % » et une periode de financement de 90 jours au lieu de 30. '
    'Le palier saisi porte ce 12 % sans seuil, faute de grille — a corriger des '
    'reception du formulaire Excel eBiz, qui contient les vrais paliers. '
    'Expedition prepayee. Accumule vers l''allocation de retour de pieces desuetes. '
    'Soumission par courriel Excel a mcpe_bookings@ch.honda.com.',
    '26-003 - Réservation des pièces - Automne 2026.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, franco_port, notes) VALUES
  (p_id,'global','tout',1,'Jusqu''a 12 %', 0, 12,
   '[{"part":1,"jours":90}]'::JSONB, TRUE,
   'Taux plafond annonce, sans seuil connu. A remplacer par la vraie grille.');
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- POLARIS — les programmes mensuels
-- ═══════════════════════════════════════════════════════════════════════
-- Polaris ne fait pas de booking annuel : il fait un programme different
-- chaque mois, a taux FIXE, avec un seuil bas. Il n'y a donc rien a optimiser
-- au sens des paliers — la question est seulement « qu'est-ce que je dois
-- acheter, et est-ce que ca vaut 15 % de porter ce stock ».
--
-- Polaris est le premier fournisseur de la concession : 538 349 $ de stock,
-- 6 842 pieces, rotation 1,40.
DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'Q2 26'' ORV Parts Program Write Up US & CAN Dealers.pdf') THEN
    RETURN;
  END IF;

  -- Le programme de pieces ORV de mai : le plus interessant des Polaris,
  -- parce qu'il empile deux baremes qui se CUMULENT.
  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut,
    couvre_debut, couvre_fin, franco_seuil, baremes_exclusifs,
    notes, source_fichier
  ) VALUES (
    'Programme pieces ORV — mai 2026', 'Polaris Canada (GE)', 'Mai 2026',
    '2026-05-01', '2026-05-31', '2026-06-15',
    '2026-06-01', '2026-11-30', 1000, FALSE,
    'FENETRE MAI 2026 FERMEE — Polaris publie un programme different chaque '
    'mois, la grille se reconduit. Les commandes expedient dans les 21 jours '
    'suivant l''approbation. Perimetre : « competitive maintenance parts » — '
    'filtres a air, batteries, roulements, courroies, plaquettes et pieces de '
    'frein, ampoules, bagues, embrayages, filtres a essence, amortisseurs, '
    'arbres, bougies, pignons, suspension, biellettes, outils, kits de roues '
    'de transport. Inclut les pieces ProSeries.',
    'Q2 26'' ORV Parts Program Write Up US & CAN Dealers.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, cible, rang, niveau,
    seuil_montant, seuil_sur, escompte_pct, echeancier, franco_port, notes) VALUES
  (p_id,'global','tout','{}',1,'Volume', 1000,'groupe',15,
   '[{"part":1,"jours":90}]'::JSONB, TRUE, 'Dating 90 jours, un seul versement. Transport gratuit des 1 000 $ net.'),
  -- Le second bareme se CUMULE au premier, et son seuil porte sur la commande
  -- entiere : 5 % de plus sur les roulements des que la COMMANDE fait 1 000 $.
  (p_id,'Roulements, plaquettes, filtres a air','categorie',
   '{Roulement,Plaquette,Filtre a air,FILTRES À AIR}',1,'Supplement', 1000,'commande',5,
   '[]'::JSONB, FALSE, 'S''ajoute aux 15 %, portant ces familles a 20 %.');
END $$;

DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'Storage Program May 26 - US&CA.pdf') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut,
    couvre_debut, couvre_fin, franco_seuil, notes, source_fichier
  ) VALUES (
    'Programme remisage — mai 2026', 'Polaris Canada (GE)', 'Mai 2026',
    '2026-05-01', '2026-05-31', '2026-06-15',
    '2026-09-01', '2027-04-30', 300,
    'FENETRE MAI 2026 FERMEE — grille reconduite chaque annee. Porte sur les '
    'accessoires de remisage, dont la demande est concentree a l''automne : '
    'c''est exactement le cas ou la couverture demandee doit viser septembre a '
    'avril et non les six mois qui suivent la livraison.',
    'Storage Program May 26 - US&CA.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, franco_port, notes) VALUES
  (p_id,'global','tout',1,'Volume', 300, 15,
   '[{"part":0.5,"jours":60},{"part":0.5,"jours":90}]'::JSONB, TRUE,
   'Dating 60 + 90 jours, deux versements.');
END $$;

DO $$
DECLARE p_id BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM sc_booking_programmes WHERE source_fichier = 'Q1 2026 Pro Armor Wheels and Tires - US & CAN.pdf') THEN
    RETURN;
  END IF;

  INSERT INTO sc_booking_programmes (
    nom, fournisseur, saison, ouvre_le, ferme_le, livraison_debut,
    couvre_debut, couvre_fin, franco_seuil, perimetre_marques,
    notes, source_fichier
  ) VALUES (
    'Pro Armor roues et pneus — fevrier 2026', 'Polaris Canada (GE)', 'Fevrier 2026',
    '2026-02-01', '2026-02-28', '2026-03-15',
    '2026-04-01', '2026-09-30', 2000, '{Pro Armor,PRO ARMOR}',
    'FENETRE FEVRIER 2026 FERMEE — grille reconduite. Le taux le plus eleve de '
    'tous les programmes Polaris, sur un perimetre etroit.',
    'Q1 2026 Pro Armor Wheels and Tires - US & CAN.pdf'
  ) RETURNING id INTO p_id;

  INSERT INTO sc_booking_paliers (programme_id, bareme, axe, rang, niveau,
    seuil_montant, escompte_pct, echeancier, franco_port, notes) VALUES
  (p_id,'global','tout',1,'Volume', 2000, 20,
   '[{"part":1,"jours":90}]'::JSONB, TRUE, 'Dating 90 jours depuis la date de commande.');
END $$;
