import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { SearchFilter } from "@/components/SearchFilter";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateDisplays";
import { getCatalogIdentifiers, type CatalogIdentifier } from "@/services/wfs.functions";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";

export const Route = createFileRoute("/catalog")({
  component: CatalogPage,
  head: () => ({
    meta: [
      { title: "Catalog Identifiers — WFS Operations" },
      { name: "description", content: "SKU, GTIN, and UPC for all catalog items" },
    ],
  }),
});

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
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, error, refetch } = useQuery<CatalogIdentifier[]>({
    queryKey: ["catalog-identifiers"],
    queryFn: () => getCatalogIdentifiers(),
    retry: 1,
  });

  const filtered = useMemo(() => {
    if (!data) return undefined;
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    return data.filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.gtin.toLowerCase().includes(q) ||
        r.upc.toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Catalog Identifiers</h1>
            <p className="text-sm text-muted-foreground mt-1">
              SKU, GTIN, and UPC for every item in your catalog
              {data ? ` — ${data.length.toLocaleString()} items` : ""}
            </p>
          </div>
          {data && data.length > 0 && (
            <button
              onClick={() => downloadCsv(filtered ?? data)}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Export CSV
            </button>
          )}
        </div>

        <div className="w-full sm:w-96">
          <SearchFilter value={search} onChange={setSearch} placeholder="Search SKU, GTIN, UPC, or name..." />
        </div>

        {isLoading && <LoadingState message="Loading catalog..." />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {filtered && filtered.length === 0 && <EmptyState message="No items match your search" />}

        {filtered && filtered.length > 0 && (
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
              {filtered.map((row) => (
                <tr key={row.sku} className="hover:bg-muted/30 transition-colors">
                  <Td>
                    <a href={`/sku/${row.sku}`} className="font-mono text-xs text-primary hover:underline">
                      {row.sku}
                    </a>
                  </Td>
                  <Td className="max-w-[420px] truncate">{row.productName || <span className="text-muted-foreground">—</span>}</Td>
                  <Td className="font-mono text-xs">{row.gtin || <span className="text-muted-foreground">—</span>}</Td>
                  <Td className="font-mono text-xs">{row.upc || <span className="text-muted-foreground">—</span>}</Td>
                </tr>
              ))}
            </tbody>
          </DataTableShell>
        )}
      </div>
    </DashboardLayout>
  );
}
