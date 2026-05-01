-- Migration : corriger les ecart_reconcilie qui incluaient les ventes
-- intermédiaires entre le comptage et la sync ERP (2026-05-01)
-- À exécuter dans Supabase Studio → SQL Editor.
--
-- Bug d'origine : ecart_reconcilie était calculé comme
--   qte_comptee - stock_apres_sync (= stock J+1, après les ventes
--   intermédiaires). Cela amplifiait l'écart par les ventes faites entre
--   le comptage et la sync, ce qui n'a pas de sens comptable.
--
-- Correction : ecart_reconcilie doit représenter l'écart AU MOMENT DU
-- COMPTAGE, donc qte_comptee - qte_systeme.

UPDATE inventaire_comptages
SET ecart_reconcilie = qte_comptee - qte_systeme
WHERE statut = 'reconcilie'
  AND ecart_reconcilie IS NOT NULL
  AND ecart_reconcilie != (qte_comptee - qte_systeme);

-- Vérification (à exécuter après l'UPDATE pour confirmer)
SELECT
  COUNT(*) AS comptages_corriges,
  SUM(ecart_reconcilie) AS somme_ecarts_apres_fix
FROM inventaire_comptages
WHERE statut = 'reconcilie';
