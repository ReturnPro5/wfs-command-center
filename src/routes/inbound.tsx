import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateDisplays";
import { getInboundShipmentsList } from "@/services/wfs.functions";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { InboundShipment } from "@/types/wfs";

export const Route = createFileRoute("/inbound")({
  component: InboundPage,
  head: () => ({
    meta: [
      { title: "Inbound Shipments — WFS Operations" },
      { name: "description", content: "Track WFS inbound shipments" },
    ],
  }),
});

function shipmentStatusVariant(status: string): "healthy" | "warning" | "critical" | "info" {
  switch (status) {
    case "completed":
      return "healthy";
    case "delivered":
    case "receiving":
      return "info";
    case "in-transit":
    case "created":
      return "warning";
    case "cancelled":
      return "critical";
    default:
      return "info";
  }
}

function InboundPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading, isError, error, refetch } = useQuery<InboundShipment[]>({
    queryKey: ["inbound-shipments"],
    queryFn: () => getInboundShipmentsList(),
    retry: 1,
  });

  const filtered = data?.filter(
    (s) => statusFilter === "all" || s.status === statusFilter
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inbound Shipments</h1>
          <p className="text-sm text-muted-foreground mt-1">Track shipments into WFS fulfillment centers</p>
        </div>

        <div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border bg-secondary px-3 py-2 text-sm text-foreground"
          >
            <option value="all">All Statuses</option>
            <option value="created">Created</option>
            <option value="in-transit">In Transit</option>
            <option value="delivered">Delivered</option>
            <option value="receiving">Receiving</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {isLoading && <LoadingState message="Loading shipments..." />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {filtered && filtered.length === 0 && <EmptyState message="No shipments match your filter" />}

        {filtered && filtered.length > 0 && (
          <DataTableShell>
            <Thead>
              <tr>
                <Th>Shipment ID</Th>
                <Th>Status</Th>
                <Th className="text-right">Units Shipped</Th>
                <Th className="text-right">Units Received</Th>
                <Th className="text-right">Discrepancy</Th>
                <Th>Expected Arrival</Th>
                <Th>SKUs</Th>
              </tr>
            </Thead>
            <tbody className="divide-y">
              {filtered.map((shipment) => (
                <tr key={shipment.shipmentId} className="hover:bg-muted/30 transition-colors">
                  <Td className="font-mono text-xs">{shipment.shipmentId}</Td>
                  <Td>
                    <StatusBadge variant={shipmentStatusVariant(shipment.status)}>
                      {shipment.status}
                    </StatusBadge>
                  </Td>
                  <Td className="text-right">{shipment.unitsShipped.toLocaleString()}</Td>
                  <Td className="text-right">{shipment.unitsReceived.toLocaleString()}</Td>
                  <Td className="text-right">
                    {shipment.discrepancy !== 0 ? (
                      <span className="text-status-critical font-medium">{shipment.discrepancy}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {shipment.expectedArrival ? new Date(shipment.expectedArrival).toLocaleDateString() : "—"}
                  </Td>
                  <Td className="text-xs text-muted-foreground max-w-[150px] truncate">
                    {shipment.skus.length} SKU{shipment.skus.length !== 1 ? "s" : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTableShell>
        )}
      </div>
    </DashboardLayout>
  );
}
