# WFS Convert payload diff — OMNI_WFS Spec 5.0 audit

**Date:** 2026-06-29
**Spec build:** `5.0.20260205-21_38_48-api` (Walmart Omni Spec 5.0, March 26, 2026 release)
**Endpoint used:** `POST /v3/items/spec` with `{ feedType: "OMNI_WFS", version, productTypes[] }`
**Coverage:** all 20 top product types in `catalog_items` (Video Games, Movies, Cell Phones, Action Figures, Laptop Computers, Cell Phone Cases, Smart Watches, Music, Headphones, Tablet Computers, Luggage & Luggage Sets, Portable Speakers, Computer Monitors, Surveillance Cameras, Vacuum Cleaners, Headsets, Cookware Sets, Air Fryers, Televisions, Video Game Controllers)
**Walmart response:** `200 OK`, `errors: []` for every product type — all 20 are valid PTs against this spec build.

---

## TL;DR — your contact is right, we're on the old format

Walmart's own "Convert items for WFS" docs page still shows the legacy `version: "1.4"` sample. The **live spec API** (which the actual feed processor validates against) requires the **Omni Spec 5.0** envelope. Our payload is shaped against the legacy 1.4 envelope with category-specific patches piled on top — which explains the unending whack-a-mole of `is not a valid field` and `is a required attribute` errors per category.

Three structural problems, in priority order:

1. **`SupplierItemFeedHeader` is completely wrong shape** — we send 6 fields, 4 of which Walmart no longer accepts; we omit the only field they newly require (`businessUnit`); and our `version: "1.4"` must become `"5.0.20260205-21_38_48-api"`.
2. **`Orderable` is missing 3 newly-required fields** and we're sending 1 obsolete field that was split into those 3.
3. **`Visible.<ProductType>` is missing 2 required fields** for every category (`netContent`, `condition`) — these alone would explain a wave of `DATA_ERROR` rejections.

The hand-rolled Prop 65 key discovery, the `WALMART_REJECTED_OMNI_WFS_KEYS` blocklist, and the per-category dynamic field hunting can all be **deleted** — Spec 5.0 has one canonical key (`isProp65WarningRequired`, enum `Yes`/`No`) and one conditional text key (`prop65WarningText`, only when `isProp65WarningRequired=Yes`).

---

## 1. SupplierItemFeedHeader

Spec 5.0 says `required: ["businessUnit", "locale", "version"]` — and **that's the entire header**. `additionalProperties: false`.

| Field we send | Spec 5.0 accepts? | Action |
|---|---|---|
| `subCategory: "<token>"` | ❌ Not in schema | **Delete** |
| `sellingChannel: "fbw"` | ❌ Not in schema | **Delete** |
| `processMode: "REPLACE"` | ❌ Not in schema | **Delete** |
| `subset: "EXTERNAL"` | ❌ Not in schema | **Delete** |
| `locale: "en"` | ✅ enum: `["en"]` | Keep |
| `version: "1.4"` | ❌ enum: `["5.0.20260205-21_38_48-api"]` | **Change to live spec build string** |
| _(missing)_ `businessUnit` | ✅ Required, enum includes `WALMART_US` | **Add `"WALMART_US"`** |

Side effect: our entire "fan out one feed per subCategory" logic in `submitWfsConversion` (with `OMNI_WFS_ALLOWED_SUBCATEGORIES`, aliases, max-20 grouping, deferred groups, rate-limit batching) **is obsolete**. With no `subCategory` field on the header, one feed can carry items from any mix of product types. Group cap of 20 → gone. `DEFERRED` status → gone.

---

## 2. SupplierItem → Orderable

Spec 5.0 says `required: ["sku", "productIdentifiers", "price", "stateRestrictions", "electronicsIndicator", "batteryTechnologyType", "isChemical", "isAerosol", "isPesticide"]`.

