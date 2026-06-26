import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  enrichCatalogStep,
  getEnrichmentOverview,
  importDimensions,
  submitWfsConversion,
  type CatalogIdentifier,
  type EnrichmentOverview,
  type ImportDimensionsResult,
  type WfsConversionRunResult,
} from "@/services/wfs.functions";

import { classifySds, type SdsClassification, type SdsRequirement } from "@/lib/sdsClassifier";
import { SearchFilter } from "@/components/SearchFilter";
import { CategoryFilter } from "@/components/CategoryFilter";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Row = CatalogIdentifier & { sds: SdsClassification };

type SdsFilter = "ALL" | SdsRequirement;

const RENDER_CAP = 2000;

const DIM_TEMPLATE_HEADER = [
  "SKU",
  "UPC",
  "GTIN",
  "Product Name",
  "Length (in)",
  "Width (in)",
  "Height (in)",
  "Weight (lb)",
  "Country Of Origin",
] as const;

function csvEscape(v: string): string {
  return `"${(v ?? "").replace(/"/g, '""')}"`;
}
function csvEscapeId(v: string): string {
  const s = (v ?? "").replace(/"/g, '""');
  return s ? `="${s}"` : `""`;
}

function exportDimensionsTemplate(rows: Row[]) {
  const lines = [DIM_TEMPLATE_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.sku),
        csvEscapeId(r.upc),
        csvEscapeId(r.gtin),
        csvEscape(r.productName),
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
  a.download = `wfs-dimensions-template-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Minimal CSV parser supporting quoted fields, escaped quotes, and ="..." cells.
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    if (c === "=" && src[i + 1] === '"') {
      // Skip Excel formula prefix; the next quote starts the quoted cell.
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.length > 1 || (r[0] && r[0].trim() !== ""));
}

interface ParsedDimRow {
  sku: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  countryOfOrigin?: string;
}

function parseDimensionsCsv(text: string): { rows: ParsedDimRow[]; errors: string[] } {
  const errors: string[] = [];
  const grid = parseCsv(text);
  if (grid.length === 0) return { rows: [], errors: ["empty file"] };
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const iSku = idx(["sku"]);
  const iLen = idx(["length"]);
  const iWid = idx(["width"]);
  const iHei = idx(["height"]);
  const iWgt = idx(["weight"]);
  const iCoo = idx(["country of origin", "country_of_origin", "country"]);
  if (iSku < 0) {
    errors.push("missing SKU column");
    return { rows: [], errors };
  }
  if (iLen < 0 || iWid < 0 || iHei < 0 || iWgt < 0) {
    errors.push("missing one or more of Length / Width / Height / Weight columns");
    return { rows: [], errors };
  }
  const num = (s: string | undefined): number | null => {
    if (s == null) return null;
    const t = s.replace(/[",=]/g, "").trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const rows: ParsedDimRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const sku = (cells[iSku] ?? "").replace(/[",=]/g, "").trim();
    if (!sku) continue;
    rows.push({
      sku,
      length: num(cells[iLen]),
      width: num(cells[iWid]),
      height: num(cells[iHei]),
      weight: num(cells[iWgt]),
      countryOfOrigin: iCoo >= 0 ? (cells[iCoo] ?? "").trim() || undefined : undefined,
    });
  }
  return { rows, errors };
}


function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" }) {
  const toneCls =
    tone === "ok"
      ? "text-status-healthy"
      : tone === "warn"
      ? "text-status-warning"
      : tone === "bad"
      ? "text-status-critical"
      : "text-foreground";
  return (
    <div className="rounded border border-border bg-background/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm ${toneCls}`}>{value.toLocaleString()}</div>
    </div>
  );
}

