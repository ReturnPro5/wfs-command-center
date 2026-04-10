import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/DashboardLayout";
import { StatusBadge } from "@/components/StatusBadge";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateDisplays";
import { getAlerts } from "@/services/wfs.functions";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Alert } from "@/types/wfs";
import {
  AlertTriangle,
  PackageX,
  TrendingDown,
  Clock,
  Package,
  Truck,
  Ban,
  Archive,
} from "lucide-react";

export const Route = createFileRoute("/alerts")({
  component: AlertsPage,
  head: () => ({
    meta: [
      { title: "Exceptions & Alerts — WFS Operations" },
      { name: "description", content: "WFS operational alerts and exceptions" },
    ],
  }),
});

const alertIcons: Record<string, typeof AlertTriangle> = {
  stockout: PackageX,
  "low-inventory": Package,
  "no-sales": TrendingDown,
  "aged-inventory": Clock,
  "inbound-delay": Truck,
  "not-sellable": Ban,
  overstock: Archive,
};

function AlertsPage() {
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const { data, isLoading, isError, error, refetch } = useQuery<Alert[]>({
    queryKey: ["alerts"],
    queryFn: () => getAlerts(),
    retry: 1,
  });

  const filtered = data?.filter(
    (a) => severityFilter === "all" || a.severity === severityFilter
  );

  const counts = data
    ? {
        critical: data.filter((a) => a.severity === "critical").length,
        warning: data.filter((a) => a.severity === "warning").length,
        info: data.filter((a) => a.severity === "info").length,
      }
    : null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Exceptions & Alerts</h1>
          <p className="text-sm text-muted-foreground mt-1">Automatically detected inventory issues</p>
        </div>

        {isLoading && <LoadingState message="Scanning for issues..." />}
        {isError && <ErrorState message={error.message} onRetry={() => refetch()} />}

        {data && counts && (
          <>
            <div className="flex items-center gap-3">
              <StatusBadge variant="critical">{counts.critical} Critical</StatusBadge>
              <StatusBadge variant="warning">{counts.warning} Warning</StatusBadge>
              <StatusBadge variant="info">{counts.info} Info</StatusBadge>

              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="ml-auto rounded-md border bg-secondary px-3 py-2 text-sm text-foreground"
              >
                <option value="all">All Severities</option>
                <option value="critical">Critical Only</option>
                <option value="warning">Warning Only</option>
                <option value="info">Info Only</option>
              </select>
            </div>

            {filtered && filtered.length === 0 && <EmptyState message="No alerts match your filter" />}

            {filtered && filtered.length > 0 && (
              <div className="space-y-2">
                {filtered.map((alert) => {
                  const Icon = alertIcons[alert.type] ?? AlertTriangle;
                  return (
                    <div
                      key={alert.id}
                      className="flex items-start gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
                    >
                      <div
                        className={
                          alert.severity === "critical"
                            ? "rounded-md bg-status-critical/10 p-2 text-status-critical"
                            : alert.severity === "warning"
                            ? "rounded-md bg-status-warning/10 p-2 text-status-warning"
                            : "rounded-md bg-status-info/10 p-2 text-status-info"
                        }
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusBadge
                            variant={
                              alert.severity === "critical"
                                ? "critical"
                                : alert.severity === "warning"
                                ? "warning"
                                : "info"
                            }
                          >
                            {alert.severity}
                          </StatusBadge>
                          <span className="text-xs text-muted-foreground uppercase">{alert.type.replace("-", " ")}</span>
                        </div>
                        <p className="mt-1 text-sm font-medium">{alert.message}</p>
                        {alert.sku && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            <a href={`/sku/${alert.sku}`} className="text-primary hover:underline">
                              {alert.sku}
                            </a>
                            {alert.productName && ` — ${alert.productName}`}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
