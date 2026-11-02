-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query)
-- BEFORE using the Consumables tab on the admin Payments page.
--
-- Two separate records:
--   consumable_purchases     what was bought, the total cost, and who paid up front
--   consumable_contributions what players chipped in; purchase_id is OPTIONAL so a
--                            contribution can be recorded first and linked later
--
-- consumable_purchase_summary adds collected / outstanding / status per purchase.
-- status is 'Open', 'Settled' or 'Over-collected' (more linked than the cost).

CREATE TABLE IF NOT EXISTS public.consumable_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item text NOT NULL,
    quantity integer,
    total_amount numeric(10,2) NOT NULL CHECK (total_amount >= 0),
    paid_by integer REFERENCES public.players(id),
    purchase_date date NOT NULL DEFAULT current_date,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.consumable_contributions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id integer NOT NULL REFERENCES public.players(id),
    amount numeric(10,2) NOT NULL CHECK (amount > 0),
    contribution_date date NOT NULL DEFAULT current_date,
    method text,
    notes text,
    -- Deleting a purchase keeps its contributions; they simply become unlinked.
    purchase_id uuid REFERENCES public.consumable_purchases(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumable_contributions_purchase_id
    ON public.consumable_contributions (purchase_id);

CREATE OR REPLACE VIEW public.consumable_purchase_summary
WITH (security_invoker = true) AS
SELECT
    p.*,
    COALESCE(SUM(c.amount), 0) AS collected,
    p.total_amount - COALESCE(SUM(c.amount), 0) AS outstanding,
    CASE
        WHEN COALESCE(SUM(c.amount), 0) > p.total_amount THEN 'Over-collected'
        WHEN COALESCE(SUM(c.amount), 0) = p.total_amount THEN 'Settled'
        ELSE 'Open'
    END AS status
FROM public.consumable_purchases p
LEFT JOIN public.consumable_contributions c ON c.purchase_id = p.id
GROUP BY p.id;

-- Row Level Security: same open anon/authenticated pattern as the rest of this
-- schema. Access control is the admin gate in the UI (requireAdmin()), not RLS.
ALTER TABLE public.consumable_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumable_contributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "open access" ON public.consumable_purchases
    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "open access" ON public.consumable_contributions
    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
