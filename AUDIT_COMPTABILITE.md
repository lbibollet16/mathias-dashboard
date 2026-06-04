# Audit Comptabilité / Pièces Négatives / Inventaire — 2026-06-04

> Audit multi-agents (27 agents) avec vérification contradictoire sur données réelles
> Supabase + Traction. 15 bugs confirmés sur 18 candidats.

## 1) Pourquoi les chiffres sont faux (3 causes racines)

1. **Le même « écart » est calculé à 4 endroits avec des formules incompatibles**
   (Audit, Compta mono-loc, Compta multi-loc, Sync auto-résolution). Entrées
   incompatibles : stock TOTAL vs comptage d'UNE loc ; stock du jour vs stock J+1 ;
   `reconcilie` seul vs `reconcilie + en_attente`. On corrige un écran, on casse l'autre.
2. **Chaque réception est comptée 2 fois** : le sync tourne 2×/jour mais `stock_hier`
   n'est rafraîchi qu'à chaque passage → valeur des retournables gonflée d'environ +48 %.
3. **Garde-fous manquants** : plafond silencieux à 1000 lignes, DELETE+INSERT non
   atomiques, lots expirés jamais purgés.

## 2) Bugs confirmés par gravité

### 🔴 CRITIQUE
| Bug | Fichier:ligne | Impact mesuré |
|---|---|---|
| Audit compare stock TOTAL à UNE loc → faux « réception » | `app/api/erp/audit-comptabilite/route.ts:21-25,71,81-84,101` | 98 faux SYS_TROP_HAUT / 153 (64 %) ; 190/388 lignes multi-loc |
| Double-comptage des lots retournables (cron 2×/jour + rotation décalée) | `app/api/erp/sync/route.ts:139-168,107-135` + `vercel.json:3-4` | 1588/3714 lots doublons (43 %), 841 actifs ; ~351 428 $ / 738 786 $ (+48 %) |
| Rotation 2×/jour (même cause, autre angle) | `app/api/erp/sync/route.ts:139-168` + `vercel.json:3-4` | 123 doublons exacts ≈ 39 624 $ ; stock_hier = snapshot ~11h, pas J-1 |
| Dédup comptages plafonnée à 1000 / 3454 lignes | `app/api/erp/sync/route.ts:360-363` | 1 pièce faussée aujourd'hui (U6910046/PS7FC) ; s'aggrave avec la croissance |

### 🟠 MAJEUR
| Bug | Fichier:ligne | Impact mesuré |
|---|---|---|
| Ajustement Compta = `qte_comptee − stock_apres_sync` (J+1) au lieu de l'écart figé | `app/page.tsx:6375-6380` | 26 faux ajustements (40 u.), tous sur comptages parfaits ; 21 visibles |
| Couverture inclut `en_attente`, somme n'agrège que `reconcilie` | `app/page.tsx:6288-6293` vs `6315-6317` ; sync `route.ts:296-330` | 1 pièce masquée à tort (2880605) ; récurrent ; auto-résolution efface l'écart |
| Négatif « vérifié » qui s'aggrave reste masqué | `app/page.tsx:4990,4994` ; `negatifs-verifies/route.ts:62-96` | 128/128 masqués ; 3 ont empiré (011299 : −1→−13 ; ZIPVC9975 ; CR1550) |
| Lots expirés jamais purgés (FIFO bloqué) | `erp/sync/route.ts:81,124-133` ; `lots/sync/route.ts:47,64-72` | 209 lots / 6460 u. figées ; 3071 u. fantômes ; 149 540 $ figés |
| Négatif « fictif » par réservation (modale affiche dispo<0 en Total ET Dispo, Réservé=0) | `erp/sync/route.ts:99` ; `page.tsx:5128,5132,5136` | 12 pièces ; sur-correction = qté réservée (20002002G : +8 fantômes) |
| DELETE+INSERT non atomique de `memoire_negatifs` | `erp/sync/route.ts:181-183` | 292 négatifs + 127 165 lignes exposés à perte totale sur insert raté (confiance moyenne) |
| Pièce absente de Traction → comptage `en_attente` éternel + lookup sensible casse | `erp/sync/route.ts:404-405` | 0 cas vif ; risque latent |
| `parseFrNum` supprime les virgules avant conversion (1,5 → 15) | `lib/supabase.ts:16` | 0 ligne touchée (feed en point) ; corruption ×10/×100 si bascule virgule |

### 🟡 MINEUR
| Bug | Fichier:ligne | Impact |
|---|---|---|
| Audit vs Compta non réconciliables | `audit-comptabilite/route.ts:25` vs `page.tsx:6376-6380` | 26 pièces visibles dans un écran, pas l'autre |
| Suppression sans archive des négatifs vérifiés | `erp/sync/route.ts:185-195` | Perte cause/photo/justif ; 4/128 à supprimer au prochain sync |

## 3) Plan de correction recommandé

**Idée centrale : une SEULE fonction d'écart `calculerEcartParPiece(code_piece)`**
qui agrège par pièce (toutes locs), ne retient que `reconcilie`, compare la SOMME
des comptages au snapshot `qte_systeme` du comptage (pas `stock_apres_sync`),
et renvoie `ECART | OK | MULTI_LOC_PARTIEL`. Tous les écrans l'appellent.

- **Étape 0 — Stopper l'hémorragie €** : corriger la rotation `stock_hier`
  (pointer sur le Traction du run courant + idempotence par jour), nettoyer les
  ~1588 lots doublons. → ~351 k$ de surévaluation disparaissent.
- **Étape 1** : créer `calculerEcartParPiece`.
- **Étape 2** : brancher Audit, Compta, Sync dessus → supprime 98 faux SYS_TROP_HAUT,
  26 faux ajustements, réconcilie Audit↔Compta, règle 2880605.
- **Étape 3 — garde-fous** : paginer la dédup, purger lots expirés, garde-fou +
  remplacement atomique de `memoire_negatifs`.
- **Étape 4 — négatifs** : réafficher aggravés, modale Total/Dispo/Réservé corrects,
  soft-archive.
- **Étape 5 — latents** : `parseFrNum` virgule, lookup casse, `en_attente` éternel.

## 4) À faire vérifier par un humain
1. Le bug « dédup 1000 » : cause racine réelle mais impact = **1 pièce**, pas 9 (sur-vendu).
2. Les 2 bugs lots critiques sont le **même bug** : vrai montant entre **39 k$ et 351 k$**,
   à confirmer par comptage physique des lots après nettoyage.
3. Purge lots expirés = **décision métier** : retour fournisseur impossible (purger)
   ou stock encore consommable (inclure au FIFO) ?
4. DELETE+INSERT non atomique : confiance **moyenne**, assurance pas réparation.
5. Risques latents (parseFrNum, casse, en_attente) : 0 impact aujourd'hui.
6. Négatifs : récidive fréquente **réfutée** (1 flip / 281) ; vérifier physiquement
   les 3 pièces aggravées (011299, ZIPVC9975, CR1550).
