-- amazon_sku_costs — référentiel de coût de revient par SKU Amazon.
--
-- Depuis la modification de la politique FBA de mars 2025, Amazon rembourse
-- les pertes (Lost / Damaged / Carrier Damage) au **coût de sourcing ou de
-- manufacturing**, plus au prix de vente moyen. Notre dashboard claims
-- doit donc connaître ce coût pour produire des estimations réalistes.
--
-- Source canonique : la table `mathias-power-parts.products` (cost_amount).
-- Population recommandée : push périodique depuis MPP via le bridge déjà
-- en place, ou import manuel via /api/amazon/sku-costs/import.
--
-- Si un SKU n'a pas de cost connu ici, claims-detection.ts retourne
-- estimated_amount=NULL pour ce candidat (préférer aucun chiffre qu'un
-- chiffre faux).

CREATE TABLE IF NOT EXISTS amazon_sku_costs (
  sku           text PRIMARY KEY,
  fnsku         text,
  asin          text,
  cost_amount   numeric(12, 4) NOT NULL CHECK (cost_amount >= 0),
  cost_currency text NOT NULL DEFAULT 'CAD',
  source        text, -- 'mpp_bridge' | 'manual_csv' | 'partsfinder' | etc.
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS amazon_sku_costs_fnsku_idx ON amazon_sku_costs (fnsku) WHERE fnsku IS NOT NULL;
CREATE INDEX IF NOT EXISTS amazon_sku_costs_asin_idx  ON amazon_sku_costs (asin)  WHERE asin  IS NOT NULL;

COMMENT ON TABLE  amazon_sku_costs IS
  'Coût de revient par SKU Amazon, alimenté depuis MPP ou import manuel. Utilisé par claims-detection.ts pour estimer les remboursements FBA au coût (politique Amazon mars 2025).';
COMMENT ON COLUMN amazon_sku_costs.cost_amount IS
  'Coût de sourcing / fabrication unitaire. Inclut typiquement : achat fournisseur + shipping inbound vers FBA. Devise dans cost_currency.';
COMMENT ON COLUMN amazon_sku_costs.source IS
  'D''où vient cette valeur : ''mpp_bridge'' pour la sync auto, ''manual_csv'' pour import à la main, etc.';
