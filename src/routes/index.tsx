import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import { LoadingState, ErrorState } from "@/components/StateDisplays";
import { getOverview, getAlerts } from "@/services/wfs.functions";
import {
  Package,
  ShoppingCart,
  Truck,
  AlertTriangle,
  TrendingDown,
  Archive,
  BarChart3,
  Boxes,
  CheckCircle2,
  CalendarDays,
  DollarSign,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Alert, DashboardOverview } from "@/types/wfs";

function usd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

export const Route = createFileRoute("/")({
  component: OverviewPage,
  head: () => ({
    meta: [
      { title: "Overview — WFS Operations" },
      { name: "description", content: "Executive overview of WFS operations" },
    ],
  }),
});

function OverviewPage() {
  const overview = useQuery<DashboardOverview>({
    queryKey: ["overview"],
    queryFn: () => getOverview(),
    retry: 1,
    staleTime: 5 * 60 * 1000, // 5 min — avoid refetch on HMR / re-render
  });

  const alerts = useQuery<Alert[]>({
    queryKey: ["alerts-summary"],
    queryFn: () => getAlerts(),
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Executive Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time WFS operations summary
          </p>
        </div>

        {overview.isLoading && <LoadingState message="Loading overview..." />}
        {overview.isError && (
          <ErrorState
            message={overview.error.message}
            onRetry={() => overview.refetch()}
          />
        )}

        {overview.data && (
          <>
            {/* WFS Catalog SKU counts */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KpiCard
                title="WFS Catalog SKUs"
                value={overview.data.wfsCatalogSkuCount}
                subtitle="Total SKUs enrolled in WFS"
                icon={Boxes}
              />
              <KpiCard
                title="Active SKUs"
                value={overview.data.activeSkuCount}
                subtitle="SKUs with stock on-hand"
                icon={CheckCircle2}
                variant={overview.data.activeSkuCount > 0 ? "healthy" : "warning"}
              />
            </div>

            {/* Revenue KPIs — matches Seller Center "WFS Sales Insights" */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="Revenue Today"
                value={usd(overview.data.revenueToday)}
                subtitle={`${overview.data.salesToday} units`}
                icon={DollarSign}
              />
              <KpiCard
                title="Revenue This Week"
                value={usd(overview.data.revenueThisWeek)}
                subtitle={`${overview.data.salesThisWeek} units`}
                icon={DollarSign}
              />
              <KpiCard
                title="Revenue MTD"
                value={usd(overview.data.revenueMTD)}
                subtitle={`${overview.data.salesMTD} units`}
                icon={DollarSign}
              />
              <KpiCard
                title="Revenue YTD"
                value={usd(overview.data.revenueYTD)}
                subtitle={`${overview.data.salesYTD} units · Jan 1–today`}
                icon={CalendarDays}
              />
            </div>

            {/* Inventory KPIs */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="Total WFS Inventory"
                value={overview.data.totalWfsInventory}
                subtitle="Units on hand"
                icon={Package}
              />
              <KpiCard
                title="Units Today"
                value={overview.data.salesToday}
                subtitle="WFS units sold"
                icon={ShoppingCart}
              />
              <KpiCard
                title="Units This Week"
                value={overview.data.salesThisWeek}
                subtitle="WFS units (Sun–today)"
                icon={BarChart3}
              />
              <KpiCard
                title="Units MTD"
                value={overview.data.salesMTD}
                subtitle="WFS units this month"
                icon={TrendingDown}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="Inbound Units"
                value={overview.data.inboundUnits}
                icon={Truck}
                variant="default"
              />
              <KpiCard
                title="Low Stock SKUs"
                value={overview.data.lowStockCount}
                icon={AlertTriangle}
                variant={overview.data.lowStockCount > 0 ? "warning" : "healthy"}
              />
              <KpiCard
                title="Overstock SKUs"
                value={overview.data.overstockCount}
                icon={Archive}
                variant={overview.data.overstockCount > 0 ? "warning" : "healthy"}
              />
              <KpiCard
                title="Aged Inventory"
                value={overview.data.agedInventoryCount}
                subtitle="No sales in 30 days"
                icon={Package}
                variant={overview.data.agedInventoryCount > 0 ? "critical" : "healthy"}
              />
            </div>
          </>
        )}

        {/* Alerts Panel */}
        {alerts.data && alerts.data.length > 0 && (
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold">Active Alerts</h2>
              <StatusBadge variant="critical">
                {alerts.data.filter((a) => a.severity === "critical").length} Critical
              </StatusBadge>
            </div>
            <div className="divide-y max-h-80 overflow-y-auto">
              {alerts.data.slice(0, 10).map((alert) => (
                <div key={alert.id} className="flex items-start gap-3 px-5 py-3">
                  <StatusBadge variant={alert.severity === "critical" ? "critical" : alert.severity === "warning" ? "warning" : "info"}>
                    {alert.severity}
                  </StatusBadge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{alert.message}</p>
                    {alert.sku && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        SKU: {alert.sku} — {alert.productName}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
