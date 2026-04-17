// WFS Domain Types

export interface InventoryItem {
  sku: string;
  productName: string;
  onHand: number;
  availableToSell: number;
  reserved: number;
  inbound: number;
  lastUpdated: string;
  // Derived
  daysOfSupply: number;
  weeksOfSupply: number;
  status: InventoryStatus;
}

export type InventoryStatus =
  | "replenish-immediately"
  | "replenish-soon"
  | "healthy"
  | "overstock-risk"
  | "no-sales-risk"
  | "stockout";

export interface SalesData {
  sku: string;
  productName: string;
  unitsSold7d: number;
  unitsSold30d: number;
  revenue7d: number;
  revenue30d: number;
  velocity: number; // units/day
  trend: "rising" | "stable" | "declining";
}

export interface SalesTrend {
  date: string;
  unitsSold: number;
  revenue: number;
}

export interface ReplenishmentItem {
  sku: string;
  productName: string;
  onHand: number;
  velocity: number;
  weeksOfSupply: number;
  inboundUnits: number;
  recommendedQty: number;
  priority: "critical" | "high" | "medium" | "low";
  action: string;
}

export interface InboundShipment {
  shipmentId: string;
  status: "created" | "in-transit" | "delivered" | "receiving" | "completed" | "cancelled";
  unitsShipped: number;
  unitsReceived: number;
  expectedArrival: string;
  discrepancy: number;
  skus: string[];
}

export interface Alert {
  id: string;
  type: AlertType;
  severity: "critical" | "warning" | "info";
  sku?: string;
  productName?: string;
  message: string;
  createdAt: string;
}

export type AlertType =
  | "stockout"
  | "low-inventory"
  | "no-sales"
  | "aged-inventory"
  | "inbound-delay"
  | "not-sellable"
  | "overstock"
  | "system";

export interface SkuDetail {
  sku: string;
  productName: string;
  inventory: InventoryItem;
  salesHistory: SalesTrend[];
  velocity: number;
  inboundHistory: InboundShipment[];
  status: InventoryStatus;
  recommendation: string;
}

export interface DashboardOverview {
  totalWfsInventory: number;
  wfsCatalogSkuCount: number;
  activeSkuCount: number;
  salesYesterday: number;
  salesLast7Days: number;
  salesMTD: number;
  inboundUnits: number;
  lowStockCount: number;
  overstockCount: number;
  agedInventoryCount: number;
}

export interface ApiError {
  message: string;
  statusCode?: number;
}
