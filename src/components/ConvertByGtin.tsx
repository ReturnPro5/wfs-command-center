import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import {
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

export function ConvertByGtin({ items }: Props) {
  const [pasted, setPasted] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; resolved: number; notFound: number } | null>(null);
  const [result, setResult] = useState<WfsConversionRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [convertedSkus, setConvertedSkus] = useState<Set<string>>(new Set());
  // SKUs pulled from Walmart on demand for tokens that weren't in the cache
  // (Unpublished / Retired / Archived items not covered by the normal sync).
  const [extraItems, setExtraItems] = useState<Map<string, CatalogIdentifier>>(new Map());
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
    for (const t of tokens) {
      const hits = idMap.get(t);
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
        // Convert-by-GTIN intentionally accepts items regardless of
        // fulfillment / lifecycle / published status — the operator pasted
        // the GTIN explicitly. Only the Open Box condition gate (enforced
        // server-side too) blocks here.
        const cond = (it.condition ?? "").toLowerCase().replace(/[\s_-]/g, "");
        if (cond !== "openbox") {
          ineligible.push({ token: t, item: it, reason: `condition=${it.condition || "—"}` });
          continue;
        }
        matched.push({ token: t, item: it });
      }
    }
    return { matched, unmatched, ineligible, alreadyConverted };
  }, [tokens, idMap, convertedSkus]);

  async function runLookup() {
    if (tokens.length === 0) return;
    setResolving(true);
    setError(null);
    setProgress(null);
    try {
      const unknown = tokens.filter((t) => !idMap.has(t));
      if (unknown.length === 0) {
        setResolveSummary({ fetched: 0, notFound: [] });
        toast.success("All GTINs already in cached catalog.");
        return;
      }

      const CHUNK = 200;
      const total = unknown.length;
      let fetchedTotal = 0;
      const notFoundAll: string[] = [];
      let resolvedCount = 0;
      setProgress({ done: 0, total, resolved: 0, notFound: 0 });

      for (let i = 0; i < total; i += CHUNK) {
        const batch = unknown.slice(i, i + CHUNK);
        const res = await resolveIdentifiers({ data: { identifiers: batch } });
        if (res.resolved.length > 0) {
          setExtraItems((prev) => {
            const next = new Map(prev);
            for (const it of res.resolved) next.set(it.sku, it);
            return next;
          });
        }
        fetchedTotal += res.fetched;
        resolvedCount += res.resolved.length;
        notFoundAll.push(...res.notFound);
        setProgress({
          done: Math.min(i + batch.length, total),
          total,
          resolved: resolvedCount,
          notFound: notFoundAll.length,
        });
      }

      setResolveSummary({ fetched: fetchedTotal, notFound: notFoundAll });
      toast.success(
        `Found ${resolvedCount.toLocaleString()} SKU(s) (newly pulled: ${fetchedTotal})${
          notFoundAll.length > 0 ? ` · ${notFoundAll.length} not in Walmart` : ""
        }`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`Lookup failed: ${msg}`);
    } finally {
      setResolving(false);
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
        Paste GTINs or UPCs (one per line, or comma/space separated). Items with condition{" "}
        <strong>Open Box</strong> are eligible regardless of fulfillment, lifecycle, or published
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
          onClick={() => void runConvert()}
          disabled={submitting || resolution.matched.length === 0}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {submitting
            ? "Submitting…"
            : `Convert ${resolution.matched.length.toLocaleString()} to WFS`}
        </button>
      </div>


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
