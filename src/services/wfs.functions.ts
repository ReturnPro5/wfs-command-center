/**
 * Server functions for WFS dashboard data.
 * All Walmart API calls happen here, server-side only.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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
      console.log("[WFS:getOverview] Starting...");
      const { inventory, orders, inventoryUnavailable, inventoryError } = await loadInventoryAndOrders("dashboard overview");

      if (inventoryUnavailable) {
        throw new Error(formatInventoryError(inventoryError));
      }

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
      // wfsCatalogSkuCount = total SKUs enrolled in WFS (all items from /v3/fulfillment/inventory)
      wfsCatalogSkuCount: inventory.length,
      // activeSkuCount = SKUs with at least 1 unit on-hand at WFS
      activeSkuCount: enriched.filter((i) => i.onHand > 0).length,
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
    } catch (err) {
      console.error("[WFS:getOverview] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
  }
);

// ─── Inventory ──────────────────────────────────────────
export const getInventoryHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<InventoryItem[]> => {
    const { inventory, orders } = await loadInventoryAndOrders("inventory");
    const salesBySku = aggregateOrdersBySku(orders);

    return inventory.map((item) => {
      const skuSales = salesBySku.get(item.sku);
      return biz.enrichInventoryItem(item, skuSales?.unitsSold30d ?? 0);
    });
  }
);

// ─── Sales ──────────────────────────────────────────────
export const getSalesVelocity = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ salesData: SalesData[]; trends: SalesTrend[] }> => {
    let orders: Awaited<ReturnType<typeof fetchAllOrders>> = [];
    try {
      orders = await fetchAllOrders(daysAgo(30));
    } catch (err) {
      if (isRecoverableWalmartError(err)) {
        console.warn("[WFS] sales velocity: orders temporarily unavailable, using empty fallback.", (err as Error).message);
      } else {
        throw err;
      }
    }
    const salesBySku = aggregateOrdersBySku(orders);
    const dailyTrends = aggregateDailyTrends(orders);

    const salesData: SalesData[] = Array.from(salesBySku.values()).map((s) => ({
      ...s,
      velocity: biz.computeVelocity(s.unitsSold30d),
      trend: biz.determineTrend(s.unitsSold7d, s.unitsSold30d),
    }));

    return { salesData, trends: dailyTrends };
  }
);

// ─── Replenishment ──────────────────────────────────────
export const getReplenishmentPlan = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReplenishmentItem[]> => {
    const { inventory, orders } = await loadInventoryAndOrders("replenishment plan");
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
  }
);

// ─── Inbound Shipments ──────────────────────────────────
export const getInboundShipmentsList = createServerFn({ method: "GET" }).handler(
  async (): Promise<InboundShipment[]> => {
    const data = await walmartApi.getInboundShipments();
    return parseInboundResponse(data);
  }
);

// ─── Alerts ─────────────────────────────────────────────
export const getAlerts = createServerFn({ method: "GET" }).handler(
  async (): Promise<Alert[]> => {
    const { inventory, orders, inventoryUnavailable, inventoryError } = await loadInventoryAndOrders("alerts");
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

    const alerts = biz.generateAlerts(enriched, salesData);

    if (inventoryUnavailable) {
      return [
        makeSystemAlert(formatInventoryError(inventoryError)),
        ...alerts,
      ];
    }

    return alerts;
  }
);

// ─── SKU Detail ─────────────────────────────────────────
export const getSkuDetail = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ sku: z.string().min(1).max(50).regex(/^[\w\-]+$/) }).parse(data)
  )
  .handler(async ({ data }): Promise<SkuDetail> => {
    const { sku } = data;

    const [inventoryResult, ordersResult, inboundResult] = await Promise.allSettled([
      walmartApi.getInventoryForSku(sku),
      fetchAllOrders(daysAgo(30)),
      walmartApi.getInboundShipments(),
    ]);

    if (inventoryResult.status === "rejected") {
      throw new Error(`Failed to load SKU detail: ${inventoryResult.reason?.message ?? "inventory unavailable"}`);
    }

    const rawInventory = parseInventoryResponse(inventoryResult.value);
    const rawItem = rawInventory.find((i) => i.sku === sku);

    if (!rawItem) {
      throw new Error(`SKU ${sku} not found`);
    }

    const orders = ordersResult.status === "fulfilled" ? ordersResult.value : [];
    const skuOrders = orders.filter((o) => o.sku === sku);
    const unitsSold30d = skuOrders.reduce((sum, o) => sum + o.qty, 0);
    const velocity = biz.computeVelocity(unitsSold30d);

    const enriched = biz.enrichInventoryItem(rawItem, unitsSold30d);
    const salesHistory = aggregateDailyTrends(skuOrders);
    const inboundShipments =
      inboundResult.status === "fulfilled"
        ? parseInboundResponse(inboundResult.value).filter((s) => s.skus.includes(sku))
        : [];

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
  });

// ─── Paginating Helpers ──────────────────────────────────

type RawInventoryItem = {
  sku: string;
  productName: string;
  onHand: number;
  availableToSell: number;
  reserved: number;
  inbound: number;
  lastUpdated: string;
};

const MAX_PAGES = 3; // Limit pagination to avoid Worker timeouts (Cloudflare has ~30s limit)

async function fetchAllInventory(): Promise<RawInventoryItem[]> {
  const items: RawInventoryItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const raw = await walmartApi.getWfsInventory(cursor);
    // Walmart wraps responses in { status, headers, payload } — unwrap if present
    const page = (raw as any)?.payload ?? raw;

    if (pages === 0) {
      const keys = Object.keys(raw ?? {});
      const payloadKeys = (raw as any)?.payload ? Object.keys((raw as any).payload) : [];
      const rawHeaders = (raw as any)?.headers ?? {};
      const invVal = (page as any)?.inventory;
      const invIsArray = Array.isArray(invVal);
      const sample = invIsArray ? invVal[0] : (invVal?.elements ?? page?.elements ?? [])[0];
      const sampleNode = (sample?.shipNodes ?? [])[0];
      console.log("[WFS] inventory raw keys:", keys.join(", "), "| payload keys:", payloadKeys.join(", "));
      console.log("[WFS] inventory headers:", JSON.stringify(rawHeaders));
      console.log("[WFS] inventory is array:", invIsArray, "| count:", invIsArray ? invVal.length : 0, "| sample item keys:", Object.keys(sample ?? {}).join(", "));
      if (sampleNode) {
        console.log("[WFS] sample shipNode:", JSON.stringify(sampleNode));
      }
    }

    items.push(...parseInventoryResponse(page));
    // Cursor may be in payload body or in the response headers envelope
    cursor = (page as any)?.nextCursor ?? (raw as any)?.headers?.nextCursor ?? (raw as any)?.headers?.["WM_NEXT_CURSOR"];
    pages++;
  } while (cursor && pages < MAX_PAGES);
  console.log(`[WFS] fetchAllInventory done — pages: ${pages}, items: ${items.length}`);
  if (cursor) console.warn(`[WFS] Inventory truncated after ${MAX_PAGES} pages (${items.length} items)`);
  return items;
}

async function fetchAllOrders(startDate: string): Promise<RawOrder[]> {
  const orders: RawOrder[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const raw = await walmartApi.getOrders({ createdStartDate: startDate, nextCursor: cursor });
    // Walmart wraps responses in { status, headers, payload } — unwrap if present
    const page = (raw as any)?.payload ?? raw;

    if (pages === 0) {
      const rawKeys = Object.keys(raw ?? {});
      const payloadKeys = (raw as any)?.payload ? Object.keys((raw as any).payload) : [];
      const meta = page?.list?.meta;
      const rawOrderList = page?.list?.elements?.order ?? page?.orders ?? page?.elements ?? [];
      const sampleOrder = rawOrderList[0];
      console.log("[WFS] orders raw keys:", rawKeys.join(", "), "| payload keys:", payloadKeys.join(", "));
      console.log("[WFS] orders page 0 — totalCount:", meta?.totalCount, "| returned:", rawOrderList.length);
      if (sampleOrder) {
        const sampleLine = sampleOrder.orderLines?.orderLine?.[0];
        const sampleStatuses = sampleLine?.orderLineStatuses?.orderLineStatus ?? [];
        console.log("[WFS] sample order keys:", Object.keys(sampleOrder).join(", "));
        console.log("[WFS] sample line orderLineQuantity:", JSON.stringify(sampleLine?.orderLineQuantity));
        console.log("[WFS] sample line statuses:", JSON.stringify(sampleStatuses));
      }
    }

    orders.push(...parseOrdersResponse(page));
    cursor = page?.nextCursor ?? page?.list?.meta?.nextCursor;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  console.log(`[WFS] fetchAllOrders done — pages: ${pages}, line items: ${orders.length}, total units: ${orders.reduce((s, o) => s + o.qty, 0)}`);
  if (cursor) console.warn(`[WFS] Orders truncated after ${MAX_PAGES} pages (${orders.length} orders)`);
  return orders;
}

// ─── Date Helpers ────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── Parsers ────────────────────────────────────────────

interface RawOrder {
  sku: string;
  productName: string;
  qty: number;
  revenue: number;
  date: string;
}

type InventoryAndOrdersResult = {
  inventory: RawInventoryItem[];
  orders: RawOrder[];
  inventoryUnavailable: boolean;
  inventoryError?: string;
};

async function loadInventoryAndOrders(context: string): Promise<InventoryAndOrdersResult> {
  const [inventoryResult, ordersResult] = await Promise.allSettled([
    fetchAllInventory(),
    fetchAllOrders(daysAgo(30)),
  ]);

  const inventoryState = resolveInventoryResult(inventoryResult, context);
  const orders = resolveOrdersResult(ordersResult, context);

  return {
    inventory: inventoryState.data,
    orders,
    inventoryUnavailable: inventoryState.unavailable,
    inventoryError: inventoryState.error,
  };
}

function resolveInventoryResult(
  result: PromiseSettledResult<RawInventoryItem[]>,
  context: string
): { data: RawInventoryItem[]; unavailable: boolean; error?: string } {
  if (result.status === "fulfilled") {
    return { data: result.value, unavailable: false };
  }

  const message = getErrorMessage(result.reason, "inventory unavailable");

  if (isRecoverableWalmartError(result.reason)) {
    console.warn(`[WFS] ${context}: inventory temporarily unavailable, using empty fallback. ${message}`);
    return { data: [], unavailable: true, error: message };
  }

  throw new Error(`Failed to load ${context}: ${message}`);
}

function resolveOrdersResult(
  result: PromiseSettledResult<RawOrder[]>,
  context: string
): RawOrder[] {
  if (result.status === "fulfilled") {
    return result.value;
  }

  console.warn(
    `[WFS] ${context}: orders temporarily unavailable, using empty fallback. ${getErrorMessage(result.reason, "orders unavailable")}`
  );
  return [];
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isRecoverableWalmartError(error: unknown): boolean {
  const message = getErrorMessage(error, "");
  const maybeError = error as { name?: string; cause?: { code?: string } } | null;
  const statusMatch = message.match(/Walmart API error \[(\d+)\]/);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  return (
    message.includes("WALMART_CLIENT_ID and WALMART_CLIENT_SECRET must be configured") ||
    maybeError?.name === "AbortError" ||
    maybeError?.name === "TimeoutError" ||
    maybeError?.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    status === 429 ||
    (status !== null && status >= 500) ||
    message.includes("SYSTEM_ERROR.GMP_GATEWAY_API")
  );
}

function formatInventoryError(inventoryError?: string): string {
  if (!inventoryError) {
    return "Inventory data is temporarily unavailable from Walmart. Retry in a few minutes.";
  }

  // SYSTEM_ERROR.GMP_GATEWAY_API: Walmart's backend had an internal error — usually
  // caused by missing API key permissions or account not enrolled in WFS.
  if (inventoryError.includes("SYSTEM_ERROR.GMP_GATEWAY_API")) {
    return (
      "Walmart API error: SYSTEM_ERROR.GMP_GATEWAY_API. " +
      "Check that your API key has 'View Inventory' permission enabled in " +
      "Seller Center → Settings → Developer Settings, and that this account " +
      "is enrolled in Walmart Fulfillment Services (WFS)."
    );
  }

  // 401 / 403: auth or permissions issue
  if (inventoryError.includes("[401]") || inventoryError.includes("[403]")) {
    return (
      `Walmart API authentication error (${inventoryError.match(/\[\d+\]/)?.[0] ?? "auth"}). ` +
      "Verify WALMART_CLIENT_ID and WALMART_CLIENT_SECRET are correct and that the " +
      "API key has inventory read permissions."
    );
  }

  // 429: rate limited
  if (inventoryError.includes("[429]")) {
    return "Walmart API rate limit reached. Data will refresh automatically in a few minutes.";
  }

  return `Inventory data is temporarily unavailable from Walmart (${inventoryError}). Retry in a few minutes.`;
}

function makeSystemAlert(message: string): Alert {
  return {
    id: `system-${Date.now()}`,
    type: "system",
    severity: "warning",
    message,
    createdAt: new Date().toISOString(),
  };
}

function normalizeOrderDate(rawDate: unknown): string {
  if (!rawDate) return new Date().toISOString().slice(0, 10);

  if (rawDate instanceof Date) {
    return rawDate.toISOString().slice(0, 10);
  }

  if (typeof rawDate === "number") {
    const epochMs = rawDate < 1_000_000_000_000 ? rawDate * 1000 : rawDate;
    return new Date(epochMs).toISOString().slice(0, 10);
  }

  if (typeof rawDate === "string") {
    const trimmed = rawDate.trim();
    if (!trimmed) return new Date().toISOString().slice(0, 10);

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      const epochMs = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
      return new Date(epochMs).toISOString().slice(0, 10);
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }

    return trimmed.slice(0, 10);
  }

  if (typeof rawDate === "object") {
    const maybeDateLike = rawDate as { value?: string | number; date?: string | number; timestamp?: string | number };
    return normalizeOrderDate(maybeDateLike.value ?? maybeDateLike.date ?? maybeDateLike.timestamp ?? null);
  }

  return new Date().toISOString().slice(0, 10);
}

function parseInventoryResponse(data: any): RawInventoryItem[] {
  // Walmart WFS inventory response formats (after payload unwrap):
  //   { inventory: [...], nextCursor }            — direct array (common)
  //   { inventory: { elements: [...] } }           — nested elements
  //   { invDetails: { inventoryDetails: [...] } }  — alternate WFS format
  //   { elements: [...] }  |  { items: [...] }     — fallback
  const items: any[] =
    (Array.isArray(data?.inventory) ? data.inventory : null) ??
    data?.inventory?.elements ??
    data?.invDetails?.inventoryDetails ??
    data?.elements ??
    data?.items ??
    [];

  return items
    .map((item: any) => {
      // /v3/fulfillment/inventory returns quantities nested inside shipNodes[]:
      //   { sku, offerId, shipNodes: [{ shipNodeId, type, onHandQty, availableToSellQty, ... }] }
      // We sum across all WFS nodes (usually just one) and fall back to top-level fields
      // for older/alternate response formats.
      const shipNodes: any[] = item.shipNodes ?? [];
      const wfsNodes = shipNodes.filter(
        (n: any) =>
          !n.type || // include if type absent (treat as WFS)
          n.type === "WFS" ||
          n.type === "FC" ||
          String(n.shipNodeId ?? "").toUpperCase().includes("WFS")
      );
      const nodes = wfsNodes.length > 0 ? wfsNodes : shipNodes;

      const sumNode = (field: string) =>
        nodes.reduce((sum: number, n: any) => {
          const val = n[field];
          return sum + Number(typeof val === "object" ? (val?.amount ?? val?.value ?? 0) : (val ?? 0));
        }, 0);

      const onHand =
        nodes.length > 0
          ? sumNode("onHandQty")
          : Number(item.onHandQuantity?.amount ?? item.quantity?.amount ?? item.onHand ?? item.onHandQty ?? item.qty ?? 0);

      const availableToSell =
        nodes.length > 0
          ? sumNode("availableToSellQty")
          : Number(item.availableToSellQuantity?.amount ?? item.availableToSellQty ?? item.available ?? 0);

      const reserved =
        nodes.length > 0
          ? sumNode("reservedQty")
          : Number(item.reservedQuantity?.amount ?? item.reservedQty ?? item.reserved ?? 0);

      const inbound =
        nodes.length > 0
          ? sumNode("inTransitQty")
          : Number(item.inTransitQuantity?.amount ?? item.inboundQuantity?.amount ?? item.inboundQty ?? item.inbound ?? 0);

      return {
        sku: item.sku ?? item.SKU ?? "",
        productName: item.productName ?? item.product_name ?? item.sku ?? "",
        onHand,
        availableToSell,
        reserved,
        inbound,
        lastUpdated: item.lastUpdatedTs ?? item.lastUpdated ?? new Date().toISOString(),
      };
    })
    .filter((item: RawInventoryItem) => item.sku !== "");
}

function parseOrdersResponse(data: any): RawOrder[] {
  const orderList = data?.list?.elements?.order ?? data?.orders ?? data?.elements ?? [];
  const result: RawOrder[] = [];

  for (const order of orderList) {
    const lines = order.orderLines?.orderLine ?? order.lines ?? [];
    const rawDate = order.orderDate ?? order.createdDate ?? order.orderDateTime ?? order.createdAt ?? null;
    const normalizedOrderDate = normalizeOrderDate(rawDate);

    for (const line of lines) {
      const orderedQty = Number(line.orderLineQuantity?.amount ?? line.quantity ?? 1);
      if (orderedQty <= 0 || isNaN(orderedQty)) continue;

      // Subtract only explicitly cancelled quantities.
      // Seller Center "units sold" = all non-cancelled orders
      // (includes Created, Acknowledged, Shipped, Delivered — excludes Cancelled only).
      // We can't use shipped-status-only because WFS orders sit in Acknowledged
      // for 1-2 days before shipping, and Seller Center counts them immediately.
      const statuses: any[] = line.orderLineStatuses?.orderLineStatus ?? [];
      const cancelledQty = statuses
        .filter((s: any) => s.status === "Cancelled")
        .reduce((sum: number, s: any) => sum + Number(s.statusQuantity?.amount ?? 0), 0);

      const qty = orderedQty - cancelledQty;
      if (qty <= 0) continue;

      result.push({
        sku: line.item?.sku ?? line.sku ?? "",
        productName: line.item?.productName ?? line.productName ?? "",
        qty,
        revenue:
          Number(line.charges?.charge?.[0]?.chargeAmount?.amount ?? line.price ?? 0) * qty,
        date: normalizedOrderDate,
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

// ─── Aggregators ────────────────────────────────────────

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
