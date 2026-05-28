-- amazon_inventory_aging — snapshot d'âge inventaire FBA par SKU/jour.
--
-- Source : SP-API report `GET_FBA_INVENTORY_PLANNING_DATA`, qui inclut
-- les buckets d'âge (0-90, 91-180, 181-270, 271-365, 365+ jours).
--
-- Pourquoi cette table : Amazon facture une **Aged Inventory Surcharge**
-- progressive à partir de 181 jours en stock :
--   - 181-270 jours : 0.50 $/cubic ft/mois
--   - 271-365 jours : 1.50 → 5.45 $/cubic ft/mois
--   - 365+ jours    : 6.90 $/cubic ft/mois (cumulé avec storage mensuel)
--
-- Évaluation Amazon le 15 du mois. Une removal order soumise avant le
-- 14 STOPPE la surcharge pour ce mois. D'où l'intérêt d'un monitoring
-- quotidien pour anticiper les barres et liquider/discount/remover à
-- temps.

CREATE TABLE IF NOT EXISTS public.amazon_inventory_aging (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,

  -- Identifiants produit
  sku TEXT NOT NULL,
  fnsku TEXT,
  asin TEXT,
  product_name TEXT,
  condition TEXT,                        -- New, Used, etc.

  -- Quantités par bucket d'âge
  qty_total INTEGER,
  qty_0_to_90_days INTEGER,
  qty_91_to_180_days INTEGER,
  qty_181_to_270_days INTEGER,           -- 🟡 attention : surcharge active
  qty_271_to_365_days INTEGER,           -- 🟠 surcharge croissante
  qty_365_plus_days INTEGER,             -- 🔴 surcharge max (~6.90$/cubic ft)

  -- Stock total / dispatch
  qty_inbound INTEGER,
  qty_inbound_working INTEGER,
  qty_inbound_shipped INTEGER,
  qty_inbound_received INTEGER,

  -- Estimations Amazon (pour aider la décision sell/remove/dispose)
  estimated_excess_quantity INTEGER,
  recommended_action TEXT,               -- ex. "Reduce sales-price", "Create-removal-order"
  recommended_sales_price NUMERIC(10, 2),
  recommended_sale_duration_days INTEGER,
  estimated_holding_cost_next_30_days NUMERIC(10, 2),

  -- Données brutes pour debug / re-parse futur
  raw JSONB,
  imported_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT amazon_inventory_aging_unique UNIQUE (snapshot_date, sku, fnsku)
);

CREATE INDEX IF NOT EXISTS idx_amzaging_snapshot
  ON public.amazon_inventory_aging (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_amzaging_sku
  ON public.amazon_inventory_aging (sku);
CREATE INDEX IF NOT EXISTS idx_amzaging_at_risk
  ON public.amazon_inventory_aging (snapshot_date DESC, qty_181_to_270_days)
  WHERE qty_181_to_270_days > 0
     OR qty_271_to_365_days > 0
     OR qty_365_plus_days > 0;

COMMENT ON TABLE public.amazon_inventory_aging IS
  'Snapshot d''âge FBA par SKU. Source GET_FBA_INVENTORY_PLANNING_DATA. Sert à détecter les SKUs à risque d''aged inventory surcharge avant la barre du 15 du mois.';
COMMENT ON COLUMN public.amazon_inventory_aging.qty_181_to_270_days IS
  'Surcharge Amazon active à 0.50$/cubic ft/mois. Action : envisager une liquidation.';
COMMENT ON COLUMN public.amazon_inventory_aging.qty_271_to_365_days IS
  'Surcharge progressive jusqu''à 5.45$/cubic ft/mois. Action : removal/discount urgent.';
COMMENT ON COLUMN public.amazon_inventory_aging.qty_365_plus_days IS
  'Surcharge max 6.90$/cubic ft/mois + storage normal. Action immédiate : remove ou disposal.';
