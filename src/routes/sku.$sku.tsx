import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { LoadingState, ErrorState } from "@/components/StateDisplays";
import { getSkuDetail } from "@/services/wfs.functions";
import { statusLabel, statusVariant } from "@/services/businessLogic";
import { useQuery } from "@tanstack/react-query";
import { Package, TrendingUp, Truck, Info } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { SkuDetail } from "@/types/wfs";

export const Route = createFileRoute("/sku/$sku")({
  component: SkuDetailPage,
  head: ({ params }) => ({
    meta: [
      { title: `SKU ${params.sku} — WFS Operations` },
      { name: "description", content: `Detail view for SKU ${params.sku}` },
    ],
  }),
});

function SkuDetailPage() {
  const { sku } = Route.useParams();

  const { data, isLoading, isError, error, refetch } = useQuery<SkuDetail>({
    queryKey: ["sku-detail", sku],
    queryFn: () => getSkuDetail({ data: { sku } }),
    retry: 1,
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <a href="/inventory" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Back to Inventory
          </a>
        </div>

        {isLoading && <LoadingState message={`Loading SKU ${sku}...`} />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {data && (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{data.productName}</h1>
                <p className="text-sm text-muted-foreground font-mono mt-1">{data.sku}</p>
              </div>
              <StatusBadge variant={statusVariant(data.status)}>
                {statusLabel(data.status)}
              </StatusBadge>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="On Hand" value={data.inventory.onHand} icon={Package} />
              <KpiCard title="Available to Sell" value={data.inventory.availableToSell} icon={Package} />
              <KpiCard title="Velocity" value={`${data.velocity.toFixed(1)}/day`} icon={TrendingUp} />
              <KpiCard
                title="Weeks of Supply"
                value={data.inventory.weeksOfSupply > 99 ? "99+" : data.inventory.weeksOfSupply.toFixed(1)}
                icon={Info}
                variant={(() => {
                  const v = statusVariant(data.status);
                  return v === "info" ? "default" : v;
                })()}
              />
            </div>

            {/* Inventory Breakdown */}
            <div className="rounded-lg border bg-card p-5">
              <h2 className="text-sm font-semibold mb-3">Inventory Breakdown</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">On Hand</p>
                  <p className="text-lg font-bold">{data.inventory.onHand.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Reserved</p>
                  <p className="text-lg font-bold">{data.inventory.reserved.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Inbound</p>
                  <p className="text-lg font-bold">{data.inventory.inbound.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Days of Supply</p>
                  <p className="text-lg font-bold">{data.inventory.daysOfSupply > 999 ? "999+" : data.inventory.daysOfSupply.toFixed(0)}</p>
                </div>
              </div>
            </div>

            {/* Sales History Chart */}
            {data.salesHistory.length > 0 && (
              <div className="rounded-lg border bg-card p-5">
                <h2 className="text-sm font-semibold mb-4">Sales History (30 Days)</h2>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={data.salesHistory}>
                    <defs>
                      <linearGradient id="skuSalesGradient" x1="0" y1="0" x2="0" y2="1">
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
                    <Area type="monotone" dataKey="unitsSold" stroke="oklch(0.65 0.18 250)" fill="url(#skuSalesGradient)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Recommendation */}
            <div className="rounded-lg border bg-card p-5">
              <h2 className="text-sm font-semibold mb-2">Recommendation</h2>
              <p className="text-sm text-muted-foreground">{data.recommendation}</p>
            </div>

            {/* Inbound History */}
            {data.inboundHistory.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold mb-3">Inbound Shipments</h2>
                <DataTableShell>
                  <Thead>
                    <tr>
                      <Th>Shipment ID</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Shipped</Th>
                      <Th className="text-right">Received</Th>
                      <Th>Expected</Th>
                    </tr>
                  </Thead>
                  <tbody className="divide-y">
                    {data.inboundHistory.map((s) => (
                      <tr key={s.shipmentId} className="hover:bg-muted/30">
                        <Td className="font-mono text-xs">{s.shipmentId}</Td>
                        <Td>
                          <StatusBadge variant={s.status === "completed" ? "healthy" : "info"}>
                            {s.status}
                          </StatusBadge>
                        </Td>
                        <Td className="text-right">{s.unitsShipped.toLocaleString()}</Td>
                        <Td className="text-right">{s.unitsReceived.toLocaleString()}</Td>
                        <Td className="text-xs text-muted-foreground">
                          {s.expectedArrival ? new Date(s.expectedArrival).toLocaleDateString() : "—"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </DataTableShell>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
