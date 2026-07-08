import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import {
  enrichCatalogStep,
  getFeedLookup,
  importDimensions,
  resolveIdentifiers,
  submitWfsConversion,
  type CatalogIdentifier,
  type FeedLookupResult,
  type ImportDimensionsResult,
  type WfsConversionRunResult,
} from "@/services/wfs.functions";

interface Props {
  items: CatalogIdentifier[];
}


function normalizeId(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

function identifierVariants(s: string | undefined): string[] {
  const digits = normalizeId(s ?? "");
  if (!digits) return [];
  const variants = new Set<string>([digits]);
  const withoutLeadingZeroes = digits.replace(/^0+/, "");
  if (withoutLeadingZeroes) variants.add(withoutLeadingZeroes);
  if (digits.length === 12) {
    variants.add(`0${digits}`);
    variants.add(`00${digits}`);
  }
  if (digits.length === 13 && digits.startsWith("0")) variants.add(digits.slice(1));
  if (digits.length === 14) {
    if (digits.startsWith("00")) variants.add(digits.slice(2));
    if (digits.startsWith("0")) variants.add(digits.slice(1));
  }
  return Array.from(variants);
}

function parsePasted(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,;]+/)
        .map((t) => normalizeId(t))
        .filter((t) => t.length > 0)
    )
  );
}

const DIM_TEMPLATE_HEADER = [
  "SKU",
  "UPC",
  "ProductName",
  "ProductType",
  "Brand",
  "Manufacturer",
  "MainImageUrl",
  "Price",
  "CountryOfOrigin",
  "DimensionD",
  "DimensionW",
  "DimensionH",
  "ShippingWeight",
] as const;

function csvEscape(v: string): string {
  return `"${(v ?? "").replace(/"/g, '""')}"`;
}
function csvEscapeId(v: string): string {
  const s = (v ?? "").replace(/"/g, '""');
  return s ? `'${s}` : "";
}

function exportDimensionsTemplate(rows: CatalogIdentifier[]) {
  const lines = [DIM_TEMPLATE_HEADER.join(",")];
  for (const r of rows) {
    const anyR = r as any;
    const brand = anyR.brand ?? "";
    const mainImageUrl = anyR.mainImageUrl ?? "";
    const productType = anyR.productType ?? anyR.category ?? "";
    const price =
      typeof anyR.price === "number" && Number.isFinite(anyR.price)
        ? String(anyR.price)
        : "";
    lines.push(
      [
        csvEscapeId(r.sku),
        csvEscapeId(r.upc ?? ""),
        csvEscape(r.productName ?? ""),
        csvEscape(productType),
        csvEscape(brand),
        "",
        csvEscape(mainImageUrl),
        price,
        "",
        "",
        "",
        "",
        "",
      ].join(",")
    );
  }
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wfs-convert-template-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Dimensions CSV import (mirrors BulkConvertWfs) ───────────────────────
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const firstLine = lines.find((line) => line.trim().length > 0) ?? "";
  const sepDirective = firstLine.trim().match(/^sep\s*=\s*([^\s])$/i);
  const delimiter = sepDirective?.[1] ?? [",", "\t", ";", "|"]
    .map((candidate) => ({ candidate, count: lines.slice(0, 10).reduce((sum, line) => sum + line.split(candidate).length - 1, 0) }))
    .sort((a, b) => b.count - a.count)[0]?.candidate ?? ",";
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delimiter) { row.push(cell); cell = ""; i++; continue; }
    if (c === "\n") { row.push(cell); out.push(row); row = []; cell = ""; i++; continue; }
    if (c === "=" && src[i + 1] === '"') { i++; continue; }
    cell += c; i++;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); out.push(row); }
  return out.filter((r) => r.length > 1 || (r[0] && r[0].trim() !== ""));
}

interface ParsedDimRow {
  sku?: string;
  upc?: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  countryOfOrigin?: string;
  brand?: string;
  manufacturer?: string;
  mainImageUrl?: string;
  productType?: string;
  price?: number | null;
}

