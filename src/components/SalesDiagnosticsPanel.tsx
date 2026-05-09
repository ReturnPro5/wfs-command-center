import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getSalesDiagnostics, type SalesDiagnostics, type SalesDiagnosticReason } from "@/services/wfs.functions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

const REASON_LABELS: Record<SalesDiagnosticReason, string> = {
  "included": "Included in metrics",
  "excluded:order-seller-fulfilled": "Excluded — order is seller-fulfilled",
  "excluded:line-seller-fulfilled": "Excluded — line is seller-fulfilled",
  "excluded:zero-or-cancelled-qty": "Excluded — zero or fully-cancelled qty",
  "excluded:missing-sku": "Excluded — missing SKU",
};

const REASON_ORDER: SalesDiagnosticReason[] = [
  "included",
  "excluded:order-seller-fulfilled",
  "excluded:line-seller-fulfilled",
  "excluded:zero-or-cancelled-qty",
  "excluded:missing-sku",
];

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

export function SalesDiagnosticsPanel() {
  const [expanded, setExpanded] = useState<Record<SalesDiagnosticReason, boolean>>({
    "included": false,
    "excluded:order-seller-fulfilled": true,
    "excluded:line-seller-fulfilled": true,
    "excluded:zero-or-cancelled-qty": false,
    "excluded:missing-sku": false,
  });

  const q = useQuery<SalesDiagnostics>({
    queryKey: ["sales-diagnostics"],
    queryFn: () => getSalesDiagnostics(),
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  const toggle = (r: SalesDiagnosticReason) =>
    setExpanded((prev) => ({ ...prev, [r]: !prev[r] }));

  const totalExcluded = q.data
    ? REASON_ORDER.filter((r) => r !== "included").reduce((s, r) => s + q.data!.counts[r], 0)
    : 0;

  return (
    <section className="rounded-lg border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold">Sales troubleshooting</h2>
          <p className="text-xs text-muted-foreground">
            Why each YTD order line was included or excluded from your dashboard metrics.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <div className="p-5 space-y-4">
        {q.isLoading && <Skeleton className="h-32 w-full" />}
        {q.isError && (
          <div className="text-sm text-destructive">
            Failed to load diagnostics: {(q.error as Error).message}
          </div>
        )}

        {q.data && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Orders fetched" value={q.data.totalOrdersFetched.toLocaleString()} />
              <Stat label="Lines seen" value={q.data.totalLinesSeen.toLocaleString()} />
              <Stat
                label="Included units"
                value={q.data.unitsIncluded.toLocaleString()}
                tone="healthy"
              />
              <Stat
                label="Excluded lines"
                value={totalExcluded.toLocaleString()}
                tone={totalExcluded > 0 ? "warning" : "healthy"}
              />
            </div>

            <div className="rounded-md border bg-background/40 p-3 text-xs">
              <div className="flex items-start gap-2 text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-status-warning shrink-0" />
                <span>
                  Window: <span className="font-mono text-foreground">{q.data.windowStart.slice(0, 10)}</span> → today.
                  Included revenue: <span className="font-medium text-foreground">{usd(q.data.revenueIncluded)}</span>.
                  If "Excluded" buckets contain WFS lines that should be counted, adjust the
                  filter rules in <code>parseOrdersResponse</code>.
                </span>
              </div>
            </div>

            <div className="space-y-2">
              {REASON_ORDER.map((reason) => {
                const count = q.data!.counts[reason];
                const isOpen = expanded[reason];
                const samples = q.data!.samples[reason];
                const isIncluded = reason === "included";

                return (
                  <div key={reason} className="rounded-md border">
                    <button
                      type="button"
                      onClick={() => toggle(reason)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40"
                    >
                      <span className="flex items-center gap-2 text-sm">
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {isIncluded ? (
                          <CheckCircle2 className="h-4 w-4 text-status-healthy" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-status-warning" />
                        )}
                        <span className="font-medium">{REASON_LABELS[reason]}</span>
                      </span>
                      <StatusBadge variant={isIncluded ? "healthy" : count > 0 ? "warning" : "info"}>
                        {count.toLocaleString()} {count === 1 ? "line" : "lines"}
                      </StatusBadge>
                    </button>

                    {isOpen && (
                      <div className="border-t">
                        {samples.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-muted-foreground">No lines in this bucket.</p>
                        ) : (
                          <div className="max-h-80 overflow-auto">
                            <table className="w-full text-xs">
                              <thead className="sticky top-0 bg-muted/70 text-[10px] uppercase tracking-wider text-muted-foreground">
                                <tr>
                                  <th className="px-3 py-1.5 text-left">Date</th>
                                  <th className="px-3 py-1.5 text-left">PO</th>
                                  <th className="px-3 py-1.5 text-left">Line</th>
                                  <th className="px-3 py-1.5 text-left">SKU</th>
                                  <th className="px-3 py-1.5 text-right">Qty</th>
                                  <th className="px-3 py-1.5 text-right">Rev</th>
                                  <th className="px-3 py-1.5 text-left">Order shipNode</th>
                                  <th className="px-3 py-1.5 text-left">Line fulfillment</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y">
                                {samples.map((s, i) => (
                                  <tr key={`${s.purchaseOrderId}-${s.lineNumber}-${i}`} className="hover:bg-muted/30">
                                    <td className="px-3 py-1.5 whitespace-nowrap">{s.date || "—"}</td>
                                    <td className="px-3 py-1.5 font-mono">{s.purchaseOrderId}</td>
                                    <td className="px-3 py-1.5 font-mono">{s.lineNumber}</td>
                                    <td className="px-3 py-1.5 font-mono">{s.sku || "—"}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{s.qty}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{usd(s.revenue)}</td>
                                    <td className="px-3 py-1.5 font-mono text-[10px] max-w-xs truncate" title={JSON.stringify(s.orderShipNode)}>
                                      {s.orderShipNode ? JSON.stringify(s.orderShipNode) : "—"}
                                    </td>
                                    <td className="px-3 py-1.5 font-mono text-[10px] max-w-xs truncate" title={JSON.stringify(s.lineFulfillment)}>
                                      {s.lineFulfillment ? JSON.stringify(s.lineFulfillment) : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {count > samples.length && (
                              <p className="bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                                Showing first {samples.length} of {count.toLocaleString()}.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "healthy" | "warning";
}) {
  return (
    <div className="rounded-md border bg-background/60 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "healthy" && "text-status-healthy",
          tone === "warning" && "text-status-warning"
        )}
      >
        {value}
      </p>
    </div>
  );
}
