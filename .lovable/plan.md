## Bulk Convert to WFS — Catalog sub-tab

Add a tabbed view inside `/catalog` so you can keep today's identifiers table and add a new bulk-conversion workflow.

### Tabs
- **Identifiers** — current table, filters, export (unchanged).
- **Bulk Convert to WFS** — new view scoped to Seller Fulfilled items.

### Bulk Convert tab — UX
1. **Auto-filter**: only `Seller Fulfilled` + `Seller Fulfilled (WFS eligible)` items. Walmart Fulfilled and Unknown are hidden.
2. **SDS filter row** (default: hide `Likely required` and `Possibly required`, so you start with the safe-to-convert pool). Toggleable.
3. **Search + bulk select** (header checkbox, per-row checkbox, "select all on filtered view").
4. **Per-row warning badge** if SDS = Likely/Possibly required so you can't silently include them.
5. **Convert button** (disabled until ≥1 row selected) → confirmation modal showing count + a final SDS warning if any flagged rows are selected.
6. **Result panel**: shows feedId, accepted/rejected counts, per-SKU errors returned by Walmart.

### Server side
- New `submitWfsConversion` server fn (POST), input: `{ skus: string[] }` (max 500/run, Zod-validated).
- Loads each SKU's cached row from `catalog_items` (sku, productName, gtin/upc) to build the feed payload.
- Calls Walmart **`POST /v3/feeds?feedType=MP_WFS_ITEM`** with a multipart JSON body — minimum fields per SKU: `sku`, `productIdentifiers` (GTIN/UPC), `productName`. Uses existing `getWalmartAccessToken()` + `WALMART_API_BASE_URL`.
- Polls `GET /v3/feeds/{feedId}` once to capture initial status; returns `feedId`, `feedStatus`, `itemsReceived`, `itemsSucceeded`, `itemsFailed`, and any `ingestionErrors`.
- Persists a log row in a new `wfs_conversion_runs` table (feed_id, submitted_at, sku_count, status, raw_response_json) so you can revisit past attempts.

### Important caveat (will be surfaced in the UI)
Walmart's WFS item feed often requires extra attributes (weight, dimensions, hazmat flag, country of origin) for each SKU. The catalog cache doesn't store those. The first run will likely come back with `itemsFailed > 0` and per-SKU errors listing missing fields. The result panel will show those errors verbatim so you know exactly what to fix in Seller Center / next iteration. If you'd rather collect those fields first (weight/dims editor per SKU before submit), say so and I'll add an editable step before the API call.

### Files
- `src/routes/catalog.tsx` — split into tabs (`Tabs` from shadcn), extract current view into `<IdentifiersTab>`, add `<BulkConvertTab>`.
- `src/services/wfs.functions.ts` — add `submitWfsConversion` + helper to build feed payload.
- `src/services/walmartApi.ts` — add `submitWfsItemFeed(payload)` + `getFeedStatus(feedId)`.
- New migration: `wfs_conversion_runs` table (id, feed_id, sku_count, status, response jsonb, created_at) with RLS + GRANTs.
