import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { SearchFilter } from "@/components/SearchFilter";
import { ErrorState, EmptyState } from "@/components/StateDisplays";
import { getCatalogPage, type CatalogIdentifier } from "@/services/wfs.functions";
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

type Lifecycle = "ACTIVE" | "ARCHIVED" | "RETIRED";

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

function CatalogPage() {
  const [items, setItems] = useState<CatalogIdentifier[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle>("ACTIVE");
  const [done, setDone] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Use refs to avoid stale closures inside the load loop
  const cursorRef = useRef<string | null>(null);
  const lifecycleRef = useRef<Lifecycle>("ACTIVE");
  const seenRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    void runLoader();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runLoader() {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);

    try {
      while (!cancelledRef.current && !pausedRef.current) {
        const page = await getCatalogPage({
          data: {
            cursor: cursorRef.current,
            lifecycle: lifecycleRef.current,
          },
        });

        if (cancelledRef.current) return;

        const fresh = page.items.filter((it) => {
          if (seenRef.current.has(it.sku)) return false;
          seenRef.current.add(it.sku);
          return true;
        });
        if (fresh.length) setItems((prev) => [...prev, ...fresh]);
        if (page.totalCount != null) setTotalCount(page.totalCount);

        if (page.nextCursor) {
          cursorRef.current = page.nextCursor;
        } else if (page.nextLifecycle) {
          cursorRef.current = null;
          lifecycleRef.current = page.nextLifecycle;
          setLifecycle(page.nextLifecycle);
        } else {
          setDone(true);
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      runningRef.current = false;
    }
  }

  function togglePause() {
    if (done) return;
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      void runLoader();
    } else {
      pausedRef.current = true;
      setPaused(true);
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.gtin.toLowerCase().includes(q) ||
        r.upc.toLowerCase().includes(q)
    );
  }, [items, search]);

  // Cap rendered rows to keep DOM responsive on huge catalogs
  const RENDER_CAP = 2000;
  const visibleRows = filtered.slice(0, RENDER_CAP);
  const truncated = filtered.length > RENDER_CAP;

  const progressLabel = (() => {
    if (done) return `Loaded ${items.length.toLocaleString()} items`;
    if (totalCount && totalCount > 0) {
      return `Loading ${items.length.toLocaleString()} of ${totalCount.toLocaleString()} items (${lifecycle.toLowerCase()})`;
    }
    return `Loading ${items.length.toLocaleString()} items (${lifecycle.toLowerCase()})…`;
  })();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Catalog Identifiers</h1>
            <p className="text-sm text-muted-foreground mt-1">
              SKU, GTIN, and UPC for every item in your catalog
            </p>
          </div>
          <div className="flex gap-2">
            {!done && (
              <button
                onClick={togglePause}
                className="rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium hover:opacity-90"
              >
                {paused ? "Resume" : "Pause"}
              </button>
            )}
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

        {/* Progress indicator */}
        <div className="flex items-center gap-3 text-sm">
          {!done && !paused && !error && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
          )}
          {paused && <span className="inline-block h-2 w-2 rounded-full bg-status-warning" />}
          {done && <span className="inline-block h-2 w-2 rounded-full bg-status-healthy" />}
          <span className="text-muted-foreground">{progressLabel}</span>
        </div>

        <div className="w-full sm:w-96">
          <SearchFilter value={search} onChange={setSearch} placeholder="Search SKU, GTIN, UPC, or name..." />
        </div>

        {error && <ErrorState message={error} onRetry={() => { setError(null); void runLoader(); }} />}

        {!error && items.length === 0 && !done && (
          <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
            Fetching first page from Walmart…
          </div>
        )}

        {!error && done && items.length === 0 && <EmptyState message="No items in catalog" />}

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
