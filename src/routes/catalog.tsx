import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { SearchFilter } from "@/components/SearchFilter";
import { ErrorState, EmptyState } from "@/components/StateDisplays";
import {
  getCachedCatalog,
  syncCatalogStep,
  type CatalogIdentifier,
  type CatalogSyncState,
} from "@/services/wfs.functions";
import { useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/catalog")({
  component: CatalogPage,
  head: () => ({
    meta: [
      { title: "Catalog Identifiers — WFS Operations" },
      { name: "description", content: "SKU, GTIN, and UPC for all catalog items" },
    ],
  }),
});

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const STALE_MS = 24 * 60 * 60 * 1000; // auto-sync if cache older than 24h

type ConditionFilter = "ALL" | string;

function downloadCsv(rows: CatalogIdentifier[]) {
  const header = ["SKU", "Product Name", "GTIN", "UPC"];
  const escape = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    header.join(","),
    ...rows.map((r) => [r.sku, r.productName, r.gtin, r.upc].map(escape).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `catalog-identifiers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function CatalogPage() {
  const [items, setItems] = useState<CatalogIdentifier[]>([]);
  const [state, setState] = useState<CatalogSyncState | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [conditionFilter, setConditionFilter] = useState<ConditionFilter>("ALL");

  const cancelledRef = useRef(false);
  const itemsMapRef = useRef<Map<string, CatalogIdentifier>>(new Map());

  // Initial load: cached items + state, then auto-sync if stale
  useEffect(() => {
    cancelledRef.current = false;
    void (async () => {
      try {
        const res = await getCachedCatalog();
        if (cancelledRef.current) return;
        const map = new Map<string, CatalogIdentifier>();
        for (const it of res.items) map.set(it.sku, it);
        itemsMapRef.current = map;
        setItems(res.items);
        setState(res.state);
        setLoading(false);

        const lastSync = res.state.last_sync_at ? new Date(res.state.last_sync_at).getTime() : 0;
        const stale = Date.now() - lastSync > STALE_MS;
        const inProgress = res.state.status === "running" && res.state.cursor;
        if (stale || inProgress) {
          void runSync(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSync(reset: boolean) {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      let firstPass = true;
      // eslint-disable-next-line no-constant-condition
      while (!cancelledRef.current) {
        const result = await syncCatalogStep({ data: { reset: reset && firstPass } });
        firstPass = false;
        setState(result.state);

        // Refresh just this lifecycle bucket's new items by re-reading them is costly;
        // instead, re-pull cached catalog when sync finishes a lifecycle bucket or completes.
        if (result.done || !result.state.cursor) {
          const fresh = await getCachedCatalog();
          if (cancelledRef.current) return;
          const map = new Map<string, CatalogIdentifier>();
          for (const it of fresh.items) map.set(it.sku, it);
          itemsMapRef.current = map;
          setItems(fresh.items);
          setState(fresh.state);
        }

        if (result.done) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((r) => {
      if (conditionFilter !== "ALL" && (r.condition ?? "") !== conditionFilter) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.gtin.toLowerCase().includes(q) ||
        r.upc.toLowerCase().includes(q)
      );
    });
  }, [items, search, conditionFilter]);

  const conditionCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of items) {
      const k = r.condition?.trim() || "Unknown";
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1]);
  }, [items]);

  const RENDER_CAP = 2000;
  const visibleRows = filtered.slice(0, RENDER_CAP);
  const truncated = filtered.length > RENDER_CAP;

  const statusLabel = (() => {
    if (loading) return "Loading cached catalog…";
    if (syncing) {
      const lc = state?.lifecycle ?? "ACTIVE";
      const pages = state?.pages_this_run ?? 0;
      return `Syncing (${lc.toLowerCase()}, page ${pages}) — ${items.length.toLocaleString()} cached`;
    }
    return `${items.length.toLocaleString()} items cached · last sync ${timeAgo(state?.last_sync_at ?? null)}`;
  })();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Catalog Identifiers</h1>
            <p className="text-sm text-muted-foreground mt-1">
              SKU, GTIN, and UPC for every item in your catalog. Cached locally — only new/changed items are pulled.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void runSync(false)}
              disabled={syncing || loading}
              className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              onClick={() => void runSync(true)}
              disabled={syncing || loading}
              title="Re-walk the entire catalog from scratch"
              className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              Full re-sync
            </button>
            {items.length > 0 && (
              <button
                onClick={() => downloadCsv(filtered)}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Export CSV ({filtered.length.toLocaleString()})
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {syncing && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />}
          {!syncing && !loading && <span className="inline-block h-2 w-2 rounded-full bg-status-healthy" />}
          <span className="text-muted-foreground">{statusLabel}</span>
          {state?.last_full_sync_at && (
            <span className="text-muted-foreground">· full re-sync {timeAgo(state.last_full_sync_at)}</span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="w-full sm:w-96">
            <SearchFilter value={search} onChange={setSearch} placeholder="Search SKU, GTIN, UPC, or name..." />
          </div>
          <Select value={conditionFilter} onValueChange={(v) => setConditionFilter(v)}>
            <SelectTrigger className="w-full sm:w-64 bg-secondary border-border">
              <SelectValue placeholder="Item condition" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All conditions ({items.length.toLocaleString()})</SelectItem>
              {conditionCounts.map(([cond, n]) => (
                <SelectItem key={cond} value={cond}>
                  {cond} ({n.toLocaleString()})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && <ErrorState message={error} onRetry={() => { setError(null); void runSync(false); }} />}

        {!error && !loading && items.length === 0 && !syncing && (
          <EmptyState message="No items cached yet. Click 'Sync now' to fetch your catalog." />
        )}

        {visibleRows.length > 0 && (
          <>
            <DataTableShell>
              <Thead>
                <tr>
                  <Th>SKU</Th>
                  <Th>Product</Th>
                  <Th>GTIN</Th>
                  <Th>UPC</Th>
                </tr>
              </Thead>
              <tbody className="divide-y">
                {visibleRows.map((row) => (
                  <tr key={row.sku} className="hover:bg-muted/30 transition-colors">
                    <Td>
                      <a href={`/sku/${row.sku}`} className="font-mono text-xs text-primary hover:underline">
                        {row.sku}
                      </a>
                    </Td>
                    <Td className="max-w-[420px] truncate">
                      {row.productName || <span className="text-muted-foreground">—</span>}
                    </Td>
                    <Td className="font-mono text-xs">
                      {row.gtin || <span className="text-muted-foreground">—</span>}
                    </Td>
                    <Td className="font-mono text-xs">
                      {row.upc || <span className="text-muted-foreground">—</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTableShell>
            {truncated && (
              <p className="text-xs text-muted-foreground">
                Showing first {RENDER_CAP.toLocaleString()} of {filtered.length.toLocaleString()} matching rows.
                Narrow your search or use Export CSV for the full list.
              </p>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
