import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { DataTableShell, Thead, Th, Td } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { SearchFilter } from "@/components/SearchFilter";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateDisplays";
import { getReplenishmentPlan } from "@/services/wfs.functions";
import { priorityVariant } from "@/services/businessLogic";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReplenishmentItem } from "@/types/wfs";

export const Route = createFileRoute("/replenishment")({
  component: ReplenishmentPage,
  head: () => ({
    meta: [
      { title: "Replenishment Planner — WFS Operations" },
      { name: "description", content: "WFS inventory replenishment planning" },
    ],
  }),
});

function ReplenishmentPage() {
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");

  const { data, isLoading, isError, error, refetch } = useQuery<ReplenishmentItem[]>({
    queryKey: ["replenishment"],
    queryFn: () => getReplenishmentPlan(),
    retry: 1,
  });

  const filtered = data?.filter((item) => {
    const matchesSearch =
      !search ||
      item.sku.toLowerCase().includes(search.toLowerCase()) ||
      item.productName.toLowerCase().includes(search.toLowerCase());
    const matchesPriority = priorityFilter === "all" || item.priority === priorityFilter;
    return matchesSearch && matchesPriority;
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Replenishment Planner</h1>
          <p className="text-sm text-muted-foreground mt-1">Prioritized replenishment recommendations</p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:w-72">
            <SearchFilter value={search} onChange={setSearch} />
          </div>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="rounded-md border bg-secondary px-3 py-2 text-sm text-foreground"
          >
            <option value="all">All Priorities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
          </select>
        </div>

        {isLoading && <LoadingState message="Building replenishment plan..." />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {filtered && filtered.length === 0 && <EmptyState message="No replenishment needed — all items healthy" />}

        {filtered && filtered.length > 0 && (
          <DataTableShell>
            <Thead>
              <tr>
                <Th>SKU</Th>
                <Th>Product</Th>
                <Th className="text-right">On Hand</Th>
                <Th className="text-right">Velocity</Th>
                <Th className="text-right">Weeks of Supply</Th>
                <Th className="text-right">Inbound</Th>
                <Th className="text-right">Recommended Qty</Th>
                <Th>Priority</Th>
                <Th>Action</Th>
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
                  <Td className="text-right font-mono">{item.velocity.toFixed(1)}/day</Td>
                  <Td className="text-right">{item.weeksOfSupply > 99 ? "99+" : item.weeksOfSupply.toFixed(1)}</Td>
                  <Td className="text-right">{item.inboundUnits.toLocaleString()}</Td>
                  <Td className="text-right font-semibold">{item.recommendedQty.toLocaleString()}</Td>
                  <Td>
                    <StatusBadge variant={priorityVariant(item.priority)}>
                      {item.priority}
                    </StatusBadge>
                  </Td>
                  <Td className="text-xs text-muted-foreground max-w-[180px] truncate">{item.action}</Td>
                </tr>
              ))}
            </tbody>
          </DataTableShell>
        )}
      </div>
    </DashboardLayout>
  );
}
