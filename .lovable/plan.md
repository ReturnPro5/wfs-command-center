# Move WFS Convert to current Omni Spec 5.0

## Goal
Stop hand-coding the OMNI_WFS payload against an old snapshot. Make the payload builder read Walmart's live JSON schema (Omni Spec 5.0, currently build `5.0.20260205-21_38_48`) and only send fields/enums that the current spec actually defines for each product type.

## Step 1 — Pull the current spec and diff it (read-only, no code yet)
- For OMNI_WFS overall, and for the top product types we've actually been submitting (taken from `wfs_conversion_runs` history), call `walmartApi.getFeedSpec("OMNI_WFS", <productType>)`.
- Save each schema + the spec build version Walmart returns.
- Produce a diff report at `docs/wfs-spec-diff-<date>.md` listing, per productType:
  - **Required attributes** in 5.0 that we never send
  - **Field names** we send that are not in the 5.0 schema (today these are silently swallowed by `WALMART_REJECTED_OMNI_WFS_KEYS`)
  - **Enum values** where our defaults (`"No Warning Applicable"`, `"None"`, `"Does Not Contain a Battery"`, `"US - United States"`, `"fbw"`, etc.) no longer match 5.0
  - **Renames** (e.g. Prop 65 key name per category, country-of-origin field, battery field)
- Deliver the report to you before any code change. You approve → step 2.

## Step 2 — Make the payload builder spec-driven
Refactor `submitWfsConversion` in `src/services/wfs.functions.ts`:
- Load the spec once per (feedType, productType) at run start, cache for the run, **record the spec build version on the `wfs_conversion_runs` row**.
- Replace the hand-rolled `Visible` / `Orderable` / `TradeItem` object literals with a builder that:
  - Walks `Visible.<ProductType>.required[]` from the live schema and fills each one from our known sources (image, brand, price, Prop 65 text = `"None"`, country of origin, dimensions, weight, etc.) **using the live field name from the schema** — no more hard-coded keys like `prop65WarningText` or `californiaPropWarningText`.
  - Drops anything not present in the live schema, so we can delete `WALMART_REJECTED_OMNI_WFS_KEYS` entirely.
  - Validates enum values against the schema and substitutes the closest allowed value (or fails preflight with a clear "value X not in enum [...]" message).
- Header stays `version: "1.4"`, `sellingChannel: "fbw"`, `processMode: "REPLACE"`, `subset: "EXTERNAL"` unless the spec diff says otherwise.

## Step 3 — Surface the version in the UI and run log
- Show "Spec: OMNI_WFS · build 5.0.<…> · header v1.4" in the Bulk Convert tab footer.
- Add `spec_version` column to `wfs_conversion_runs` (migration with GRANTs) so we can answer "which spec build did this feed go out against?" later.

## Step 4 — Lock in freshness
- Add a small server function `refreshOmniWfsSpec()` that refetches the spec for the cached product types and surfaces in the UI when Walmart rolls a new build. No automatic re-deploy needed; we just see the badge change and re-run the diff.

## Out of scope
- Changing `feedType` (stays `OMNI_WFS`).
- Changing header `version: "1.4"`.
- Rewriting category bucketing / subCategory aliases.

## Deliverable order
1. Spec diff report (read-only, you review).
2. Refactor + migration + UI badge (one build pass).
3. Optional spec-refresh button.
