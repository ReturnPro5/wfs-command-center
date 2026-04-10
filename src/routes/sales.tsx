import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { KpiCard } from "@/components/KpiCard";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { SearchFilter } from "@/components/SearchFilter";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateDisplays";
import { getSalesVelocity } from "@/services/wfs.functions";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { TrendingUp, TrendingDown, Minus, DollarSign, ShoppingCart, BarChart3 } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { SalesData, SalesTrend } from "@/types/wfs";

export const Route = createFileRoute("/sales")({
  component: SalesPage,
  head: () => ({
    meta: [
      { title: "Sales & Velocity — WFS Operations" },
      { name: "description", content: "Sales performance and velocity tracking" },
    ],
  }),
});

function SalesPage() {
  const [search, setSearch] = useState("");
  const [trendFilter, setTrendFilter] = useState<"all" | "rising" | "stable" | "declining">("all");

  const { data, isLoading, isError, error, refetch } = useQuery<{
    salesData: SalesData[];
    trends: SalesTrend[];
  }>({
    queryKey: ["sales-velocity"],
    queryFn: () => getSalesVelocity(),
    retry: 1,
  });

  const filtered = data?.salesData.filter((item) => {
    const matchesSearch =
      !search ||
      item.sku.toLowerCase().includes(search.toLowerCase()) ||
      item.productName.toLowerCase().includes(search.toLowerCase());
    const matchesTrend = trendFilter === "all" || item.trend === trendFilter;
    return matchesSearch && matchesTrend;
  });

  const totals = data?.salesData.reduce(
    (acc, s) => ({
      units7d: acc.units7d + s.unitsSold7d,
      units30d: acc.units30d + s.unitsSold30d,
      rev30d: acc.rev30d + s.revenue30d,
    }),
    { units7d: 0, units30d: 0, rev30d: 0 }
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sales & Velocity</h1>
          <p className="text-sm text-muted-foreground mt-1">Track sales performance and per-SKU velocity</p>
        </div>

        {isLoading && <LoadingState message="Loading sales data..." />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {data && totals && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <KpiCard title="Units Sold (7d)" value={totals.units7d} icon={ShoppingCart} />
              <KpiCard title="Units Sold (30d)" value={totals.units30d} icon={BarChart3} />
              <KpiCard title="Revenue (30d)" value={`$${totals.rev30d.toLocaleString()}`} icon={DollarSign} />
            </div>

            {/* Trend Chart */}
            {data.trends.length > 0 && (
              <div className="rounded-lg border bg-card p-5">
                <h2 className="text-sm font-semibold mb-4">Daily Sales Trend</h2>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={data.trends}>
                    <defs>
                      <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="oklch(0.65 0.18 250)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="oklch(0.65 0.18 250)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.015 260)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "oklch(0.60 0.02 260)" }} tickFormatter={(v) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 11, fill: "oklch(0.60 0.02 260)" }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "oklch(0.17 0.02 260)",
                        border: "1px solid oklch(0.25 0.015 260)",
                        borderRadius: "0.5rem",
                        color: "oklch(0.95 0.01 260)",
                        fontSize: "0.75rem",
                      }}
                    />
                    <Area type="monotone" dataKey="unitsSold" stroke="oklch(0.65 0.18 250)" fill="url(#salesGradient)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Table */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="w-full sm:w-72">
                <SearchFilter value={search} onChange={setSearch} />
              </div>
              <select
                value={trendFilter}
                onChange={(e) => setTrendFilter(e.target.value as any)}
                className="rounded-md border bg-secondary px-3 py-2 text-sm text-foreground"
              >
                <option value="all">All Trends</option>
                <option value="rising">Rising</option>
                <option value="stable">Stable</option>
                <option value="declining">Declining</option>
              </select>
            </div>

            {filtered && filtered.length === 0 && <EmptyState />}

            {filtered && filtered.length > 0 && (
              <DataTableShell>
                <Thead>
                  <tr>
                    <Th>SKU</Th>
                    <Th>Product</Th>
                    <Th className="text-right">Units (7d)</Th>
                    <Th className="text-right">Units (30d)</Th>
                    <Th className="text-right">Revenue (30d)</Th>
                    <Th className="text-right">Velocity (units/day)</Th>
                    <Th>Trend</Th>
                  </tr>
                </Thead>
                <tbody className="divide-y">
                  {filtered
                    .sort((a, b) => b.unitsSold30d - a.unitsSold30d)
                    .map((item) => (
                      <tr key={item.sku} className="hover:bg-muted/30 transition-colors">
                        <Td>
                          <a href={`/sku/${item.sku}`} className="font-mono text-xs text-primary hover:underline">
                            {item.sku}
                          </a>
                        </Td>
                        <Td className="max-w-[200px] truncate">{item.productName}</Td>
                        <Td className="text-right">{item.unitsSold7d.toLocaleString()}</Td>
                        <Td className="text-right">{item.unitsSold30d.toLocaleString()}</Td>
                        <Td className="text-right">${item.revenue30d.toLocaleString()}</Td>
                        <Td className="text-right font-mono">{item.velocity.toFixed(1)}</Td>
                        <Td>
                          <span className="inline-flex items-center gap-1 text-xs">
                            {item.trend === "rising" && <TrendingUp className="h-3.5 w-3.5 text-status-healthy" />}
                            {item.trend === "declining" && <TrendingDown className="h-3.5 w-3.5 text-status-critical" />}
                            {item.trend === "stable" && <Minus className="h-3.5 w-3.5 text-muted-foreground" />}
                            <span className="capitalize">{item.trend}</span>
                          </span>
                        </Td>
                      </tr>
                    ))}
                </tbody>
              </DataTableShell>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
