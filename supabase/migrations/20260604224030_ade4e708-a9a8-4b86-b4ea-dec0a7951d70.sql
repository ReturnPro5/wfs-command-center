ALTER TABLE public.catalog_items ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'New';
ALTER TABLE public.catalog_items ADD COLUMN IF NOT EXISTS published_status text NOT NULL DEFAULT '';

ALTER TABLE public.catalog_sync_state ADD COLUMN IF NOT EXISTS published_status text NOT NULL DEFAULT 'PUBLISHED';

CREATE INDEX IF NOT EXISTS catalog_items_condition_idx ON public.catalog_items (condition);
CREATE INDEX IF NOT EXISTS catalog_items_lifecycle_idx ON public.catalog_items (lifecycle);