function parseDimensionsCsv(text: string): { rows: ParsedDimRow[]; errors: string[] } {
  const errors: string[] = [];
  const grid = parseCsv(text);
  if (grid.length === 0) return { rows: [], errors: ["empty file"] };
  const cleanHeader = (h: string) => h.trim().toLowerCase().replace(/^\ufeff/, "").replace(/^["'=]+|["']+$/g, "").trim();
  const headerKey = (h: string) => cleanHeader(h).replace(/[\s_\-./()]+/g, "");
  const headerCandidates = [
    ["sku", "seller sku", "item sku", "partner sku", "merchant sku"],
    ["upc", "gtin", "product id", "productid", "item id", "itemid", "product identifier", "productidentifier", "external product id", "externalproductid"],
  ];
  const headerRowIndex = grid.findIndex((candidate, rowIndex) => {
    if (rowIndex > 25) return false;
    const cleaned = candidate.map(cleanHeader);
    const keys = candidate.map(headerKey);
    if (keys.length === 1 && /^sep=./i.test(cleaned[0])) return false;
    const hasHeader = (names: string[]) => cleaned.some((h, i) => {
      const key = keys[i];
      if (key.includes("type") || key.includes("kind")) return false;
      return names.some((n) => {
        const nKey = headerKey(n);
        return h === n || h.startsWith(n) || key === nKey || key.startsWith(nKey) || key.endsWith(nKey);
      });
    });
    return headerCandidates.some(hasHeader);
  });
  if (headerRowIndex < 0) {
    errors.push("missing SKU, UPC, or GTIN column");
    return { rows: [], errors };
  }
  const header = grid[headerRowIndex].map(cleanHeader);
  const headerKeys = grid[headerRowIndex].map(headerKey);
  const idx = (names: string[]) =>
    header.findIndex((h, i) => {
      const key = headerKeys[i];
      return names.some((n) => {
        const nKey = headerKey(n);
        return h === n || h.startsWith(n) || key === nKey || key.startsWith(nKey) || key.endsWith(nKey);
      });
    });
  const idxIdentifier = () => {
    const names = ["upc", "gtin", "product id", "productid", "item id", "itemid", "product identifier", "productidentifier", "external product id", "externalproductid"];
    return header.findIndex((h, i) => {
      const key = headerKeys[i];
      if (key.includes("type") || key.includes("kind")) return false;
      return names.some((n) => {
        const nKey = headerKey(n);
        return h === n || h.startsWith(n) || key === nKey || key.startsWith(nKey) || key.endsWith(nKey);
      });
    });
  };
  const iSku = idx(["sku", "seller sku", "item sku", "partner sku", "merchant sku"]);
  const iUpc = idxIdentifier();
  const iIdentifierType = idx(["product id type", "productidtype", "id type", "identifier type", "product identifier type"]);
  const iLen = idx(["length", "shipping length", "shippinglength", "package length", "packagelength", "dimensiond", "dimension d", "depth"]);
  const iWid = idx(["width", "shipping width", "shippingwidth", "package width", "packagewidth", "dimensionw", "dimension w"]);
  const iHei = idx(["height", "shipping height", "shippingheight", "package height", "packageheight", "dimensionh", "dimension h"]);
  const iWgt = idx(["weight", "shippingweight", "shipping weight", "package weight", "packageweight"]);
  const iCoo = idx(["country of origin", "country_of_origin", "countryoforigin", "country region of origin", "countryregionoforigin", "origin country", "country"]);
  const iBrand = idx(["brand"]);
  const iMfr = idx(["manufacturer", "mfr"]);
  const iImg = idx(["mainimageurl", "main image url", "imageurl", "image"]);
  const iPt = idx(["producttype", "product type", "category"]);
  const iPrice = idx(["price"]);
  if (iSku < 0 && iUpc < 0) {
    errors.push("missing SKU, UPC, or GTIN column");
    return { rows: [], errors };
  }
  const num = (s: string | undefined): number | null => {
    if (s == null) return null;
    const t = s.replace(/[",=$']/g, "").trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const clean = (s: string | undefined): string =>
    (s ?? "").replace(/^\ufeff/, "").trim().replace(/[",=]/g, "").replace(/^'+/, "").trim();
  const rows: ParsedDimRow[] = [];
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const cells = grid[r];
    const directSku = iSku >= 0 ? clean(cells[iSku]) : "";
    const identifier = iUpc >= 0 ? clean(cells[iUpc]) : "";
    const identifierType = iIdentifierType >= 0 ? clean(cells[iIdentifierType]).toLowerCase() : "";
    const identifierIsSku = /sku/.test(identifierType) || (!identifierType && /[a-z]/i.test(identifier));
    const sku = directSku || (identifier && identifierIsSku ? identifier : "");
    const upc = identifier && !identifierIsSku ? normalizeId(identifier) : "";
    if (!sku && !upc) continue;
    rows.push({
      sku: sku || undefined,
      upc: upc || undefined,
      length: iLen >= 0 ? num(cells[iLen]) : null,
      width: iWid >= 0 ? num(cells[iWid]) : null,
      height: iHei >= 0 ? num(cells[iHei]) : null,
      weight: iWgt >= 0 ? num(cells[iWgt]) : null,
      countryOfOrigin: iCoo >= 0 ? clean(cells[iCoo]) || undefined : undefined,
      brand: iBrand >= 0 ? clean(cells[iBrand]) || undefined : undefined,
      manufacturer: iMfr >= 0 ? clean(cells[iMfr]) || undefined : undefined,
      mainImageUrl: iImg >= 0 ? clean(cells[iImg]) || undefined : undefined,
      productType: iPt >= 0 ? clean(cells[iPt]) || undefined : undefined,
      price: iPrice >= 0 ? num(cells[iPrice]) : null,
    });
  }
  return { rows, errors };
}


export function ConvertByGtin({ items }: Props) {
  const [pasted, setPasted] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState<string>("");
  const [resolving, setResolving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; resolved: number; notFound: number } | null>(null);
  const [result, setResult] = useState<WfsConversionRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [convertedSkus, setConvertedSkus] = useState<Set<string>>(new Set());
  // SKUs pulled from Walmart on demand for tokens that weren't in the cache
  // (Unpublished / Retired / Archived items not covered by the normal sync).
  const [extraItems, setExtraItems] = useState<Map<string, CatalogIdentifier>>(new Map());
  // Tokens we already confirmed are not in Walmart this session — skip on re-lookup.
  const [knownNotFound, setKnownNotFound] = useState<Set<string>>(new Set());
  // token (as pasted, digits-only) → set of SKUs resolved by the server. Used
  // alongside idMap because Walmart's /v3/items search results often omit
  // gtin/upc on the returned item, so we can't always re-index by identifier.
  const [tokenToSkus, setTokenToSkus] = useState<Map<string, Set<string>>>(new Map());
  const [resolveSummary, setResolveSummary] = useState<{
    fetched: number;
    notFound: string[];
  } | null>(null);

  // Dimensions import (brand / country of origin / dims / weight)
  const dimFileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importResult, setImportResult] = useState<ImportDimensionsResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importStage, setImportStage] = useState("");



  // Build GTIN/UPC -> SKU(s) map across the cached catalog AND any extras we
  // fetched ad-hoc for this paste.
  const idMap = useMemo(() => {
    const m = new Map<string, CatalogIdentifier[]>();
    const push = (key: string, it: CatalogIdentifier) => {
      const arr = m.get(key) ?? [];
      if (!arr.some((x) => x.sku === it.sku)) arr.push(it);
      m.set(key, arr);
    };
    const add = (it: CatalogIdentifier) => {
      for (const g of identifierVariants(it.gtin)) push(g, it);
      for (const u of identifierVariants(it.upc)) push(u, it);
    };
    for (const it of items) add(it);
    for (const it of extraItems.values()) add(it);
    return m;
  }, [items, extraItems]);


  const tokens = useMemo(() => parsePasted(pasted), [pasted]);

  const resolution = useMemo(() => {
    const matched: Array<{ token: string; item: CatalogIdentifier }> = [];
    const unmatched: string[] = [];
    const ineligible: Array<{ token: string; item: CatalogIdentifier; reason: string }> = [];
    const alreadyConverted: string[] = [];
    const seenSkus = new Set<string>();
    // Quick lookup by SKU across all known items (cached + extras).
    const bySku = new Map<string, CatalogIdentifier>();
    for (const it of items) bySku.set(it.sku, it);
    for (const it of extraItems.values()) bySku.set(it.sku, it);

    for (const t of tokens) {
      // Prefer the server-reported token→SKU mapping (works even when the
      // returned item carries no gtin/upc). Fall back to idMap.
      const skuSet = tokenToSkus.get(t);
      const hits: CatalogIdentifier[] = skuSet
        ? Array.from(skuSet).map((s) => bySku.get(s)).filter(Boolean) as CatalogIdentifier[]
        : (idMap.get(t) ?? []);
      if (!hits || hits.length === 0) {
        unmatched.push(t);
        continue;
      }
      for (const it of hits) {
        if (seenSkus.has(it.sku)) continue;
        seenSkus.add(it.sku);
        if (convertedSkus.has(it.sku)) {
          alreadyConverted.push(it.sku);
          continue;
        }
        if (!/ND$/i.test(it.sku)) {
          ineligible.push({ token: t, item: it, reason: `sku=${it.sku} (not ND suffix)` });
          continue;
        }
        const condRaw = (it.condition ?? "").trim();
        const cond = condRaw.toLowerCase().replace(/[\s_-]/g, "");
        if (cond && cond !== "openbox") {
          ineligible.push({ token: t, item: it, reason: `condition=${it.condition || "—"}` });
          continue;
        }
        matched.push({ token: t, item: it });
      }
    }
    return { matched, unmatched, ineligible, alreadyConverted };
  }, [tokens, idMap, convertedSkus, tokenToSkus, items, extraItems]);


  async function runLookup() {
    if (tokens.length === 0) return;
    setResolving(true);
    setError(null);
    setProgress(null);
    try {
      // Look up at Walmart for tokens that either have no cached match OR whose
      // cached matches are all non-ND variants — the ND (Open Box) sibling may
      // exist in Walmart but never made it into our sync (e.g. different
      // lifecycle/publishedStatus bucket).
      const hasEligibleCached = (t: string) => {
        const hits = idMap.get(t);
        if (!hits || hits.length === 0) return false;
        return hits.some((it) => /ND$/i.test(it.sku));
      };
      const unknown = tokens.filter((t) => !hasEligibleCached(t));
      if (unknown.length === 0) {
        setResolveSummary({ fetched: 0, notFound: [] });
        toast.success("All GTINs already have an ND SKU in the cached catalog.");
        return;
      }

      // Smaller chunks → progress moves more often, so the UI never feels stuck.
      const CHUNK = 50;
      let queue = unknown.slice();
      let total = queue.length;
      let fetchedTotal = 0;
      const notFoundAll: string[] = [];
      let resolvedCount = 0;
      const rateLimitedAll = new Set<string>();
      setProgress({ done: 0, total, resolved: 0, notFound: 0 });

      // Walmart's /v3/items throttles by short window; tokens that come back as
      // rateLimited get re-queued for another pass with a cooldown so the operator
      // doesn't see false "not found" results.
      const MAX_PASSES = 3;
      let pass = 0;
      let done = 0;
      while (queue.length > 0 && pass < MAX_PASSES) {
        const passRetries: string[] = [];
        for (let i = 0; i < queue.length; i += CHUNK) {
          const batch = queue.slice(i, i + CHUNK);
          const res = await resolveIdentifiers({ data: { identifiers: batch } });
          if (res.resolved.length > 0) {
            setExtraItems((prev) => {
              const next = new Map(prev);
              for (const it of res.resolved) next.set(it.sku, it);
              return next;
            });
          }
          if (res.notFound.length > 0) {
            setKnownNotFound((prev) => {
              const next = new Set(prev);
              for (const t of res.notFound) next.add(t);
              return next;
            });
          }
          if (res.matchedByToken && Object.keys(res.matchedByToken).length > 0) {
            setTokenToSkus((prev) => {
              const next = new Map(prev);
              for (const [tok, skus] of Object.entries(res.matchedByToken)) {
                const set = next.get(tok) ?? new Set<string>();
                for (const s of skus) set.add(s);
                next.set(tok, set);
              }
              return next;
            });
          }

          fetchedTotal += res.fetched;
          resolvedCount += res.resolved.length;
          notFoundAll.push(...res.notFound);
          for (const t of res.rateLimited ?? []) {
            rateLimitedAll.add(t);
            passRetries.push(t);
          }
          done += batch.length - (res.rateLimited?.length ?? 0);
          setProgress({
            done: Math.min(done, total),
            total,
            resolved: resolvedCount,
            notFound: notFoundAll.length,
          });
          await new Promise((r) => setTimeout(r, 0));
        }
        queue = passRetries;
        pass++;
        if (queue.length > 0 && pass < MAX_PASSES) {
          // Let the Walmart rate-limit window reset before the next pass.
          toast.message(`Walmart rate-limited ${queue.length.toLocaleString()} lookups — retrying in 10s…`);
          await new Promise((r) => setTimeout(r, 10000));
        }
      }
      // Anything still rate-limited after the final pass is left out of notFound
      // so the operator can rerun the lookup without losing those tokens.
      for (const t of queue) rateLimitedAll.add(t);

      setResolveSummary({ fetched: fetchedTotal, notFound: notFoundAll });
      const stillRL = queue.length;
      toast.success(
        `Found ${resolvedCount.toLocaleString()} SKU(s) (newly pulled: ${fetchedTotal})${
          notFoundAll.length > 0 ? ` · ${notFoundAll.length} not in Walmart` : ""
        }${stillRL > 0 ? ` · ${stillRL} rate-limited (click Look up again)` : ""}`
      );

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`Lookup failed: ${msg}`);
    } finally {
      setResolving(false);
    }
  }



  async function runEnrich() {
    const skus = resolution.matched.map((m) => m.item.sku);
    if (skus.length === 0) {
      toast.error("No eligible SKUs to enrich. Look up GTINs first.");
      return;
    }
    setEnriching(true);
    setEnrichMsg("");
    setError(null);
    try {
      const CHUNK = 200;
      let enriched = 0;
      let partial = 0;
      let failed = 0;
      let processed = 0;
      const missingBySku: Array<{ sku: string; missing: string[]; error?: string }> = [];
      for (let i = 0; i < skus.length; i += CHUNK) {
        const chunk = skus.slice(i, i + CHUNK);
        const res = await enrichCatalogStep({
          data: { batchSize: chunk.length, onlySkus: chunk, reenrich: true },
        });
        enriched += res.enriched;
        partial += res.partial;
        failed += res.failed;
        processed += res.processed;
        for (const d of res.details ?? []) {
          if ((d.missing?.length ?? 0) > 0 || d.error) {
            missingBySku.push({ sku: d.sku, missing: d.missing ?? [], error: d.error });
          }
        }
        setEnrichMsg(
          `Processed ${processed}/${skus.length} · enriched ${enriched} · partial ${partial} · errors ${failed}`
        );
      }
      if (missingBySku.length > 0) {
        const sample = missingBySku
          .slice(0, 10)
          .map((d) => `${d.sku}: ${d.error ?? d.missing.join(", ")}`)
          .join(" · ");
        setEnrichMsg(
          `Processed ${processed}/${skus.length} · enriched ${enriched} · partial ${partial} · errors ${failed}. Still missing: ${sample}${missingBySku.length > 10 ? " …" : ""}`
        );
      }
      toast.success(
        `Enriched ${enriched} (partial ${partial}, errors ${failed}). Re-run lookup or refresh to see latest fields.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`Enrichment failed: ${msg}`);
    } finally {
      setEnriching(false);
    }
  }

  function runExport() {
    const rows = resolution.matched.map((m) => m.item);
    if (rows.length === 0) {
      toast.error("No eligible SKUs to export. Look up GTINs first.");
      return;
    }
    exportDimensionsTemplate(rows);
    toast.success(`Exported ${rows.length.toLocaleString()} UPCs to CSV.`);
  }

  async function onDimensionsFile(file: File) {
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    setImportProgress(null);
    setImportStage(`Reading ${file.name}…`);
    try {
      const text = await file.text();
      const { rows: parsed, errors } = parseDimensionsCsv(text);
      if (errors.length > 0) throw new Error(errors.join("; "));
      if (parsed.length === 0) throw new Error("no data rows found");
      setImportStage(`Parsed ${parsed.length.toLocaleString()} rows; matching SKUs…`);

      // UPC/GTIN -> SKU(s) lookup from the current Convert by GTIN results.
      // Prefer eligible looked-up ND/Open Box matches over any same-UPC non-ND
      // catalog row, because this import is meant to enrich the conversion list.
      const idToSkus = new Map<string, string[]>();
      const addIdentifier = (key: string, sku: string) => {
        const arr = idToSkus.get(key) ?? [];
        if (!arr.includes(sku)) arr.push(sku);
        idToSkus.set(key, arr);
      };
      const addIds = (it: CatalogIdentifier) => {
        for (const u of identifierVariants(it.upc)) addIdentifier(u, it.sku);
        for (const g of identifierVariants(it.gtin)) addIdentifier(g, it.sku);
      };
      if (resolution.matched.length > 0) {
        for (const { token, item } of resolution.matched) {
          for (const t of identifierVariants(token)) addIdentifier(t, item.sku);
          addIds(item);
        }
      } else {
        for (const it of items) addIds(it);
        for (const it of extraItems.values()) addIds(it);
      }

      type ResolvedRow = {
        sku: string;
        length: number | null;
        width: number | null;
        height: number | null;
        weight: number | null;
        countryOfOrigin?: string;
        brand?: string;
        manufacturer?: string;
        mainImageUrl?: string;
        productType?: string;
        price?: number | null;
      };
      const rowFor = (sku: string, r: ParsedDimRow): ResolvedRow => ({
        sku,
        length: r.length,
        width: r.width,
        height: r.height,
        weight: r.weight,
        countryOfOrigin: r.countryOfOrigin,
        brand: r.brand,
        manufacturer: r.manufacturer,
        mainImageUrl: r.mainImageUrl,
        productType: r.productType,
        price: r.price,
      });
      const resolved: ResolvedRow[] = [];
      let unresolved = 0;
      for (const r of parsed) {
        if (r.sku) {
          resolved.push(rowFor(r.sku, r));
          continue;
        }
        const skus = new Set<string>();
        for (const u of identifierVariants(r.upc)) {
          for (const sku of idToSkus.get(u) ?? []) skus.add(sku);
        }
        if (skus.size === 0) {
          unresolved++;
          continue;
        }
        for (const sku of skus) resolved.push(rowFor(sku, r));
      }
      if (resolved.length === 0) {
        throw new Error(`could not match any UPC to a SKU (${unresolved} unmatched)`);
      }
      setImportStage(`Uploading ${resolved.length.toLocaleString()} matched rows…`);

      const BATCH = 500;
      const CLIENT_CONCURRENCY = 4;
      const chunks: ResolvedRow[][] = [];
      for (let i = 0; i < resolved.length; i += BATCH) chunks.push(resolved.slice(i, i + BATCH));
      let updated = 0;
      let skipped = 0;
      const allErrors: Array<{ sku: string; reason: string }> = [];
      let done = 0;
      setImportProgress({ done: 0, total: resolved.length });
      let cursor = 0;
      await Promise.all(
        Array.from({ length: CLIENT_CONCURRENCY }, async () => {
          while (cursor < chunks.length) {
            const idx = cursor++;
            const chunk = chunks[idx];
            const res = await importDimensions({ data: { rows: chunk } });
            updated += res.updated;
            skipped += res.skipped;
            allErrors.push(...res.errors);
            done += chunk.length;
            setImportProgress({ done, total: resolved.length });
          }
        })
      );
      const finalRes: ImportDimensionsResult = {
        received: resolved.length,
        updated,
        skipped,
        errors: allErrors,
      };
      setImportResult(finalRes);
      toast.success(
        `Updated ${updated.toLocaleString()} SKUs · skipped ${skipped.toLocaleString()} · ${allErrors.length} errors${unresolved ? ` · ${unresolved} UPC unmatched` : ""}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportError(msg);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setImporting(false);
      setImportProgress(null);
      setImportStage("");
      if (dimFileRef.current) dimFileRef.current.value = "";
    }
  }



  async function runConvert() {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const skus = resolution.matched.map((m) => m.item.sku);
      if (skus.length === 0) throw new Error("No eligible SKUs to submit.");
      if (skus.length > 500) {
        throw new Error("Walmart limits each submission to 500 SKUs. Reduce your list.");
      }
      const res = await submitWfsConversion({ data: { skus } });
      setResult(res);
      const succeeded = res.successSkus ?? [];
      if (succeeded.length > 0) {
        setConvertedSkus((prev) => {
          const next = new Set(prev);
          for (const s of succeeded) next.add(s);
          return next;
        });
      }
      toast.success(
        `Submitted ${res.submittedCount.toLocaleString()} SKUs — feedId ${res.feedId ?? "(pending)"}, status ${res.status}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`WFS conversion failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
        Paste GTINs or UPCs (one per line, or comma/space separated). Only SKUs ending in{" "}
        <strong>ND</strong> with condition <strong>Open Box</strong> are eligible (regardless of
        fulfillment, lifecycle, or published
        status — Unpublished, Archived, and Retired SKUs are looked up directly against Walmart.
        Click <strong>Look up GTINs</strong> first to pull any identifiers not in the cached catalog,
        then submit.
      </div>

      <Textarea
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder={"00078565123456\n00078565123457\n..."}
        className="min-h-[180px] font-mono text-xs"
      />

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span><strong>{tokens.length.toLocaleString()}</strong> identifiers parsed</span>
        <span className="text-status-healthy">
          {resolution.matched.length.toLocaleString()} eligible
        </span>
        {resolution.ineligible.length > 0 && (
          <span className="text-status-warning">
            {resolution.ineligible.length.toLocaleString()} ineligible
          </span>
        )}
        {resolution.unmatched.length > 0 && (
          <span className="text-status-critical">
            {resolution.unmatched.length.toLocaleString()} not found
          </span>
        )}
        {resolution.alreadyConverted.length > 0 && (
          <span className="text-muted-foreground">
            {resolution.alreadyConverted.length.toLocaleString()} already converted
          </span>
        )}
        {resolveSummary && (
          <span className="text-muted-foreground">
            · pulled {resolveSummary.fetched.toLocaleString()} from Walmart
            {resolveSummary.notFound.length > 0
              ? ` · ${resolveSummary.notFound.length} not in Walmart`
              : ""}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            setPasted("");
            setResolveSummary(null);
          }}
          disabled={!pasted}
          className="rounded border border-border bg-secondary px-2 py-1 hover:bg-secondary/70 disabled:opacity-50"
        >
          Clear
        </button>
        <button
          onClick={() => void runLookup()}
          disabled={resolving || tokens.length === 0}
          className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/70 disabled:opacity-50"
          title="Query Walmart for any pasted GTIN/UPC not already in the cached catalog (covers Unpublished, Archived, Retired)"
        >
          {resolving ? "Looking up…" : `Look up GTINs (${tokens.length.toLocaleString()})`}
        </button>
        <button
          onClick={() => void runEnrich()}
          disabled={enriching || resolution.matched.length === 0}
          className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/70 disabled:opacity-50"
          title="Fetch the latest fields (brand, image, price, product type, etc.) from Walmart for the eligible SKUs"
        >
          {enriching ? "Enriching…" : `Enrich ${resolution.matched.length.toLocaleString()}`}
        </button>
        <button
          onClick={runExport}
          disabled={resolution.matched.length === 0}
          className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/70 disabled:opacity-50"
          title="Download a CSV of UPCs (pre-filled where possible) so you can add dimensions and re-import"
        >
          Export UPCs ({resolution.matched.length.toLocaleString()})
        </button>
        <input
          ref={dimFileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onDimensionsFile(f);
          }}
        />
        <button
          onClick={() => dimFileRef.current?.click()}
          disabled={importing}
          className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/70 disabled:opacity-50"
          title="Upload a CSV with dimensions, country of origin, and brand to finish enriching SKUs"
        >
          {importing
            ? importProgress
              ? `Importing… ${importProgress.done.toLocaleString()} / ${importProgress.total.toLocaleString()}`
              : "Importing…"
            : "Import CSV"}
        </button>
        <button
          onClick={() => void runConvert()}
          disabled={submitting || resolution.matched.length === 0}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {submitting
            ? "Submitting…"
            : `Convert ${resolution.matched.length.toLocaleString()} to WFS`}
        </button>
      </div>

      {importing && importStage && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
          {importStage}
        </div>
      )}

      {importError && (
        <div className="rounded-md border border-status-critical/40 bg-status-critical/10 p-3 text-xs text-status-critical">
          Import failed: {importError}
        </div>
      )}

      {importResult && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>Received: {importResult.received.toLocaleString()}</span>
            <span className="text-status-healthy">Updated: {importResult.updated.toLocaleString()}</span>
            <span className="text-muted-foreground">Skipped: {importResult.skipped.toLocaleString()}</span>
            <span className="text-status-critical">Errors: {importResult.errors.length.toLocaleString()}</span>
          </div>
          {importResult.errors.length > 0 && (
            <details>
              <summary className="cursor-pointer text-status-critical">Show errors</summary>
              <ul className="mt-1 max-h-48 overflow-y-auto space-y-0.5 font-mono">
                {importResult.errors.slice(0, 500).map((e, i) => (
                  <li key={i}><span className="text-primary">{e.sku}</span> — {e.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}


      {progress && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs space-y-2">
          <div className="flex items-center justify-between font-medium">
            <span>
              {resolving ? "Looking up GTINs…" : "Lookup complete"} · {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
            </span>
            <span className="text-muted-foreground">
              {progress.resolved.toLocaleString()} found · {progress.notFound.toLocaleString()} not found
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {enrichMsg && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
          {enrichMsg}
        </div>
      )}

      {resolution.matched.length > 0 && (
        <details open className="rounded-md border border-border bg-secondary/20 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-status-healthy">
            Eligible ({resolution.matched.length})
          </summary>
          <ul className="mt-2 max-h-60 overflow-y-auto space-y-0.5 font-mono">
            {resolution.matched.slice(0, 500).map((r) => (
              <li key={r.item.sku}>
                <span className="text-primary">{r.token}</span>{" "}
                <span className="text-muted-foreground">→ {r.item.sku}</span>{" "}
                <span className="text-status-healthy">[{r.item.condition || "Open Box"}]</span>
              </li>
            ))}
          </ul>
        </details>
      )}


      {(resolution.unmatched.length > 0 || resolution.ineligible.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {resolution.ineligible.length > 0 && (
            <details className="rounded-md border border-border bg-secondary/20 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-status-warning">
                Ineligible ({resolution.ineligible.length})
              </summary>
              <ul className="mt-2 max-h-60 overflow-y-auto space-y-0.5 font-mono">
                {resolution.ineligible.slice(0, 500).map((r) => (
                  <li key={r.item.sku}>
                    <span className="text-primary">{r.token}</span>{" "}
                    <span className="text-muted-foreground">→ {r.item.sku}</span>{" "}
                    <span className="text-status-warning">[{r.reason}]</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {resolution.unmatched.length > 0 && (
            <details className="rounded-md border border-border bg-secondary/20 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-status-critical">
                Not found in catalog ({resolution.unmatched.length})
              </summary>
              <ul className="mt-2 max-h-60 overflow-y-auto space-y-0.5 font-mono">
                {resolution.unmatched.slice(0, 500).map((t) => (
                  <li key={t} className="text-status-critical">{t}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-status-critical/40 bg-status-critical/10 p-3 text-sm text-status-critical">
          {error}
        </div>
      )}

      {result && (
        <section className="space-y-2 rounded-md border border-border bg-secondary/30 p-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span><strong>Feed ID:</strong> <span className="font-mono">{result.feedId ?? "—"}</span></span>
            <span><strong>Status:</strong> {result.status}{result.timedOut ? " (poll timed out — recheck later)" : ""}</span>
            <span><strong>Submitted:</strong> {result.submittedCount.toLocaleString()}</span>
            {result.itemsReceived !== null && <span>Received: {result.itemsReceived}</span>}
            <span className="text-status-healthy">Succeeded: {result.successSkus.length.toLocaleString()}</span>
            <span className="text-status-critical">Failed: {result.failedItems.length.toLocaleString()}</span>
          </div>

          {result.successSkus.length > 0 && (
            <details className="mt-2" open>
              <summary className="cursor-pointer font-medium text-status-healthy">
                Ready for WFS ({result.successSkus.length})
              </summary>
              <ul className="mt-1 max-h-48 overflow-y-auto space-y-0.5 text-xs font-mono">
                {result.successSkus.slice(0, 500).map((sku) => (
                  <li key={sku} className="text-status-healthy">{sku}</li>
                ))}
              </ul>
            </details>
          )}

          {result.failedItems.length > 0 && (
            <details className="mt-2" open>
              <summary className="cursor-pointer font-medium text-status-critical">
                Failed / deferred ({result.failedItems.length})
              </summary>
              <ul className="mt-1 max-h-60 overflow-y-auto space-y-1 text-xs">
                {result.failedItems.slice(0, 500).map((f) => (
                  <li key={f.sku} className="font-mono">
                    <span className="text-primary">{f.sku}</span>{" "}
                    <span className="text-status-warning">[{f.status}]</span>{" "}
                    <span className="text-muted-foreground">{f.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
