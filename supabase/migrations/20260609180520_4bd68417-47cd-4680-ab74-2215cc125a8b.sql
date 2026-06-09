
ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS brand text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS manufacturer text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS short_description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS main_image_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS price numeric,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sub_category text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country_of_origin text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shipping_weight numeric,
  ADD COLUMN IF NOT EXISTS shipping_weight_unit text NOT NULL DEFAULT 'lb',
  ADD COLUMN IF NOT EXISTS shipping_length numeric,
  ADD COLUMN IF NOT EXISTS shipping_width numeric,
  ADD COLUMN IF NOT EXISTS shipping_height numeric,
  ADD COLUMN IF NOT EXISTS shipping_dim_unit text NOT NULL DEFAULT 'in',
  ADD COLUMN IF NOT EXISTS enrichment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS enrichment_error text,
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrichment_raw jsonb;

CREATE INDEX IF NOT EXISTS catalog_items_enrichment_status_idx
  ON public.catalog_items (enrichment_status, sku);

CREATE TABLE IF NOT EXISTS public.catalog_enrichment_state (
  id integer PRIMARY KEY DEFAULT 1,
  status text NOT NULL DEFAULT 'idle',
  cursor text,
  last_run_at timestamptz,
  last_full_run_at timestamptz,
  processed_this_run integer NOT NULL DEFAULT 0,
  enriched_this_run integer NOT NULL DEFAULT 0,
  partial_this_run integer NOT NULL DEFAULT 0,
  failed_this_run integer NOT NULL DEFAULT 0,
  error text,
  CONSTRAINT singleton_row CHECK (id = 1)
);

GRANT SELECT ON public.catalog_enrichment_state TO anon, authenticated;
GRANT ALL  ON public.catalog_enrichment_state TO service_role;

ALTER TABLE public.catalog_enrichment_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read catalog_enrichment_state" ON public.catalog_enrichment_state;
CREATE POLICY "public read catalog_enrichment_state"
  ON public.catalog_enrichment_state FOR SELECT
  TO anon, authenticated USING (true);

INSERT INTO public.catalog_enrichment_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
