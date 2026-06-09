CREATE TABLE public.wfs_conversion_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id TEXT,
  sku_count INTEGER NOT NULL DEFAULT 0,
  skus JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'submitted',
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wfs_conversion_runs TO anon, authenticated;
GRANT ALL ON public.wfs_conversion_runs TO service_role;

ALTER TABLE public.wfs_conversion_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read wfs_conversion_runs"
  ON public.wfs_conversion_runs FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE INDEX wfs_conversion_runs_created_at_idx
  ON public.wfs_conversion_runs (created_at DESC);