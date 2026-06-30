import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import {
  enrichCatalogStep,
  resolveIdentifiers,
  submitWfsConversion,
  type CatalogIdentifier,
  type WfsConversionRunResult,
} from "@/services/wfs.functions";

interface Props {
  items: CatalogIdentifier[];
}

function normalizeId(s: string): string {
  return s.replace(/[^0-9]/g, "");
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
      const g = normalizeId(it.gtin ?? "");
      const u = normalizeId(it.upc ?? "");
      if (g) push(g, it);
      if (u && u !== g) push(u, it);
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
      const unknown = tokens.filter((t) => !idMap.has(t) && !knownNotFound.has(t));
      const skipped = tokens.filter((t) => knownNotFound.has(t)).length;
      if (unknown.length === 0) {
        setResolveSummary({ fetched: 0, notFound: [] });
        toast.success(
          skipped > 0
            ? `Nothing new to look up (${skipped.toLocaleString()} already confirmed not in Walmart).`
            : "All GTINs already in cached catalog."
        );
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
      for (let i = 0; i < skus.length; i += CHUNK) {
        const chunk = skus.slice(i, i + CHUNK);
        const res = await enrichCatalogStep({
          data: { batchSize: chunk.length, onlySkus: chunk, reenrich: true },
        });
        enriched += res.enriched;
        partial += res.partial;
        failed += res.failed;
        processed += res.processed;
        setEnrichMsg(
          `Processed ${processed}/${skus.length} · enriched ${enriched} · partial ${partial} · errors ${failed}`
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
