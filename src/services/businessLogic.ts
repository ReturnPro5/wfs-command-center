/**
 * Business Logic Layer
 * Transforms raw API data into domain objects with derived fields.
 * All computation rules are centralized here.
 */

import type {
  InventoryItem,
  InventoryStatus,
  SalesData,
  ReplenishmentItem,
  Alert,
  AlertType,
  DashboardOverview,
} from "@/types/wfs";

// ─── Sales Velocity ─────────────────────────────────────
export function computeVelocity(unitsSold30d: number): number {
  return unitsSold30d / 30;
}

// ─── Weeks of Supply ────────────────────────────────────
export function computeWeeksOfSupply(onHand: number, velocity: number): number {
  if (velocity <= 0) return onHand > 0 ? 999 : 0;
  const weeklySales = velocity * 7;
  return onHand / weeklySales;
}

export function computeDaysOfSupply(onHand: number, velocity: number): number {
  if (velocity <= 0) return onHand > 0 ? 9999 : 0;
  return onHand / velocity;
}

// ─── Inventory Status ───────────────────────────────────
export function determineStatus(
  onHand: number,
  weeksOfSupply: number,
  unitsSold30d: number
): InventoryStatus {
  if (onHand === 0) return "stockout";
  if (unitsSold30d === 0 && onHand > 0) return "no-sales-risk";
  if (weeksOfSupply < 2) return "replenish-immediately";
  if (weeksOfSupply < 4) return "replenish-soon";
  if (weeksOfSupply > 8) return "overstock-risk";
  return "healthy";
}

// ─── Priority from Status ───────────────────────────────
export function statusToPriority(status: InventoryStatus): ReplenishmentItem["priority"] {
  switch (status) {
    case "stockout":
    case "replenish-immediately":
      return "critical";
    case "replenish-soon":
      return "high";
    case "no-sales-risk":
    case "overstock-risk":
      return "medium";
    default:
      return "low";
  }
}

// ─── Recommended Replenishment Qty ──────────────────────
export function computeRecommendedQty(
  velocity: number,
  onHand: number,
  inbound: number,
  targetWeeks: number = 6
): number {
  const targetUnits = velocity * 7 * targetWeeks;
  const needed = targetUnits - onHand - inbound;
  return Math.max(0, Math.ceil(needed));
}

// ─── Action Text ────────────────────────────────────────
export function getActionText(status: InventoryStatus, inbound: number): string {
  switch (status) {
    case "stockout":
      return inbound > 0 ? "Expedite inbound shipment" : "Create urgent inbound shipment";
    case "replenish-immediately":
      return inbound > 0 ? "Monitor inbound arrival" : "Create inbound shipment";
    case "replenish-soon":
      return "Plan replenishment";
    case "overstock-risk":
      return "Review pricing / promotions";
    case "no-sales-risk":
      return "Evaluate listing quality";
    default:
      return "No action needed";
  }
}

// ─── Sales Trend ────────────────────────────────────────
export function determineTrend(
  unitsSold7d: number,
  unitsSold30d: number
): SalesData["trend"] {
  const avg7d = unitsSold7d / 7;
  const avg30d = unitsSold30d / 30;
  if (avg30d === 0) return "stable";
  const ratio = avg7d / avg30d;
  if (ratio > 1.2) return "rising";
  if (ratio < 0.8) return "declining";
  return "stable";
}