| Field | We send? | Spec 5.0? | Action |
|---|---|---|---|
| `sku` | ✅ | required | keep |
| `productIdentifiers` (`productId` + `productIdType`) | ✅ | required | keep |
| `price` (number) | ✅ | required | keep |
| `stateRestrictions: [{ stateRestrictionsText: "None" }]` | ✅ | required (array) | keep |
| `electronicsIndicator: "No"` | ✅ | required, enum `Yes`/`No` | keep |
| `batteryTechnologyType: "Does Not Contain a Battery"` | ✅ | required, long enum (✓ value matches) | keep |
| **`isChemical`** | ❌ | **required**, enum `Yes`/`No` | **Add `"No"` by default** |
| **`isAerosol`** | ❌ | **required**, enum `Yes`/`No` | **Add `"No"` by default** |
| **`isPesticide`** | ❌ | **required**, enum `Yes`/`No` | **Add `"No"` by default** |
| `chemicalAerosolPesticide: "No"` | ✅ (we send) | ❌ Not in schema (split into 3) | **Delete** |
| `brand`, `productName`, `startDate`, `endDate` (inside Orderable) | ✅ (we send) | ❌ Not in Orderable; `brand`/`productName` belong in `Visible` | **Delete from Orderable** |

Conditional requireds we should be aware of (not always required, but trigger SDS/battery requirements when set):
- If `isChemical=Yes` or `isAerosol=Yes` or `isPesticide=Yes` → `safetyDataSheet` becomes required. (Matches our SDS-classifier hide rule, so non-hazmat items default all three to `No` and are fine.)
- If `batteryTechnologyType` is a Lithium type → `lithiumIonBatteries`/`lithiumMetalBatteries` blocks become required.

---

## 3. SupplierItem → TradeItem

Spec 5.0 says `required: ["sku", "countryOfOriginAssembly", "each"]`. Properties = exactly those three. `innerPack`, `orderableGTIN`, `innerPackGTIN` are **gone**.

| Field | We send? | Spec 5.0? | Action |
|---|---|---|---|
| `sku` | ✅ | required | keep |
| `countryOfOriginAssembly: ["US - United States"]` | ✅ (we normalize to `"CC - Country"`) | required, array of enum strings (format matches) | keep |
| `each: { eachDepth, eachWeight, eachWidth, eachHeight }` | ✅ | required object with those 4 required fields | keep |
| `innerPack: { … }` | ✅ (we send) | ❌ Not in schema | **Delete** |
| `orderableGTIN`, `innerPackGTIN` | ✅ (we send) | ❌ Not in schema | **Delete** |

---

## 4. SupplierItem → Visible.\<ProductType\>

Spec 5.0 required attributes are **identical across all 20 of our top product types** (with one tiny exception, noted below):

```
required: [productName, brand, isProp65WarningRequired, mainImageUrl, netContent, condition]
```

