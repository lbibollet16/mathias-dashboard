-- ─────────────────────────────────────────────────────────────────────
--  Amazon Inventory Ledger — journal détaillé des mouvements de stock FBA
--
--  Source : SP-API report GET_LEDGER_DETAIL_VIEW_DATA
--  Doc    : https://developer-docs.amazon.com/sp-api/docs/reports-fba-ledger
--
--  Resoud LA pièce manquante critique de la conciliation FBA. Sans ça,
--  la diff entre snapshot N et N+1 = boîte noire. Avec ça, on peut
--  identifier chaque Lost/Damaged/Found et les croiser avec les
--  reimbursements pour détecter les claims manqués (= $$ à récupérer).
--
--  Event types observés dans le report :
--    • Receipts                    : inbound reçu par FC
--    • CustomerReturns             : returns clients
--    • CustomerShipments           : envoi à client (= vente)
--    • Damaged                     : warehouse damaged
--    • Lost                        : warehouse lost
--    • Found                       : warehouse retrouvé
--    • Disposed                    : Amazon a jeté
--    • Removals                    : removal order shipped out
--    • Misplaced                   : transfert entre FCs
--    • Vendor Returns              : retour fournisseur
--    • Cycle Count                 : ajustement physique inventaire
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.amazon_inventory_ledger (
  id BIGSERIAL PRIMARY KEY,

  -- Date du mouvement (renommé en event_date pour clarté)
  event_date DATE NOT NULL,

  -- Identifiants produit
  fnsku TEXT,
  asin TEXT,
  sku TEXT,                                  -- merchant SKU
  product_name TEXT,

  -- Mouvement
  event_type TEXT NOT NULL,                  -- Receipts, Damaged, Lost, ...
  disposition TEXT,                          -- SELLABLE, UNSELLABLE, RESERVED, ...
  quantity INTEGER NOT NULL,                 -- positif = ajout, négatif = retrait
  reason TEXT,                               -- raison détaillée Amazon
  fulfillment_center TEXT,                   -- FC ID (YYZ1, YYC1, etc.)
  reference_id TEXT,                         -- shipment id, order id, etc.

  -- Métriques pour reconciliation
  country TEXT,                              -- US, CA, MX
  reconciled_date DATE,                      -- date à laquelle Amazon ferme le mouvement
  reconcile_reason TEXT,                     -- ex. 'No reconcile_reason'

  -- Lien optionnel vers reimbursement matché (filled par Phase 2.2)
  matched_reimbursement_id TEXT,             -- si on a trouvé un reimbursement qui couvre

  -- Sync metadata
  raw JSONB,
  synced_at TIMESTAMPTZ DEFAULT now(),

  -- Dedupe : (event_date, sku, event_type, quantity, fulfillment_center) est
  -- presque unique mais pas totalement (2 mêmes events le même jour possible).
  -- On ajoute reference_id pour la robustesse.
  CONSTRAINT amazon_inventory_ledger_natural_key UNIQUE
    (event_date, sku, event_type, quantity, fulfillment_center, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_amzledger_event_date
  ON public.amazon_inventory_ledger (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_amzledger_sku_event_type
  ON public.amazon_inventory_ledger (sku, event_type);
CREATE INDEX IF NOT EXISTS idx_amzledger_lost_damaged_unmatched
  ON public.amazon_inventory_ledger (event_type, matched_reimbursement_id)
  WHERE event_type IN ('Damaged', 'Lost') AND matched_reimbursement_id IS NULL;

COMMENT ON TABLE public.amazon_inventory_ledger IS
  'Journal détaillé des mouvements stock FBA. Source: SP-API GET_LEDGER_DETAIL_VIEW_DATA. Sert à identifier les Lost/Damaged sans reimbursement → claims à faire.';

-- ─────────────────────────────────────────────────────────────────────
--  Claim candidates — events Lost/Damaged éligibles à un reimbursement
--                     mais sans match dans amazon_reimbursements.
--
--  Rempli par Phase 2.2 (cron daily). Chaque candidate a:
--    - days_since_event (pour savoir si éligible — 30j min)
--    - estimated_amount (basé sur prix de vente moyen du SKU)
--    - status (pending/sent/accepted/paid/rejected)
--    - claim_payload (template email/case pré-rempli)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.amazon_claim_candidates (
  id BIGSERIAL PRIMARY KEY,
  ledger_event_id BIGINT REFERENCES public.amazon_inventory_ledger(id) ON DELETE CASCADE,

  -- Copies des champs ledger pour requêtes faciles
  sku TEXT NOT NULL,
  fnsku TEXT,
  asin TEXT,
  event_date DATE NOT NULL,
  event_type TEXT NOT NULL,                  -- 'Lost' ou 'Damaged'
  quantity INTEGER NOT NULL,                 -- toujours positif (qty perdue/cassée)
  fulfillment_center TEXT,
  reference_id TEXT,

  -- Économique
  estimated_unit_price NUMERIC(10,2),        -- prix de vente moyen sur 90j
  estimated_amount NUMERIC(10,2),            -- = unit_price × quantity

  -- Eligibilité
  days_since_event INTEGER,                  -- recalculé chaque cron run
  eligible_to_claim BOOLEAN DEFAULT false,   -- true si days_since_event >= 30 AND <= 540

  -- Workflow
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ignored', 'sent', 'accepted', 'paid', 'rejected', 'expired')),
  claim_payload JSONB,                        -- email body, seller central params, etc.
  sent_at TIMESTAMPTZ,
  sent_by TEXT,                               -- email de l'admin qui a cliqué
  amazon_case_id TEXT,                        -- ref du case Seller Central
  resolved_at TIMESTAMPTZ,
  resolved_amount NUMERIC(10,2),              -- montant effectivement crédité
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT amazon_claim_candidates_unique UNIQUE (ledger_event_id)
);

CREATE INDEX IF NOT EXISTS idx_amzclaim_status
  ON public.amazon_claim_candidates (status);
CREATE INDEX IF NOT EXISTS idx_amzclaim_eligible
  ON public.amazon_claim_candidates (eligible_to_claim, status)
  WHERE eligible_to_claim = true;
CREATE INDEX IF NOT EXISTS idx_amzclaim_estimated_amount
  ON public.amazon_claim_candidates (estimated_amount DESC NULLS LAST)
  WHERE status = 'pending';

COMMENT ON TABLE public.amazon_claim_candidates IS
  'Events Lost/Damaged détectés dans ledger sans reimbursement matché. Cible des claims à faire auprès Amazon.';
