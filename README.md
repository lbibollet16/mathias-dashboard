# Mathias Marine Sports - Dashboard Next.js

## Stack
- **Next.js 14** (App Router) - Frontend + API Routes
- **Supabase** - Base de données PostgreSQL (remplace Google Sheets)
- **Vercel** - Hébergement + Cron nocturne (remplace n8n Schedule)

## Structure
```
app/
  page.tsx                          ← Dashboard complet (5 onglets)
  layout.tsx                        ← Layout HTML
  api/
    calculateur/route.ts            ← GET: lit le cache Supabase
    calculateur/recalculer/route.ts ← POST: recalcule tout (lancé par Vercel Cron à 2h)
    lots/route.ts                   ← GET: lots retournables
    negatifs/route.ts               ← GET: stocks négatifs
    import-ventes/route.ts          ← POST: import fichier Excel
lib/
  supabase.ts                       ← Client Supabase + logique calcul (EMA, ABC/XYZ, Wilson)
supabase_tables.sql                 ← Tables à créer dans Supabase
vercel.json                         ← Cron 2h AM
```

## Installation en 5 étapes

### 1. Créer le projet Supabase
1. Va sur https://supabase.com et crée un compte
2. Crée un nouveau projet
3. Va dans **SQL Editor** et colle le contenu de `supabase_tables.sql`
4. Copie les clés API dans **Settings > API**

### 2. Configurer les variables d'environnement
```bash
cp .env.local.example .env.local
```
Remplis les valeurs dans `.env.local` :
```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
TRACTION_URL=https://mathias.tractiondk.com/...
FOURNISSEURS_URL=https://docs.google.com/...
```

### 3. Installer et lancer
```bash
npm install
npm run dev
```
Ouvre http://localhost:3000

### 4. Migrer les données depuis Google Sheets
- Exporte tes données de Google Sheets en CSV
- Utilise l'onglet "Importer Ventes" pour charger les données
- OU copie-colle directement dans Supabase via l'interface

### 5. Déployer sur Vercel
```bash
npm install -g vercel
vercel
```
- Configure les variables d'environnement dans le dashboard Vercel
- Le cron s'exécute automatiquement chaque nuit à 2h

### 6. Premier calcul
Après avoir importé des données, lance le calcul manuellement :
```
POST https://votre-app.vercel.app/api/calculateur/recalculer
```
Ou dans le terminal :
```bash
curl -X POST https://votre-app.vercel.app/api/calculateur/recalculer
```

## Avantages vs n8n + Google Sheets
| | n8n + Sheets | Next.js + Supabase |
|---|---|---|
| Chargement page | 15-60 sec | < 1 sec |
| CORS | Problèmes constants | Zéro problème |
| Coût | ~20$/mois n8n Cloud | Gratuit (Vercel + Supabase free tier) |
| Fiabilité | Timeouts, boucles | Stable |
| Limites données | Lent avec >10k lignes | Illimité |