Exception: **Movies** and **Music** drop `brand` from required (they have no brand concept in Walmart's taxonomy).

Optional but allowed: `netContentStatement`, `prop65WarningText`.

| Field | We send? | Spec 5.0? | Action |
|---|---|---|---|
| `productName` | ✅ | required | keep |
| `brand` | ✅ (most categories) | required (except Movies/Music) | keep; gate by product type |
| `mainImageUrl` | ✅ | required | keep |
| `isProp65WarningRequired: "No"` | ⚠️ we send `"No"` _inconsistently_ via dynamic discovery | required, enum `Yes`/`No` | **Always send `"No"` by default** |
| `prop65WarningText` | ⚠️ we send `"None"` as hard fallback | optional; required only if `isProp65WarningRequired=Yes` | **Drop unless we set the flag to `Yes`** |
| **`netContent`** | ❌ | **required** (number) | **Add — pull from item dimensions or default `1`** |
| **`condition`** | ❌ | **required**, enum (`New`, `Refurbished`, etc.) | **Add — we already have `condition` on `catalog_items` (default `"New"`)** |
| `californiaPropWarningText`, `californiaPropWarningType` | ✅ (we sometimes send via dynamic discovery) | ❌ Not in schema | **Delete — these don't exist in Spec 5.0** |

This is why `California Prop 65 Warning Text` errors kept rotating: our dynamic discovery occasionally produced category-specific label-derived keys that **don't exist in this spec version at all**. Spec 5.0 only has `prop65WarningText`.

---

## 5. Things in our code that can be deleted outright

After moving to the live 5.0 envelope, all of the following become dead code:

- `WALMART_REJECTED_OMNI_WFS_KEYS` blocklist — no longer needed; `additionalProperties: false` is enforced at the spec layer and the live schema tells us exactly what's allowed.
- `WALMART_REQUIRED_PROP65_TEXT_KEY` hard fallback — replaced by the spec-driven `prop65WarningText` rule.
- `OMNI_WFS_ALLOWED_SUBCATEGORIES`, `OMNI_WFS_SUBCATEGORY_ALIASES`, `chooseOmniWfsSubCategory`, `MAX_GROUPS=20` — the header no longer carries `subCategory`, so per-subCategory fan-out is unnecessary. One feed can carry mixed product types.
- `findProp65Fields` + per-category dynamic key discovery — Spec 5.0 standardizes on `isProp65WarningRequired` and (conditionally) `prop65WarningText`.
- `DEFERRED_RATE_LIMIT` / `MAX_GROUPS` deferral logic — with one feed per run, only the natural Walmart submission limits apply.

---

## 6. Other latent bugs surfaced during this audit

- **`walmartApi.getFeedSpec()` was using `GET /v3/feeds/spec?…` with query params**, falling back to `GET /v3/items/spec?…`. Both return 404 because the spec API is `POST /v3/items/spec` with a JSON body. **Our local payload validator has been silently failing on every conversion run** — `loadSpecIndex` caught the 404 and logged "validation skipped". So we have never actually validated against Walmart's published schema, despite the code that claims to. I have already fixed `getFeedSpec` to use the correct `POST` shape with `feedType`, `version`, `productTypes[]` (this is what produced this diff report).
- The version param defaults via env var `WALMART_OMNI_SPEC_VERSION` → fallback `5.0.20260205-21_38_48-api`. When Walmart rolls a new build, the env var can be updated without a code release.

---

## Proposed step 2 (after you approve this report)

Refactor `submitWfsConversion` to build the payload directly from the 6-key spec layout above:

```jsonc
{
  "SupplierItemFeedHeader": {
    "businessUnit": "WALMART_US",
    "locale": "en",
    "version": "5.0.20260205-21_38_48-api"
  },
  "SupplierItem": [
    {
      "Visible": {
        "<Product Type display name>": {
          "productName": "...",
          "brand": "...",            // omit for Movies/Music
          "mainImageUrl": "...",
          "isProp65WarningRequired": "No",
          "netContent": 1,
          "condition": "New"
        }
      },
      "Orderable": {
        "sku": "...",
        "productIdentifiers": { "productId": "<GTIN-14>", "productIdType": "GTIN" },
        "price": 0.00,
        "stateRestrictions": [{ "stateRestrictionsText": "None" }],
        "electronicsIndicator": "No",
        "batteryTechnologyType": "Does Not Contain a Battery",
        "isChemical": "No",
        "isAerosol": "No",
        "isPesticide": "No"
      },
      "TradeItem": {
        "sku": "...",
        "countryOfOriginAssembly": ["US - United States"],
        "each": { "eachDepth": 0, "eachWidth": 0, "eachHeight": 0, "eachWeight": 0 }
      }
    }
  ]
}
```

Plus: enable the validator (now that `getFeedSpec` works), record the spec build on each `wfs_conversion_runs` row, and surface "Spec build: 5.0.20260205-21_38_48-api" in the Bulk Convert tab.

Ready to apply this refactor on your go-ahead.