export function BulkConvertWfs({ items }: { items: CatalogIdentifier[] }) {
  // Only seller-fulfilled items (any kind) are eligible. Walmart-fulfilled
  // and Unknown items are excluded from this tab entirely.
  const eligibleAll: Row[] = useMemo(() => {
    return items
      .filter((r) => {
        const f = r.fulfillment ?? "Unknown";
        if (f !== "Seller Fulfilled" && f !== "Seller Fulfilled (WFS Eligible)") return false;
        const cond = (r.condition ?? "").toLowerCase().replace(/[\s_-]/g, "");
        return cond === "openbox";
      })
      .map((r) => ({ ...r, sds: classifySds(r.productName) }));
  }, [items]);

  const [search, setSearch] = useState("");
  const [sdsFilter, setSdsFilter] = useState<SdsFilter>("Not required");
  const [readyOnly, setReadyOnly] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WfsConversionRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return eligibleAll.filter((r) => {
      if (readyOnly && r.enrichmentStatus !== "enriched") return false;
      if (sdsFilter !== "ALL" && r.sds.requirement !== sdsFilter) return false;
      if (selectedCategories.length > 0) {
        const cat = (r.category ?? "").trim() || "Uncategorized";
        if (!selectedCategories.includes(cat)) return false;
      }
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.gtin.toLowerCase().includes(q) ||
        r.upc.toLowerCase().includes(q)
      );
    });
  }, [eligibleAll, search, sdsFilter, readyOnly, selectedCategories]);

  const readyCount = useMemo(
    () => eligibleAll.filter((r) => r.enrichmentStatus === "enriched").length,
    [eligibleAll]
  );


  const sdsCounts = useMemo(() => {
    const c = new Map<SdsRequirement, number>([
      ["Likely required", 0],
      ["Possibly required", 0],
      ["Not required", 0],
    ]);
    for (const r of eligibleAll) c.set(r.sds.requirement, (c.get(r.sds.requirement) ?? 0) + 1);
    return c;
  }, [eligibleAll]);

  const categoryCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of eligibleAll) {
      const k = r.category?.trim() || "Uncategorized";
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1]);
  }, [eligibleAll]);

  const visible = filtered.slice(0, RENDER_CAP);
  const truncated = filtered.length > RENDER_CAP;

  const selectedFlagged = useMemo(() => {
    let n = 0;
    for (const r of eligibleAll) {
      if (!selected.has(r.sku)) continue;
      if (r.sds.requirement !== "Not required") n++;
    }
    return n;
  }, [selected, eligibleAll]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.sku));

  function toggleOne(sku: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const r of filtered) next.delete(r.sku);
      } else {
        for (const r of filtered) next.add(r.sku);
      }
      return next;
    });
  }

  async function runConvert() {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const skus = Array.from(selected);
      if (skus.length > 500) {
        throw new Error("Walmart limits each submission to 500 SKUs. Narrow your selection.");
      }
      const res = await submitWfsConversion({ data: { skus } });
      setResult(res);
      toast.success(
        `Submitted ${res.submittedCount.toLocaleString()} SKUs — feedId ${res.feedId ?? "(pending)"}, status ${res.status}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`WFS conversion failed: ${msg}`);
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }

  // ─── Catalog enrichment runner ────────────────────────
  const [enrichOverview, setEnrichOverview] = useState<EnrichmentOverview | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<string>("");
  const stopEnrichRef = useRef(false);

  // ─── Dimensions import ────────────────────────────────
  const dimFileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportDimensionsResult | null>(null);

  async function onDimensionsFile(file: File) {
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const { rows, errors } = parseDimensionsCsv(text);
      if (errors.length > 0) throw new Error(errors.join("; "));
      if (rows.length === 0) throw new Error("no data rows found");
      const res = await importDimensions({ data: { rows } });
      setImportResult(res);
      toast.success(
        `Updated ${res.updated.toLocaleString()} SKUs · skipped ${res.skipped.toLocaleString()} · ${res.errors.length} errors`
      );
      void refreshOverview();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setImporting(false);
      if (dimFileRef.current) dimFileRef.current.value = "";
    }
  }



  const refreshOverview = useCallback(async () => {
    try {
      const o = await getEnrichmentOverview();
      setEnrichOverview(o);
    } catch (e) {
      console.warn("enrichment overview failed", e);
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  async function runEnrichment(reenrich: boolean) {
    setEnriching(true);
    stopEnrichRef.current = false;
    let cursor: string | null = null;
    let totalProcessed = 0;
    let totalEnriched = 0;
    let totalPartial = 0;
    let totalFailed = 0;
    try {
      while (!stopEnrichRef.current) {
        const res = await enrichCatalogStep({
          data: { batchSize: 25, afterSku: cursor ?? undefined, reenrich },
        });
        totalProcessed += res.processed;
        totalEnriched += res.enriched;
        totalPartial += res.partial;
        totalFailed += res.failed;
        cursor = res.nextAfterSku;
        setEnrichProgress(
          `Processed ${totalProcessed} · enriched ${totalEnriched} · partial ${totalPartial} · errors ${totalFailed} · remaining ${res.remaining}`
        );
        if (res.done || res.processed === 0) break;
      }
      toast.success(
        `Enrichment complete — enriched ${totalEnriched}, partial ${totalPartial}, errors ${totalFailed}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Enrichment failed: ${msg}`);
    } finally {
      setEnriching(false);
      stopEnrichRef.current = false;
      void refreshOverview();
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
        Submits selected SKUs to Walmart via the <code className="text-foreground">WFS</code> convert feed.
        Walmart usually requires extra attributes (weight, dimensions, hazmat flag, country of origin) for full WFS
        conversion. Run <strong>Enrich catalog</strong> first to pull these fields from Walmart's items API — any SKU
        still marked <em>partial</em> is missing required data that the items API doesn't expose and must be filled in
        Seller Center.
      </div>

      {/* Enrichment panel */}
      <section className="rounded-md border border-border bg-secondary/20 p-3 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Catalog enrichment</h3>
            <p className="text-xs text-muted-foreground">
              Pulls brand, image, price, sub-category, country of origin, and shipping dims from
              <code className="mx-1">/v3/items/&#123;sku&#125;</code> into the catalog cache.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => runEnrichment(false)}
              disabled={enriching}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {enriching ? "Enriching…" : "Enrich pending"}
            </button>
            <button
              onClick={() => runEnrichment(true)}
              disabled={enriching}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/30 disabled:opacity-50"
            >
              Re-enrich all
            </button>
            {enriching && (
              <button
                onClick={() => {
                  stopEnrichRef.current = true;
                }}
                className="rounded-md border border-status-warning/40 px-3 py-1.5 text-xs font-medium text-status-warning hover:bg-status-warning/10"
              >
                Stop
              </button>
            )}
          </div>
        </div>
        {enrichOverview && (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            <Stat label="Total" value={enrichOverview.counts.total} />
            <Stat label="Enriched" value={enrichOverview.counts.enriched} tone="ok" />
            <Stat label="Partial" value={enrichOverview.counts.partial} tone="warn" />
            <Stat label="Pending" value={enrichOverview.counts.pending} />
            <Stat label="Errors" value={enrichOverview.counts.errored} tone="bad" />
          </div>
        )}
        {enrichProgress && (
          <p className="text-xs text-muted-foreground">{enrichProgress}</p>
        )}
        {enrichOverview?.state.lastRunAt && (
          <p className="text-[11px] text-muted-foreground">
            Last run: {new Date(enrichOverview.state.lastRunAt).toLocaleString()}
            {enrichOverview.state.lastFullRunAt
              ? ` · last full pass: ${new Date(enrichOverview.state.lastFullRunAt).toLocaleString()}`
              : ""}
          </p>
        )}
      </section>


      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="w-full sm:w-96">
          <SearchFilter
            value={search}
            onChange={setSearch}
            placeholder="Search SKU, GTIN, UPC, or name..."
          />
        </div>
        <Select value={sdsFilter} onValueChange={(v) => setSdsFilter(v as SdsFilter)}>
          <SelectTrigger className="w-full sm:w-72 bg-secondary border-border">
            <SelectValue placeholder="SDS requirement" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All SDS statuses ({eligibleAll.length.toLocaleString()})</SelectItem>
            <SelectItem value="Not required">
              Not required ({(sdsCounts.get("Not required") ?? 0).toLocaleString()})
            </SelectItem>
            <SelectItem value="Possibly required">
              Possibly required ({(sdsCounts.get("Possibly required") ?? 0).toLocaleString()})
            </SelectItem>
            <SelectItem value="Likely required">
              Likely required ({(sdsCounts.get("Likely required") ?? 0).toLocaleString()})
            </SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
          <input
            type="checkbox"
            checked={readyOnly}
            onChange={(e) => setReadyOnly(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          Ready to submit only ({readyCount.toLocaleString()})
        </label>
        <div className="w-full sm:w-72">
          <CategoryFilter
            options={categoryCounts.map(([label, count]) => ({ label, count }))}
            selected={selectedCategories}
            onChange={setSelectedCategories}
            placeholder="All categories"
          />
        </div>
        <div className="flex-1" />
        <div className="text-sm text-muted-foreground">
          {selected.size.toLocaleString()} selected
          {selectedFlagged > 0 && (
            <span className="ml-2 text-status-warning">· {selectedFlagged} SDS-flagged</span>
          )}
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={selected.size === 0 || submitting}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Submitting…" : `Convert ${selected.size.toLocaleString()} to WFS`}
        </button>
      </div>

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
                Failed / hazmat hold ({result.failedItems.length})
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

          {result.successSkus.length === 0 && result.failedItems.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No per-SKU outcomes yet — Walmart may still be processing. Recheck the feed status by feed ID in a few minutes.
            </p>
          )}
        </section>
      )}

      <DataTableShell>
        <Thead>
          <tr>
            <Th>
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleAllFiltered}
                className="h-4 w-4 cursor-pointer accent-primary"
                aria-label="Select all filtered"
              />
            </Th>
            <Th>SKU</Th>
            <Th>Product</Th>
            <Th>GTIN</Th>
            <Th>UPC</Th>
            <Th>Fulfillment</Th>
            <Th>SDS</Th>
          </tr>
        </Thead>
        <tbody className="divide-y">
          {visible.map((row) => {
            const isFlagged = row.sds.requirement !== "Not required";
            const sdsClass =
              row.sds.requirement === "Likely required"
                ? "bg-status-critical/15 text-status-critical"
                : row.sds.requirement === "Possibly required"
                ? "bg-status-warning/15 text-status-warning"
                : "bg-muted text-muted-foreground";
            return (
              <tr key={row.sku} className="hover:bg-muted/30 transition-colors">
                <Td>
                  <input
                    type="checkbox"
                    checked={selected.has(row.sku)}
                    onChange={() => toggleOne(row.sku)}
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </Td>
                <Td>
                  <a href={`/sku/${row.sku}`} className="font-mono text-xs text-primary hover:underline">
                    {row.sku}
                  </a>
                </Td>
                <Td className="max-w-[380px] truncate">
                  {row.productName || <span className="text-muted-foreground">—</span>}
                </Td>
                <Td className="font-mono text-xs">{row.gtin || <span className="text-muted-foreground">—</span>}</Td>
                <Td className="font-mono text-xs">{row.upc || <span className="text-muted-foreground">—</span>}</Td>
                <Td className="text-xs text-muted-foreground">{row.fulfillment}</Td>
                <Td>
                  <span
                    title={isFlagged ? `Triggered by: ${row.sds.reasons.join(", ")}` : "No SDS keywords detected"}
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sdsClass}`}
                  >
                    {row.sds.requirement}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </DataTableShell>

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing first {RENDER_CAP.toLocaleString()} of {filtered.length.toLocaleString()} matching rows. Narrow your
          search to see more.
        </p>
      )}

      {eligibleAll.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No Open Box seller-fulfilled items found in the cached catalog. Sync the catalog first.
        </p>
      )}
      {eligibleAll.length > 0 && filtered.length === 0 && readyOnly && (
        <p className="text-sm text-muted-foreground">
          No SKUs are fully enriched yet. Run <strong>Enrich pending</strong> above, or uncheck
          “Ready to submit only” to see SKUs that still need more data.
        </p>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Convert {selected.size.toLocaleString()} SKUs to WFS?</AlertDialogTitle>
            <AlertDialogDescription>
              This submits a Walmart <code>WFS</code> convert feed for the selected SKUs.
              {selectedFlagged > 0 && (
                <span className="mt-2 block rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-status-warning">
                  ⚠ {selectedFlagged} of the selected SKUs are flagged as needing SDS documentation.
                  Walmart will likely reject these until you provide an SDS URL in Seller Center.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runConvert} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit feed"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
