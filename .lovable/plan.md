# Show full WFS payload + Walmart diagnostics in Bulk Convert

## Goal
After a Bulk Convert to WFS run, let you see (and download) the exact JSON payload we sent Walmart per group, plus every scrap of diagnostic info Walmart returns — so you can hand it to Walmart support when a SKU fails.

## What changes

### 1. `src/services/wfs.functions.ts` — `submitWfsConversion`
Capture per-group diagnostics we already build but throw away, and return them.

For each group we submit, record:
- `groupIndex`, `productType` / `subCategory` bucket, `itemCount`, `skus[]`
- `feedType` (`OMNI_WFS`), spec `version`, header (`businessUnit`, `locale`, `version`)
- `requestBody` — the exact `feedBody` JSON posted to `/v3/feeds?feedType=OMNI_WFS`
- `specValidation` — `{ unknownKeys, missingRequired }` from the local validator
- `submitResponse` — raw response from `walmartApi.submitFeed` (feedId, feedStatus, any warnings)
- `feedStatus` — the final `getFeedStatus(feedId, includeDetails=true)` payload (feedStatus, itemsReceived/Succeeded/Failed, `ingestionErrors`, full `itemDetails.itemIngestionStatus[]` with per-SKU errors)
- `submitError` — message + rate-limited flag if the POST threw

Persist the same array on `wfs_conversion_runs.response.groups` (already a JSON column) alongside the existing `submits` / `statuses` so past runs stay inspectable.

Extend the returned `WfsConversionRunResult` with:
- `groups: WfsGroupDiagnostics[]` — the array above
- `specVersion: string` (the Omni spec build string we sent in the header)

No change to what we actually submit — this is purely surfacing what we already build.

### 2. `src/components/BulkConvertWfs.tsx` — results panel
Under the existing Feed ID / Status / Submitted summary, add a **Diagnostics** section:

- Per group, a collapsible card showing: group #, product-type bucket, item count, feedId, feedStatus, itemsReceived/Succeeded/Failed, spec version.
- Two buttons per group:
  - **Copy payload JSON** (clipboard)
  - **Download payload** — `wfs-payload-<runId>-g<index>.json` containing `{ header, requestBody, submitResponse, feedStatus, specValidation }`
- One top-level button **Download full run bundle** — a single JSON with `{ runId, feedIds, specVersion, groups, preflightFailed, failedItems, successSkus }` — this is what you'd attach to a Walmart ticket.
- Per-SKU failure rows already listed under "Failed / deferred" get an extra "View error detail" toggle showing the raw `ingestionError` object (`type`, `field`, `description`, `errorInfo`) from that SKU's `itemIngestionStatus` entry.

### 3. Type file — `src/types/wfs.ts` (or wherever `WfsConversionRunResult` lives)
Add `WfsGroupDiagnostics` and extend the result type. No DB migration needed — `response` is already `jsonb`.

## Out of scope
- Changing the payload shape or spec version.
- Changing preflight rules.
- New DB columns (existing `response` jsonb absorbs it).

## Technical notes
- `feedBody` is currently a local variable inside the per-group loop in `submitWfsConversion`. Assign it to a `groupDiag.requestBody` at build time before `walmartApi.submitFeed` is called, so we capture it even when submit throws.
- Redact nothing — this payload contains only product data (SKU, GTIN, dims, brand, image URL), no credentials.
- `walmartApi.submitFeed` and `getFeedStatus` responses are already captured in `allSubmits` / `allStatuses`; the new `groups[]` is just a per-group re-shape of those plus `requestBody`.
- Downloaded JSON files use `application/json` blob + `URL.createObjectURL`, same pattern as the existing CSV download in `downloadCsv`.