// ─── Generate Alerts ────────────────────────────────────
export function generateAlerts(
  inventory: InventoryItem[],
  salesData: SalesData[]
): Alert[] {
  const alerts: Alert[] = [];
  const salesMap = new Map(salesData.map((s) => [s.sku, s]));

  for (const item of inventory) {
    const sales = salesMap.get(item.sku);

    if (item.onHand === 0) {
      alerts.push(makeAlert("stockout", "critical", item, "Stockout — zero units on hand"));
    } else if (item.weeksOfSupply < 1) {
      alerts.push(makeAlert("low-inventory", "critical", item, `Critical low stock — ${item.daysOfSupply.toFixed(0)} days of supply`));
      if (item.inbound === 0) {
        alerts.push(makeAlert("low-inventory", "critical", item, "No inbound shipment for critically low item"));
      }
    } else if (item.weeksOfSupply < 2) {
      alerts.push(makeAlert("low-inventory", "warning", item, `Low stock — ${item.weeksOfSupply.toFixed(1)} weeks of supply`));
    }

    if (item.status === "overstock-risk") {
      alerts.push(makeAlert("overstock", "warning", item, `Overstock risk — ${item.weeksOfSupply.toFixed(1)} weeks of supply`));
    }

    if (sales && sales.unitsSold30d === 0 && item.onHand > 0) {
      alerts.push(makeAlert("no-sales", "warning", item, "No sales in 30 days with inventory on hand"));
    }

    if (sales && sales.trend === "declining") {
      alerts.push(makeAlert("aged-inventory", "info", item, "Sales declining — monitor for aged inventory"));
    }
  }

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return alerts;
}

function makeAlert(
  type: AlertType,
  severity: Alert["severity"],
  item: InventoryItem,
  message: string
): Alert {
  return {
    id: `${type}-${item.sku}-${Date.now()}`,
    type,
    severity,
    sku: item.sku,
    productName: item.productName,
    message,
    createdAt: new Date().toISOString(),
  };
}

// ─── Build Enriched Inventory ───────────────────────────
export function enrichInventoryItem(
  raw: {
    sku: string;
    productName: string;
    onHand: number;
    availableToSell: number;
    reserved: number;
    inbound: number;
    lastUpdated: string;
  },
  unitsSold30d: number
): InventoryItem {
  const velocity = computeVelocity(unitsSold30d);
  const weeksOfSupply = computeWeeksOfSupply(raw.onHand, velocity);
  const daysOfSupply = computeDaysOfSupply(raw.onHand, velocity);
  const status = determineStatus(raw.onHand, weeksOfSupply, unitsSold30d);

  return {
    ...raw,
    daysOfSupply,
    weeksOfSupply,
    status,
  };
}

// ─── Build Replenishment Plan ───────────────────────────
export function buildReplenishmentPlan(
  inventory: InventoryItem[],
  salesData: SalesData[]
): ReplenishmentItem[] {
  const salesMap = new Map(salesData.map((s) => [s.sku, s]));

  return inventory
    .map((item) => {
      const sales = salesMap.get(item.sku);
      const velocity = sales?.velocity ?? 0;
      const recommendedQty = computeRecommendedQty(velocity, item.onHand, item.inbound);
      const priority = statusToPriority(item.status);
      const action = getActionText(item.status, item.inbound);

      return {
        sku: item.sku,
        productName: item.productName,
        onHand: item.onHand,
        velocity,
        weeksOfSupply: item.weeksOfSupply,
        inboundUnits: item.inbound,
        recommendedQty,
        priority,
        action,
      };
    })
    .filter((r) => r.priority !== "low")
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.priority] - order[b.priority];
    });
}

// ─── Status Display Helpers ─────────────────────────────
export function statusLabel(status: InventoryStatus): string {
  const labels: Record<InventoryStatus, string> = {
    "replenish-immediately": "Replenish Immediately",
    "replenish-soon": "Replenish Soon",
    healthy: "Healthy",
    "overstock-risk": "Overstock Risk",
    "no-sales-risk": "No Sales Risk",
    stockout: "Stockout",
  };
  return labels[status];
}

export function statusVariant(
  status: InventoryStatus
): "healthy" | "warning" | "critical" | "info" {
  switch (status) {
    case "healthy":
      return "healthy";
    case "replenish-soon":
    case "overstock-risk":
    case "no-sales-risk":
      return "warning";
    case "replenish-immediately":
    case "stockout":
      return "critical";
    default:
      return "info";
  }
}

export function priorityVariant(
  priority: ReplenishmentItem["priority"]
): "healthy" | "warning" | "critical" | "info" {
  switch (priority) {
    case "critical":
      return "critical";
    case "high":
      return "warning";
    case "medium":
      return "info";
    default:
      return "healthy";
  }
}
