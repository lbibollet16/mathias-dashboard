-- amazon_product_dimensions — référentiel des dimensions FBA par SKU.
--
-- Deux sources jointes côte à côte :
--   1. Dimensions RÉELLES (actual_*) : entrées par l'opérateur via
--      CSV import OU peuplées depuis un fournisseur (Kimpex/Motovan).
--   2. Dimensions AMAZON (amazon_*) : ce qu'Amazon mesure et utilise
--      pour facturer les fees fulfillment + storage. Sync via SP-API
--      Catalog Items API.
--
-- Pourquoi : Amazon mesure les produits avec Cubiscan à l'arrivée FBA.
-- Si la mesure Amazon est PLUS GRANDE que la réalité, tu paies des fees
-- gonflés à vie sur chaque vente. Détecter ces discrepancies permet de
-- demander une remeasure (Amazon accepte 2× par 30 jours par SKU) et
-- de récupérer les overcharges des 90 derniers jours.
--
-- Ordre de grandeur du gain : 0.50-2 CAD/unité par size tier réduit.
-- Sur 150 FBA SKUs × 5 ventes/mois × 1 CAD ≈ 9 000 CAD/an récurrent.

CREATE TABLE IF NOT EXISTS public.amazon_product_dimensions (
  sku TEXT PRIMARY KEY,
  fnsku TEXT,
  asin TEXT,
  product_name TEXT,

  -- Mesures réelles (cm + kg). Saisies par l'opérateur ou via CSV.
  actual_length_cm NUMERIC(8, 2),
  actual_width_cm NUMERIC(8, 2),
  actual_height_cm NUMERIC(8, 2),
  actual_weight_kg NUMERIC(8, 3),
  actual_source TEXT,                       -- 'csv_import', 'supplier_kimpex', 'manual', etc.
  actual_updated_at TIMESTAMPTZ,

  -- Mesures Amazon (cm + kg). Sync depuis Catalog Items API.
  amazon_length_cm NUMERIC(8, 2),
  amazon_width_cm NUMERIC(8, 2),
  amazon_height_cm NUMERIC(8, 2),
  amazon_weight_kg NUMERIC(8, 3),
  amazon_size_tier TEXT,                    -- ex. 'Small standard', 'Large standard', etc.
  amazon_item_dimensions_raw JSONB,         -- payload brut catalog pour debug
  amazon_synced_at TIMESTAMPTZ,

  -- Calcul de discrepancy (rempli par cron / endpoint detect-discrepancies)
  discrepancy_volume_pct NUMERIC(6, 2),     -- % d'écart volume (Amazon vs actual)
  discrepancy_weight_pct NUMERIC(6, 2),     -- % d'écart poids
  needs_cubiscan_request BOOLEAN DEFAULT false,
  cubiscan_requested_at TIMESTAMPTZ,
  cubiscan_resolved_at TIMESTAMPTZ,
  cubiscan_resolution TEXT,                 -- 'amazon_remeasured_correct', 'amazon_refused', etc.

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amzdims_asin
  ON public.amazon_product_dimensions (asin) WHERE asin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_amzdims_discrepancy
  ON public.amazon_product_dimensions (discrepancy_volume_pct DESC NULLS LAST)
  WHERE needs_cubiscan_request = true;
CREATE INDEX IF NOT EXISTS idx_amzdims_amazon_synced
  ON public.amazon_product_dimensions (amazon_synced_at NULLS FIRST);

COMMENT ON TABLE public.amazon_product_dimensions IS
  'Dimensions FBA par SKU, comparant actual (notre saisie) vs amazon (mesure Cubiscan FBA). Détecte les overcharges fees pour ouvrir un Cubiscan remeasure request.';
COMMENT ON COLUMN public.amazon_product_dimensions.discrepancy_volume_pct IS
  '(amazon_volume - actual_volume) / actual_volume × 100. Positif = Amazon mesure plus grand que la réalité = overcharge probable.';
COMMENT ON COLUMN public.amazon_product_dimensions.needs_cubiscan_request IS
  'Calculé : true si discrepancy_volume_pct > 10 OR discrepancy_weight_pct > 15. Filtre rapide pour l''UI.';
