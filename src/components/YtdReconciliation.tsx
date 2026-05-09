import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { getYtdReconciliation, type YtdReconciliation } from "@/services/wfs.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "wfs:sellerCenterYTD";

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function pct(part: number, whole: number): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(2)}%`;
}

interface SellerCenterTotals {
  units: string;
  revenue: string;
}

function loadStored(): SellerCenterTotals {
  if (typeof window === "undefined") return { units: "", revenue: "" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { units: "", revenue: "" };
    const parsed = JSON.parse(raw);
    return { units: String(parsed.units ?? ""), revenue: String(parsed.revenue ?? "") };
  } catch {
    return { units: "", revenue: "" };
  }
}

export function YtdReconciliationPanel() {
  const [sc, setSc] = useState<SellerCenterTotals>({ units: "", revenue: "" });
  const [drillOpen, setDrillOpen] = useState(false);

  useEffect(() => {
    setSc(loadStored());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sc));
  }, [sc]);

  const recon = useQuery<YtdReconciliation>({
    queryKey: ["ytd-reconciliation"],
    queryFn: () => getYtdReconciliation(),
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  const scUnits = Number(sc.units) || 0;
  const scRevenue = Number(sc.revenue) || 0;

  const dashUnits = recon.data?.totals.units ?? 0;
  const dashRevenue = recon.data?.totals.revenue ?? 0;

  const unitsDelta = dashUnits - scUnits;
  const revenueDelta = dashRevenue - scRevenue;

  const deltaTone = (delta: number, base: number): "healthy" | "warning" | "critical" => {
    if (!base) return "warning";
    const ratio = Math.abs(delta) / base;
    if (ratio < 0.01) return "healthy";
    if (ratio < 0.05) return "warning";
    return "critical";
  };

  return (
    <section className="rounded-lg border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold">YTD Reconciliation</h2>
          <p className="text-xs text-muted-foreground">
            Compare dashboard YTD against your Seller Center totals.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => recon.refetch()}
          disabled={recon.isFetching}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", recon.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <div className="grid gap-4 p-5 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Seller Center YTD (manual entry)
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sc-units" className="text-xs">Units sold</Label>
              <Input
                id="sc-units"
                type="number"
                inputMode="numeric"
                placeholder="e.g. 1749"
                value={sc.units}
                onChange={(e) => setSc((p) => ({ ...p, units: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sc-revenue" className="text-xs">Revenue (USD)</Label>
              <Input
                id="sc-revenue"
                type="number"
                inputMode="decimal"
                placeholder="e.g. 201000"
                value={sc.revenue}
                onChange={(e) => setSc((p) => ({ ...p, revenue: e.target.value }))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Saved locally in your browser. Pull these from Seller Center → WFS Sales Insights.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <DeltaCard
            label="Units delta"
            dashboard={dashUnits.toLocaleString()}
            seller={scUnits.toLocaleString()}
            deltaText={`${unitsDelta >= 0 ? "+" : ""}${unitsDelta.toLocaleString()} (${pct(unitsDelta, scUnits)})`}
            tone={deltaTone(unitsDelta, scUnits)}
            loading={recon.isLoading}
          />
          <DeltaCard
            label="Revenue delta"
            dashboard={usd(dashRevenue)}
            seller={usd(scRevenue)}
            deltaText={`${revenueDelta >= 0 ? "+" : ""}${usd(revenueDelta)} (${pct(revenueDelta, scRevenue)})`}
            tone={deltaTone(revenueDelta, scRevenue)}
            loading={recon.isLoading}
          />
        </div>
      </div>

      {recon.isError && (
        <div className="border-t px-5 py-3 text-sm text-destructive">
          Failed to load reconciliation: {(recon.error as Error).message}
        </div>
      )}

      <div className="border-t">
        <button
          type="button"
          className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium hover:bg-muted/40"
          onClick={() => setDrillOpen((o) => !o)}
        >
          <span className="flex items-center gap-2">
            {drillOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Drill-down: underlying order lines
            {recon.data && (
              <span className="text-xs text-muted-foreground">
                ({recon.data.lines.length.toLocaleString()} lines)
              </span>
            )}
          </span>
        </button>

        {drillOpen && (
          <div className="border-t px-5 py-4">
            {recon.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : recon.data ? (
              <DrillDown data={recon.data} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function DeltaCard({
  label,
  dashboard,
  seller,
  deltaText,
  tone,
  loading,
}: {
  label: string;
  dashboard: string;
  seller: string;
  deltaText: string;
  tone: "healthy" | "warning" | "critical";
  loading: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <StatusBadge variant={tone === "healthy" ? "healthy" : tone === "warning" ? "warning" : "critical"}>
          {tone === "healthy" ? "Match" : tone === "warning" ? "Minor" : "Mismatch"}
        </StatusBadge>
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-24" />
      ) : (
        <p className="mt-1 text-lg font-semibold tracking-tight">{deltaText}</p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <span>Dashboard: <span className="font-medium text-foreground">{dashboard}</span></span>
        <span>Seller: <span className="font-medium text-foreground">{seller}</span></span>
      </div>
    </div>
  );
}

function DrillDown({ data }: { data: YtdReconciliation }) {
  const [skuFilter, setSkuFilter] = useState("");

  const filteredLines = useMemo(() => {
    const q = skuFilter.trim().toLowerCase();
    if (!q) return data.lines.slice(0, 500);
    return data.lines
      .filter((l) => l.sku.toLowerCase().includes(q) || l.productName.toLowerCase().includes(q) || l.purchaseOrderId.toLowerCase().includes(q))
      .slice(0, 500);
  }, [data.lines, skuFilter]);

  return (
    <Tabs defaultValue="sku">
      <TabsList>
        <TabsTrigger value="sku">By SKU</TabsTrigger>
        <TabsTrigger value="month">By Month</TabsTrigger>
        <TabsTrigger value="lines">Order lines</TabsTrigger>
      </TabsList>

      <TabsContent value="sku">
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/70 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.bySku.map((row) => (
                <tr key={row.sku} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-xs">{row.sku}</td>
                  <td className="px-3 py-2 truncate max-w-xs">{row.productName || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.units.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(row.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="month">
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/70 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Month</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.byMonth.map((row) => (
                <tr key={row.month} className="hover:bg-muted/30">
                  <td className="px-3 py-2">{row.month}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.units.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(row.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TabsContent>

      <TabsContent value="lines">
        <div className="mb-2">
          <Input
            placeholder="Filter by SKU, product, or PO ID…"
            value={skuFilter}
            onChange={(e) => setSkuFilter(e.target.value)}
            className="max-w-md"
          />
        </div>
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/70 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">PO ID</th>
                <th className="px-3 py-2 text-left">Line</th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredLines.map((l, i) => (
                <tr key={`${l.purchaseOrderId}-${l.lineNumber}-${l.sku}-${i}`} className="hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">{l.date}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.purchaseOrderId}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.lineNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.sku}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(l.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.lines.length > filteredLines.length && (
            <div className="bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Showing {filteredLines.length.toLocaleString()} of {data.lines.length.toLocaleString()} lines. Filter to narrow further.
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
