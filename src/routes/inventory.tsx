import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { SearchFilter } from "@/components/SearchFilter";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateDisplays";
import { getInventoryHealth } from "@/services/wfs.functions";
import { statusLabel, statusVariant } from "@/services/businessLogic";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { InventoryItem, InventoryStatus } from "@/types/wfs";

export const Route = createFileRoute("/inventory")({
  component: InventoryPage,
  head: () => ({
    meta: [
      { title: "Inventory Health — WFS Operations" },
      { name: "description", content: "WFS inventory health monitoring" },
    ],
  }),
});

const statusOptions: InventoryStatus[] = [
  "stockout",
  "replenish-immediately",
  "replenish-soon",
  "healthy",
  "overstock-risk",
  "no-sales-risk",
];

function InventoryPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<InventoryStatus | "all">("all");

  const { data, isLoading, isError, error, refetch } = useQuery<InventoryItem[]>({
    queryKey: ["inventory-health"],
    queryFn: () => getInventoryHealth(),
    retry: 1,
  });

  const filtered = data?.filter((item) => {
    const matchesSearch =
      !search ||
      item.sku.toLowerCase().includes(search.toLowerCase()) ||
      item.productName.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || item.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inventory Health</h1>
          <p className="text-sm text-muted-foreground mt-1">Monitor inventory levels and supply status</p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:w-72">
            <SearchFilter value={search} onChange={setSearch} />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="rounded-md border bg-secondary px-3 py-2 text-sm text-foreground"
          >
            <option value="all">All Statuses</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
        </div>

        {isLoading && <LoadingState message="Loading inventory..." />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {filtered && filtered.length === 0 && <EmptyState message="No inventory items match your filters" />}

        {filtered && filtered.length > 0 && (
          <DataTableShell>
            <Thead>
              <tr>
                <Th>SKU</Th>
                <Th>Product</Th>
                <Th className="text-right">On Hand</Th>
                <Th className="text-right">Available</Th>
                <Th className="text-right">Reserved</Th>
                <Th className="text-right">Inbound</Th>
                <Th className="text-right">Days of Supply</Th>
                <Th className="text-right">Weeks of Supply</Th>
                <Th>Status</Th>
                <Th>Last Updated</Th>
              </tr>
            </Thead>
            <tbody className="divide-y">
              {filtered.map((item) => (
                <tr key={item.sku} className="hover:bg-muted/30 transition-colors">
                  <Td>
                    <a href={`/sku/${item.sku}`} className="font-mono text-xs text-primary hover:underline">
                      {item.sku}
                    </a>
                  </Td>
                  <Td className="max-w-[200px] truncate">{item.productName}</Td>
                  <Td className="text-right font-medium">{item.onHand.toLocaleString()}</Td>
                  <Td className="text-right">{item.availableToSell.toLocaleString()}</Td>
                  <Td className="text-right">{item.reserved.toLocaleString()}</Td>
                  <Td className="text-right">{item.inbound.toLocaleString()}</Td>
                  <Td className="text-right">{item.daysOfSupply > 999 ? "999+" : item.daysOfSupply.toFixed(0)}</Td>
                  <Td className="text-right">{item.weeksOfSupply > 99 ? "99+" : item.weeksOfSupply.toFixed(1)}</Td>
                  <Td>
                    <StatusBadge variant={statusVariant(item.status)}>
                      {statusLabel(item.status)}
                    </StatusBadge>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {new Date(item.lastUpdated).toLocaleDateString()}
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
