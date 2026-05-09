
CREATE TABLE public.catalog_items (
  sku TEXT PRIMARY KEY,
  product_name TEXT NOT NULL DEFAULT '',
  gtin TEXT NOT NULL DEFAULT '',
  upc TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX catalog_items_lifecycle_idx ON public.catalog_items(lifecycle);
CREATE INDEX catalog_items_last_seen_idx ON public.catalog_items(last_seen_at);

CREATE TABLE public.catalog_sync_state (
  id INT PRIMARY KEY DEFAULT 1,
  cursor TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
  last_sync_at TIMESTAMPTZ,
  last_full_sync_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  pages_this_run INT NOT NULL DEFAULT 0,
  items_this_run INT NOT NULL DEFAULT 0,
  CONSTRAINT singleton CHECK (id = 1)
);

INSERT INTO public.catalog_sync_state (id) VALUES (1);

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_sync_state ENABLE ROW LEVEL SECURITY;

-- Internal tool, no auth: allow public read. Writes only via service role (server fns).
CREATE POLICY "public read catalog_items" ON public.catalog_items FOR SELECT USING (true);
CREATE POLICY "public read catalog_sync_state" ON public.catalog_sync_state FOR SELECT USING (true);
