/**
 * Server functions for WFS dashboard data.
 * All Walmart API calls happen here, server-side only.
 */

import { createServerFn } from "@tanstack/react-start";
import * as walmartApi from "@/services/walmartApi";
import * as biz from "@/services/businessLogic";
import type {
  DashboardOverview,
  InventoryItem,
  SalesData,
  SalesTrend,
  ReplenishmentItem,
  InboundShipment,
  Alert,
  SkuDetail,
} from "@/types/wfs";

// ─── Overview ───────────────────────────────────────────
export const getOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardOverview> => {
    try {
      const [inventoryData, ordersData, inboundData] = await Promise.all([
        walmartApi.getWfsInventory(),
        walmartApi.getOrders({
          createdStartDate: thirtyDaysAgo(),
        }),
        walmartApi.getInboundShipments(),
      ]);

      const inventory = parseInventoryResponse(inventoryData);
      const orders = parseOrdersResponse(ordersData);
      const salesByDay = aggregateOrdersByDay(orders);
      const salesBySku = aggregateOrdersBySku(orders);

      const enriched = inventory.map((item) => {
        const skuSales = salesBySku.get(item.sku);
        return biz.enrichInventoryItem(item, skuSales?.unitsSold30d ?? 0);
      });

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      return {
        totalWfsInventory: enriched.reduce((sum, i) => sum + i.onHand, 0),
        salesYesterday: salesByDay.get(yesterdayStr) ?? 0,
        salesLast7Days: computeSalesRange(salesByDay, 7),
        salesMTD: computeSalesMTD(salesByDay),
        inboundUnits: enriched.reduce((sum, i) => sum + i.inbound, 0),
        lowStockCount: enriched.filter(
          (i) => i.status === "replenish-immediately" || i.status === "replenish-soon"
        ).length,
        overstockCount: enriched.filter((i) => i.status === "overstock-risk").length,
        agedInventoryCount: enriched.filter((i) => i.status === "no-sales-risk").length,
      };
    } catch (error) {
      console.error("Failed to fetch overview:", error);
      throw new Error(
        `Failed to load dashboard overview: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ─── Inventory ──────────────────────────────────────────
export const getInventoryHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<InventoryItem[]> => {
    try {
      const [inventoryData, ordersData] = await Promise.all([
        walmartApi.getWfsInventory(),
        walmartApi.getOrders({ createdStartDate: thirtyDaysAgo() }),
      ]);

      const inventory = parseInventoryResponse(inventoryData);
      const salesBySku = aggregateOrdersBySku(parseOrdersResponse(ordersData));

      return inventory.map((item) => {
        const skuSales = salesBySku.get(item.sku);
        return biz.enrichInventoryItem(item, skuSales?.unitsSold30d ?? 0);
      });
    } catch (error) {
      console.error("Failed to fetch inventory:", error);
      throw new Error(
        `Failed to load inventory: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ─── Sales ──────────────────────────────────────────────
export const getSalesVelocity = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ salesData: SalesData[]; trends: SalesTrend[] }> => {
    try {
      const ordersData = await walmartApi.getOrders({
        createdStartDate: thirtyDaysAgo(),
      });

      const orders = parseOrdersResponse(ordersData);
      const salesBySku = aggregateOrdersBySku(orders);
      const dailyTrends = aggregateDailyTrends(orders);

      const salesData: SalesData[] = Array.from(salesBySku.values()).map((s) => ({
        ...s,
        velocity: biz.computeVelocity(s.unitsSold30d),
        trend: biz.determineTrend(s.unitsSold7d, s.unitsSold30d),
      }));

      return { salesData, trends: dailyTrends };
    } catch (error) {
      console.error("Failed to fetch sales:", error);
      throw new Error(
        `Failed to load sales data: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ─── Replenishment ──────────────────────────────────────
export const getReplenishmentPlan = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReplenishmentItem[]> => {
    try {
      const [inventoryData, ordersData] = await Promise.all([
        walmartApi.getWfsInventory(),
        walmartApi.getOrders({ createdStartDate: thirtyDaysAgo() }),
      ]);

      const inventory = parseInventoryResponse(inventoryData);
      const orders = parseOrdersResponse(ordersData);
      const salesBySku = aggregateOrdersBySku(orders);

      const enriched = inventory.map((item) => {
        const skuSales = salesBySku.get(item.sku);
        return biz.enrichInventoryItem(item, skuSales?.unitsSold30d ?? 0);
      });

      const salesData: SalesData[] = Array.from(salesBySku.values()).map((s) => ({
        ...s,
        velocity: biz.computeVelocity(s.unitsSold30d),
        trend: biz.determineTrend(s.unitsSold7d, s.unitsSold30d),
      }));

      return biz.buildReplenishmentPlan(enriched, salesData);
    } catch (error) {
      console.error("Failed to build replenishment plan:", error);
      throw new Error(
        `Failed to load replenishment plan: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ─── Inbound Shipments ──────────────────────────────────
export const getInboundShipmentsList = createServerFn({ method: "GET" }).handler(
  async (): Promise<InboundShipment[]> => {
    try {
      const data = await walmartApi.getInboundShipments();
      return parseInboundResponse(data);
    } catch (error) {
      console.error("Failed to fetch inbound shipments:", error);
      throw new Error(
        `Failed to load inbound shipments: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ─── Alerts ─────────────────────────────────────────────
export const getAlerts = createServerFn({ method: "GET" }).handler(
  async (): Promise<Alert[]> => {
    try {
      const [inventoryData, ordersData] = await Promise.all([
        walmartApi.getWfsInventory(),
        walmartApi.getOrders({ createdStartDate: thirtyDaysAgo() }),
      ]);

      const inventory = parseInventoryResponse(inventoryData);
      const orders = parseOrdersResponse(ordersData);
      const salesBySku = aggregateOrdersBySku(orders);

      const enriched = inventory.map((item) => {
        const skuSales = salesBySku.get(item.sku);
        return biz.enrichInventoryItem(item, skuSales?.unitsSold30d ?? 0);
      });

      const salesData: SalesData[] = Array.from(salesBySku.values()).map((s) => ({
        ...s,
        velocity: biz.computeVelocity(s.unitsSold30d),
        trend: biz.determineTrend(s.unitsSold7d, s.unitsSold30d),
      }));

      return biz.generateAlerts(enriched, salesData);
    } catch (error) {
      console.error("Failed to generate alerts:", error);
      throw new Error(
        `Failed to load alerts: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ─── SKU Detail ─────────────────────────────────────────
export const getSkuDetail = createServerFn({ method: "POST" })
  .inputValidator((data: { sku: string }) => data)
  .handler(async ({ data }): Promise<SkuDetail> => {
    try {
      const { sku } = data;
      const [inventoryData, ordersData, inboundData] = await Promise.all([
        walmartApi.getInventoryForSku(sku),
        walmartApi.getOrders({ createdStartDate: thirtyDaysAgo() }),
        walmartApi.getInboundShipments(),
      ]);

      const rawInventory = parseInventoryResponse(inventoryData);
      const rawItem = rawInventory.find((i) => i.sku === sku);

      if (!rawItem) {
        throw new Error(`SKU ${sku} not found`);
      }

      const orders = parseOrdersResponse(ordersData);
      const skuOrders = orders.filter((o) => o.sku === sku);
      const unitsSold30d = skuOrders.reduce((sum, o) => sum + o.qty, 0);
      const velocity = biz.computeVelocity(unitsSold30d);

      const enriched = biz.enrichInventoryItem(rawItem, unitsSold30d);
      const salesHistory = aggregateDailyTrends(skuOrders);
      const inboundShipments = parseInboundResponse(inboundData).filter((s) =>
        s.skus.includes(sku)
      );

      const recommendation = biz.getActionText(enriched.status, enriched.inbound);

      return {
        sku,
        productName: enriched.productName,
        inventory: enriched,
        salesHistory,
        velocity,
        inboundHistory: inboundShipments,
        status: enriched.status,
        recommendation,
      };
    } catch (error) {
      console.error(`Failed to fetch SKU detail for ${data.sku}:`, error);
      throw new Error(
        `Failed to load SKU detail: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  });

// ─── Helpers ────────────────────────────────────────────

function thirtyDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

interface RawOrder {
  sku: string;
  productName: string;
  qty: number;
  revenue: number;
  date: string;
}

function parseInventoryResponse(data: any): Array<{
  sku: string;
  productName: string;
  onHand: number;
  availableToSell: number;
  reserved: number;
  inbound: number;
  lastUpdated: string;
}> {
  // Adapt based on actual Walmart API response structure
  const items = data?.inventory?.elements ?? data?.elements ?? data?.items ?? [];
  return items.map((item: any) => ({
    sku: item.sku ?? item.SKU ?? "",
    productName: item.productName ?? item.product_name ?? item.sku ?? "",
    onHand: item.quantity?.amount ?? item.onHand ?? item.qty ?? 0,
    availableToSell: item.availableToSellQty ?? item.available ?? item.quantity?.amount ?? 0,
    reserved: item.reservedQty ?? item.reserved ?? 0,
    inbound: item.inboundQty ?? item.inbound ?? 0,
    lastUpdated: item.lastUpdatedTs ?? item.lastUpdated ?? new Date().toISOString(),
  }));
}

function parseOrdersResponse(data: any): RawOrder[] {
  const orderList = data?.list?.elements?.order ?? data?.orders ?? data?.elements ?? [];
  const result: RawOrder[] = [];

  for (const order of orderList) {
    const lines = order.orderLines?.orderLine ?? order.lines ?? [];
    const orderDate = order.orderDate ?? order.createdDate ?? "";

    for (const line of lines) {
      result.push({
        sku: line.item?.sku ?? line.sku ?? "",
        productName: line.item?.productName ?? line.productName ?? "",
        qty: line.orderLineQuantity?.amount ?? line.quantity ?? 1,
        revenue:
          (line.charges?.charge?.[0]?.chargeAmount?.amount ?? line.price ?? 0) *
          (line.orderLineQuantity?.amount ?? line.quantity ?? 1),
        date: orderDate.slice(0, 10),
      });
    }
  }

  return result;
}

function parseInboundResponse(data: any): InboundShipment[] {
  const shipments = data?.shipments ?? data?.elements ?? [];
  return shipments.map((s: any) => ({
    shipmentId: s.shipmentId ?? s.id ?? "",
    status: s.status?.toLowerCase() ?? "created",
    unitsShipped: s.totalUnitsShipped ?? s.unitsShipped ?? 0,
    unitsReceived: s.totalUnitsReceived ?? s.unitsReceived ?? 0,
    expectedArrival: s.expectedDeliveryDate ?? s.expectedArrival ?? "",
    discrepancy: (s.totalUnitsShipped ?? 0) - (s.totalUnitsReceived ?? 0),
    skus: (s.items ?? s.orderItems ?? []).map((i: any) => i.sku ?? ""),
  }));
}

function aggregateOrdersBySku(
  orders: RawOrder[]
): Map<string, { sku: string; productName: string; unitsSold7d: number; unitsSold30d: number; revenue7d: number; revenue30d: number }> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDayStr = sevenDaysAgo.toISOString().slice(0, 10);

  const map = new Map<string, any>();

  for (const o of orders) {
    const existing = map.get(o.sku) ?? {
      sku: o.sku,
      productName: o.productName,
      unitsSold7d: 0,
      unitsSold30d: 0,
      revenue7d: 0,
      revenue30d: 0,
    };

    existing.unitsSold30d += o.qty;
    existing.revenue30d += o.revenue;

    if (o.date >= sevenDayStr) {
      existing.unitsSold7d += o.qty;
      existing.revenue7d += o.revenue;
    }

    map.set(o.sku, existing);
  }

  return map;
}

function aggregateOrdersByDay(orders: RawOrder[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of orders) {
    map.set(o.date, (map.get(o.date) ?? 0) + o.qty);
  }
  return map;
}

function computeSalesRange(salesByDay: Map<string, number>, days: number): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let total = 0;
  for (const [date, units] of salesByDay) {
    if (date >= cutoffStr) total += units;
  }
  return total;
}

function computeSalesMTD(salesByDay: Map<string, number>): number {
  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  let total = 0;
  for (const [date, units] of salesByDay) {
    if (date >= monthStart) total += units;
  }
  return total;
}

function aggregateDailyTrends(orders: RawOrder[]): SalesTrend[] {
  const map = new Map<string, { unitsSold: number; revenue: number }>();
  for (const o of orders) {
    const existing = map.get(o.date) ?? { unitsSold: 0, revenue: 0 };
    existing.unitsSold += o.qty;
    existing.revenue += o.revenue;
    map.set(o.date, existing);
  }
  return Array.from(map.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
