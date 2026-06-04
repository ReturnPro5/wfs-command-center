/**
 * Server functions for WFS dashboard data.
 * All Walmart API calls happen here, server-side only.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import * as walmartApi from "@/services/walmartApi";
import { getWalmartAccessToken } from "@/services/walmartAuth";
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
    const revenueByDay = aggregateRevenueByDay(orders);
    const salesBySku = aggregateOrdersBySku(orders);

    const enriched = inventory.map((item) => {
      const skuSales = salesBySku.get(item.sku);
      return biz.enrichInventoryItem(item, skuSales?.unitsSold30d ?? 0);
    });

    const todayStr = new Date().toISOString().slice(0, 10);

    // Date distribution diagnostics
    const dateCounts = new Map<string, number>();
    for (const o of orders) {
      dateCounts.set(o.date, (dateCounts.get(o.date) ?? 0) + 1);
    }
    const sortedDates = [...dateCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const firstDate = sortedDates[0]?.[0] ?? "none";
    const lastDate = sortedDates[sortedDates.length - 1]?.[0] ?? "none";
    console.log(`[WFS:getOverview] date range: ${firstDate} → ${lastDate}, unique dates: ${sortedDates.length}`);
    console.log(`[WFS:getOverview] first 5 dates:`, sortedDates.slice(0, 5).map(([d, c]) => `${d}(${c})`).join(", "));
    console.log(`[WFS:getOverview] last 5 dates:`, sortedDates.slice(-5).map(([d, c]) => `${d}(${c})`).join(", "));
    console.log(`[WFS:getOverview] today=${todayStr} salesToday=${salesByDay.get(todayStr) ?? 0} revToday=${revenueByDay.get(todayStr)?.toFixed(2) ?? 0}`);

    return {
      totalWfsInventory: enriched.reduce((sum, i) => sum + i.onHand, 0),
      wfsCatalogSkuCount: inventory.length,
      activeSkuCount: enriched.filter((i) => i.onHand > 0).length,
      salesToday: salesByDay.get(todayStr) ?? 0,
      salesThisWeek: computeSalesThisWeek(salesByDay),
      salesMTD: computeSalesMTD(salesByDay),
      salesYTD: computeSalesYTD(salesByDay),
      revenueToday: revenueByDay.get(todayStr) ?? 0,
      revenueThisWeek: computeSalesThisWeek(revenueByDay),
      revenueMTD: computeRevMTD(revenueByDay),
      revenueYTD: computeRevYTD(revenueByDay),
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

// ─── YTD Reconciliation ─────────────────────────────────
export interface YtdOrderLine {
  sku: string;
  productName: string;
  qty: number;
  revenue: number;
  date: string;
  purchaseOrderId: string;
  lineNumber: string;
}

export interface YtdReconciliation {
  totals: { units: number; revenue: number };
  bySku: Array<{ sku: string; productName: string; units: number; revenue: number }>;
  byMonth: Array<{ month: string; units: number; revenue: number }>;
  lines: YtdOrderLine[];
}

export const getYtdReconciliation = createServerFn({ method: "GET" }).handler(
  async (): Promise<YtdReconciliation> => {
    await getWalmartAccessToken();
    const orders = await fetchAllOrders(startOfYear(), 20);

    const bySkuMap = new Map<string, { sku: string; productName: string; units: number; revenue: number }>();
    const byMonthMap = new Map<string, { units: number; revenue: number }>();
    let totalUnits = 0;
    let totalRevenue = 0;

    for (const o of orders) {
      totalUnits += o.qty;
      totalRevenue += o.revenue;

      const skuRow = bySkuMap.get(o.sku) ?? { sku: o.sku, productName: o.productName, units: 0, revenue: 0 };
      skuRow.units += o.qty;
      skuRow.revenue += o.revenue;
      bySkuMap.set(o.sku, skuRow);

      const month = o.date.slice(0, 7);
      const m = byMonthMap.get(month) ?? { units: 0, revenue: 0 };
      m.units += o.qty;
      m.revenue += o.revenue;
      byMonthMap.set(month, m);
    }

    return {
      totals: { units: totalUnits, revenue: totalRevenue },
      bySku: [...bySkuMap.values()].sort((a, b) => b.revenue - a.revenue),
      byMonth: [...byMonthMap.entries()]
        .map(([month, v]) => ({ month, ...v }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      lines: orders.sort((a, b) => b.date.localeCompare(a.date)),
    };
  }
);

// ─── Sales Diagnostics ──────────────────────────────────
export type SalesDiagnosticReason =
  | "included"
  | "excluded:order-seller-fulfilled"
  | "excluded:line-seller-fulfilled"
  | "excluded:zero-or-cancelled-qty"
  | "excluded:missing-sku";

export interface SalesDiagnosticLine {
  reason: SalesDiagnosticReason;
  purchaseOrderId: string;
  lineNumber: string;
  sku: string;
  productName: string;
  qty: number;
  revenue: number;
  date: string;
  orderShipNode: any;
  lineFulfillment: any;
}

export interface SalesDiagnostics {
  windowStart: string;
  totalOrdersFetched: number;
  totalLinesSeen: number;
  counts: Record<SalesDiagnosticReason, number>;
  unitsIncluded: number;
  revenueIncluded: number;
  samples: Record<SalesDiagnosticReason, SalesDiagnosticLine[]>;
}

export const getSalesDiagnostics = createServerFn({ method: "GET" }).handler(
  async (): Promise<SalesDiagnostics> => {
    await getWalmartAccessToken();

    const startDate = startOfYear();
    const rawOrders: any[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const MAX_PAGES = 20;
    do {
      const raw = await walmartApi.getOrders({
        createdStartDate: startDate,
        shipNodeType: "WFSFulfilled",
        nextCursor: cursor,
      });
      const page = (raw as any)?.payload ?? raw;
      const orderList = page?.list?.elements?.order ?? page?.orders ?? page?.elements ?? [];
      rawOrders.push(...orderList);
      const nextCursor: string | undefined =
        page?.list?.meta?.nextCursor ?? page?.nextCursor ?? page?.meta?.nextCursor;
      if (nextCursor && nextCursor === cursor) break;
      cursor = nextCursor;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    const counts: Record<SalesDiagnosticReason, number> = {
      "included": 0,
      "excluded:order-seller-fulfilled": 0,
      "excluded:line-seller-fulfilled": 0,
      "excluded:zero-or-cancelled-qty": 0,
      "excluded:missing-sku": 0,
    };
    const samples: Record<SalesDiagnosticReason, SalesDiagnosticLine[]> = {
      "included": [],
      "excluded:order-seller-fulfilled": [],
      "excluded:line-seller-fulfilled": [],
      "excluded:zero-or-cancelled-qty": [],
      "excluded:missing-sku": [],
    };
    const SAMPLE_LIMIT = 25;
    let totalLines = 0;
    let unitsIncluded = 0;
    let revenueIncluded = 0;

    for (const order of rawOrders) {
      const lines = order.orderLines?.orderLine ?? order.lines ?? [];
      const rawDate = order.orderDate ?? order.createdDate ?? order.orderDateTime ?? null;
      const date = (() => {
        try {
          const ms = typeof rawDate === "number" && rawDate < 1e12 ? rawDate * 1000 : rawDate;
          return new Date(ms).toISOString().slice(0, 10);
        } catch { return ""; }
      })();
      const orderShipNode = order.shipNode ?? null;
      const orderShipNodeType: string | undefined =
        order.shipNode?.type ?? order.shipNode?.shipNodeType ?? order.shipNodeType;
      const orderSellerFulfilled = orderShipNodeType
        ? /seller/i.test(orderShipNodeType) && !/WFS|FC/i.test(orderShipNodeType)
        : false;

      for (const line of lines) {
        totalLines++;
        const lineFulfillment = line.fulfillment ?? null;
        const lineShipNodeType: string | undefined =
          line.fulfillment?.shipNode?.type ?? line.fulfillment?.fulfillmentType ?? line.shipNodeType;
        const lineSellerFulfilled = lineShipNodeType
          ? /seller/i.test(lineShipNodeType) && !/WFS|FC/i.test(lineShipNodeType)
          : false;

        const orderedQty = Number(line.orderLineQuantity?.amount ?? line.quantity ?? 1);
        const statuses: any[] = line.orderLineStatuses?.orderLineStatus ?? [];
        const cancelledQty = statuses
          .filter((s: any) => s.status === "Cancelled")
          .reduce((sum: number, s: any) => sum + Number(s.statusQuantity?.amount ?? 0), 0);
        const qty = Math.max(0, orderedQty - cancelledQty);

        const charges: any[] = line.charges?.charge ?? [];
        const productCharge =
          charges.find((c: any) => c.chargeType === "PRODUCT" || c.chargeName === "ItemPrice") ??
          charges[0];
        const revenue = Number(productCharge?.chargeAmount?.amount ?? line.price ?? 0);

        const sku = line.item?.sku ?? line.sku ?? "";
        const productName = line.item?.productName ?? line.productName ?? "";

        let reason: SalesDiagnosticReason = "included";
        if (orderSellerFulfilled) reason = "excluded:order-seller-fulfilled";
        else if (lineSellerFulfilled) reason = "excluded:line-seller-fulfilled";
        else if (qty <= 0) reason = "excluded:zero-or-cancelled-qty";
        else if (!sku) reason = "excluded:missing-sku";

        counts[reason]++;
        if (reason === "included") {
          unitsIncluded += qty;
          revenueIncluded += revenue;
        }

        const bucket = samples[reason];
        if (bucket.length < SAMPLE_LIMIT) {
          bucket.push({
            reason,
            purchaseOrderId: String(order.purchaseOrderId ?? order.customerOrderId ?? ""),
            lineNumber: String(line.lineNumber ?? line.orderLineNumber ?? ""),
            sku,
            productName,
            qty,
            revenue,
            date,
            orderShipNode,
            lineFulfillment,
          });
        }
      }
    }

    return {
      windowStart: startDate,
      totalOrdersFetched: rawOrders.length,
      totalLinesSeen: totalLines,
      counts,
      unitsIncluded,
      revenueIncluded,
      samples,
    };
  }
);

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
      await getWalmartAccessToken();
      orders = await fetchAllOrders(startOfYear(), 20); // single YTD window
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
    const data = await fetchInboundShipmentsCached();
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
      fetchInboundShipmentsCached(),
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

const MAX_PAGES_INVENTORY = 3;

// Module-level dedupe + TTL cache for inventory and inbound shipments.
// Multiple concurrent server fns (overview, inventory health, alerts, replenishment,
// SKU detail) all need the same paginated payloads; without this they race and exhaust
// the worker timeout (504 upstream timeouts).
const INVENTORY_CACHE_TTL_MS = 3 * 60 * 1000;
const INBOUND_CACHE_TTL_MS = 3 * 60 * 1000;

let inventoryCache: { ts: number; promise: Promise<RawInventoryItem[]> } | null = null;
let inboundCache: { ts: number; promise: Promise<any> } | null = null;

async function fetchAllInventory(): Promise<RawInventoryItem[]> {
  if (inventoryCache && Date.now() - inventoryCache.ts < INVENTORY_CACHE_TTL_MS) {
    console.log("[WFS] inventory cache HIT");
    return inventoryCache.promise;
  }

  const promise = (async () => {
    const items: RawInventoryItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const raw = await walmartApi.getWfsInventory(cursor);
      const page = (raw as any)?.payload ?? raw;

      if (pages === 0) {
        const keys = Object.keys(raw ?? {});
        const payloadKeys = (raw as any)?.payload ? Object.keys((raw as any).payload) : [];
        const invVal = (page as any)?.inventory;
        const invIsArray = Array.isArray(invVal);
        const sample = invIsArray ? invVal[0] : (invVal?.elements ?? page?.elements ?? [])[0];
        console.log("[WFS] inventory raw keys:", keys.join(", "), "| payload keys:", payloadKeys.join(", "));
        console.log("[WFS] inventory is array:", invIsArray, "| count:", invIsArray ? invVal.length : 0, "| sample item keys:", Object.keys(sample ?? {}).join(", "));
      }

      items.push(...parseInventoryResponse(page));
      cursor = (page as any)?.nextCursor ?? (raw as any)?.headers?.nextCursor ?? (raw as any)?.headers?.["WM_NEXT_CURSOR"];
      pages++;
    } while (cursor && pages < MAX_PAGES_INVENTORY);
    console.log(`[WFS] fetchAllInventory done — pages: ${pages}, items: ${items.length}`);
    if (cursor) console.warn(`[WFS] Inventory truncated after ${MAX_PAGES_INVENTORY} pages (${items.length} items)`);
    return items;
  })();

  inventoryCache = { ts: Date.now(), promise };
  promise.catch(() => { inventoryCache = null; });
  return promise;
}

async function fetchInboundShipmentsCached(): Promise<any> {
  if (inboundCache && Date.now() - inboundCache.ts < INBOUND_CACHE_TTL_MS) {
    console.log("[WFS] inbound cache HIT");
    return inboundCache.promise;
  }
  const promise = walmartApi.getInboundShipments();
  inboundCache = { ts: Date.now(), promise };
  promise.catch(() => { inboundCache = null; });
  return promise;
}

// Fetch a bounded window of orders (start to optional end), up to maxPages pages.
// Walmart returns newest-first within each window, so narrower windows = better coverage.
//
// Module-level cache: multiple server fns (overview, alerts, reconciliation) often
// request the same YTD window within seconds of each other. Without this, they each
// re-paginate ~20 pages and concurrently exhaust the worker timeout (504s).
const ORDERS_CACHE_TTL_MS = 3 * 60 * 1000;
const ordersCache = new Map<string, { ts: number; promise: Promise<RawOrder[]> }>();

async function fetchAllOrders(
  startDate: string,
  maxPages = 12,
  endDate?: string
): Promise<RawOrder[]> {
  if (endDate && new Date(endDate) <= new Date(startDate)) return [];

  const key = `${startDate}|${endDate ?? ""}|${maxPages}`;
  const cached = ordersCache.get(key);
  if (cached && Date.now() - cached.ts < ORDERS_CACHE_TTL_MS) {
    console.log(`[WFS] orders cache HIT ${key}`);
    return cached.promise;
  }

  const promise = (async () => {
    const orders: RawOrder[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let dupesThisRun = 0;
    do {
      const raw = await walmartApi.getOrders({
        createdStartDate: startDate,
        ...(endDate ? { createdEndDate: endDate } : {}),
        shipNodeType: "WFSFulfilled",
        nextCursor: cursor,
      });
      const page = (raw as any)?.payload ?? raw;

      const pageOrders = parseOrdersResponse(page, pages === 0);
      let added = 0;
      for (const o of pageOrders) {
        const k = `${o.purchaseOrderId}|${o.lineNumber}|${o.sku}`;
        if (seen.has(k)) { dupesThisRun++; continue; }
        seen.add(k);
        orders.push(o);
        added++;
      }

      const nextCursor: string | undefined =
        page?.list?.meta?.nextCursor ?? page?.nextCursor ?? page?.meta?.nextCursor;
      console.log(`[WFS] orders page ${pages}: ${pageOrders.length} lines, ${added} new, ${pageOrders.length - added} dupes`);

      if (nextCursor && nextCursor === cursor) {
        console.warn(`[WFS] orders cursor did not advance — breaking at page ${pages}`);
        break;
      }
      cursor = nextCursor;
      pages++;
    } while (cursor && pages < maxPages);

    const label = endDate ? `${startDate.slice(0, 10)}→${endDate.slice(0, 10)}` : `${startDate.slice(0, 10)}→now`;
    console.log(`[WFS] orders window [${label}] — pages: ${pages}, unique lines: ${orders.length}, dupes filtered: ${dupesThisRun}, units: ${orders.reduce((s, o) => s + o.qty, 0)}`);
    if (cursor) console.warn(`[WFS] Orders window [${label}] truncated after ${maxPages} pages`);
    return orders;
  })();

  ordersCache.set(key, { ts: Date.now(), promise });
  // Evict failures and empty results so transient issues / parser bugs don't
  // pin a useless answer in cache for the full TTL window.
  promise.then(
    (r) => { if (r.length === 0) ordersCache.delete(key); },
    () => ordersCache.delete(key),
  );
  return promise;
}

// ─── Date Helpers ────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function startOfYear(): string {
  return new Date(new Date().getFullYear(), 0, 1).toISOString();
}

// ─── Parsers ────────────────────────────────────────────

interface RawOrder {
  sku: string;
  productName: string;
  qty: number;
  revenue: number;
  date: string;
  purchaseOrderId: string;
  lineNumber: string;
}

type InventoryAndOrdersResult = {
  inventory: RawInventoryItem[];
  orders: RawOrder[];
  inventoryUnavailable: boolean;
  inventoryError?: string;
};

async function loadInventoryAndOrders(context: string): Promise<InventoryAndOrdersResult> {
  // Pre-warm auth token sequentially before any parallel API calls.
  // Walmart rejects bursts of concurrent /v3/token requests; getting the token
  // first ensures all parallel fetches below hit the module-level cache instead.
  await getWalmartAccessToken();

  const [inventoryResult, ordersResult] = await Promise.allSettled([
    fetchAllInventory(),
    fetchAllOrders(startOfYear(), 20), // single YTD window — paginate fully
  ]);

  const inventoryState = resolveInventoryResult(inventoryResult, context);
  const orders = resolveOrdersResult(ordersResult, context);

  console.log(`[WFS] loadInventoryAndOrders [${context}] total orders: ${orders.length}`);

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
          ? sumNode("availToSellQty")
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

function parseOrdersResponse(data: any, logSample = false): RawOrder[] {
  const orderList = data?.list?.elements?.order ?? data?.orders ?? data?.elements ?? [];
  const result: RawOrder[] = [];

  for (let oi = 0; oi < orderList.length; oi++) {
    const order = orderList[oi];
    const lines = order.orderLines?.orderLine ?? order.lines ?? [];
    const rawDate = order.orderDate ?? order.createdDate ?? order.orderDateTime ?? order.createdAt ?? null;

    // Log first 3 orders to diagnose date + shipNode shape
    if (logSample && oi < 3) {
      console.log(`[WFS] sample order[${oi}] rawDate=`, JSON.stringify(rawDate), "shipNode=", JSON.stringify(order.shipNode), "firstLineFulfillment=", JSON.stringify((lines[0] as any)?.fulfillment));
    }

    const normalizedOrderDate = normalizeOrderDate(rawDate);

    // WFS / seller-fulfilled detection. Walmart's WFS ship node type is
    // "WFSFulfilled" (or contains "WFS"/"FC"); seller-fulfilled values include
    // "SellerFulfilled". Some payloads omit shipNode entirely — in that case we
    // INCLUDE the line (revert to "include unless explicitly seller-fulfilled")
    // so we don't silently drop every order.
    const orderShipNodeType: string | undefined =
      order.shipNode?.type ?? order.shipNode?.shipNodeType ?? order.shipNodeType;
    const isSellerFulfilledAtOrderLevel = orderShipNodeType
      ? /seller/i.test(orderShipNodeType) && !/WFS|FC/i.test(orderShipNodeType)
      : false;

    if (isSellerFulfilledAtOrderLevel) continue;

    for (const line of lines) {
      const lineShipNodeType: string | undefined =
        line.fulfillment?.shipNode?.type ?? line.fulfillment?.fulfillmentType ?? line.shipNodeType;
      const isSellerFulfilledAtLineLevel = lineShipNodeType
        ? /seller/i.test(lineShipNodeType) && !/WFS|FC/i.test(lineShipNodeType)
        : false;

      if (isSellerFulfilledAtLineLevel) continue;

      const orderedQty = Number(line.orderLineQuantity?.amount ?? line.quantity ?? 1);
      if (orderedQty <= 0 || isNaN(orderedQty)) continue;

      const statuses: any[] = line.orderLineStatuses?.orderLineStatus ?? [];
      const cancelledQty = statuses
        .filter((s: any) => s.status === "Cancelled")
        .reduce((sum: number, s: any) => sum + Number(s.statusQuantity?.amount ?? 0), 0);

      const qty = orderedQty - cancelledQty;
      if (qty <= 0) continue;

      const charges: any[] = line.charges?.charge ?? [];
      const productCharge =
        charges.find((c: any) => c.chargeType === "PRODUCT" || c.chargeName === "ItemPrice") ??
        charges[0];
      const revenue = Number(productCharge?.chargeAmount?.amount ?? line.price ?? 0);

      result.push({
        sku: line.item?.sku ?? line.sku ?? "",
        productName: line.item?.productName ?? line.productName ?? "",
        qty,
        revenue,
        date: normalizedOrderDate,
        purchaseOrderId: String(order.purchaseOrderId ?? order.customerOrderId ?? ""),
        lineNumber: String(line.lineNumber ?? line.orderLineNumber ?? ""),
      });
    }
  }

  return result;
}

function normalizeShipmentStatus(raw: any): InboundShipment["status"] {
  const s = String(raw ?? "").toLowerCase().replace(/_/g, "-");
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("complet") || s === "received") return "completed";
  if (s.includes("receiv")) return "receiving";
  if (s.includes("deliver")) return "delivered";
  if (s.includes("transit") || s === "shipped") return "in-transit";
  return "created";
}

function parseInboundResponse(data: any): InboundShipment[] {
  const payload = data?.payload ?? data;
  const shipments: any[] =
    payload?.inboundShipments ??
    payload?.shipments ??
    payload?.elements ??
    payload?.data ??
    payload?.list?.elements?.inboundShipment ??
    payload?.list?.elements ??
    (Array.isArray(payload) ? payload : []);

  if (!Array.isArray(shipments) || shipments.length === 0) {
    console.log(
      "[WFS] inbound parse — no shipments. top keys:",
      Object.keys(data ?? {}).join(","),
      "| payload keys:",
      Object.keys(payload ?? {}).join(",")
    );
    return [];
  }

  console.log(`[WFS] inbound parse — found ${shipments.length} shipment(s); sample keys: ${Object.keys(shipments[0] ?? {}).join(",")}`);

  return shipments.map((s: any) => {
    const items = s.items ?? s.orderItems ?? s.shipmentItems ?? s.inboundShipmentItems ?? [];
    const unitsShipped =
      s.totalUnitsShipped ??
      s.unitsShipped ??
      s.shippedQty ??
      items.reduce((sum: number, i: any) => sum + Number(i.shippedQty ?? i.qty ?? i.quantity ?? 0), 0);
    const unitsReceived =
      s.totalUnitsReceived ??
      s.unitsReceived ??
      s.receivedQty ??
      items.reduce((sum: number, i: any) => sum + Number(i.receivedQty ?? 0), 0);
    return {
      shipmentId: s.shipmentId ?? s.inboundShipmentId ?? s.id ?? s.inboundOrderId ?? "",
      status: normalizeShipmentStatus(s.status ?? s.shipmentStatus),
      unitsShipped: Number(unitsShipped) || 0,
      unitsReceived: Number(unitsReceived) || 0,
      expectedArrival:
        s.expectedDeliveryDate ?? s.estimatedDeliveryDate ?? s.expectedArrival ?? s.expectedArrivalDate ?? "",
      discrepancy: (Number(unitsShipped) || 0) - (Number(unitsReceived) || 0),
      skus: items.map((i: any) => i.sku ?? i.itemSku ?? "").filter(Boolean),
    };
  });
}

// ─── Aggregators ────────────────────────────────────────

function aggregateOrdersBySku(
  orders: RawOrder[]
): Map<string, { sku: string; productName: string; unitsSold7d: number; unitsSold30d: number; revenue7d: number; revenue30d: number }> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDayStr = thirtyDaysAgo.toISOString().slice(0, 10);

  const sevenDaysAgo = new Date(now);
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

    if (o.date >= thirtyDayStr) {
      existing.unitsSold30d += o.qty;
      existing.revenue30d += o.revenue;
    }
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


function computeSalesMTD(salesByDay: Map<string, number>): number {
  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  let total = 0;
  for (const [date, units] of salesByDay) {
    if (date >= monthStart) total += units;
  }
  return total;
}

function computeSalesYTD(salesByDay: Map<string, number>): number {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  let total = 0;
  for (const [date, units] of salesByDay) {
    if (date >= yearStart) total += units;
  }
  return total;
}

// Current week = Sunday through today (matches Seller Center "This week")
function computeSalesThisWeek(byDay: Map<string, number>): number {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  const sundayStr = sunday.toISOString().slice(0, 10);
  let total = 0;
  for (const [date, val] of byDay) {
    if (date >= sundayStr) total += val;
  }
  return total;
}

function aggregateRevenueByDay(orders: RawOrder[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of orders) {
    map.set(o.date, (map.get(o.date) ?? 0) + o.revenue);
  }
  return map;
}

function computeRevMTD(revenueByDay: Map<string, number>): number {
  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  let total = 0;
  for (const [date, rev] of revenueByDay) {
    if (date >= monthStart) total += rev;
  }
  return total;
}

function computeRevYTD(revenueByDay: Map<string, number>): number {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  let total = 0;
  for (const [date, rev] of revenueByDay) {
    if (date >= yearStart) total += rev;
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

// ─── Catalog Identifiers (SKU / GTIN / UPC) ─────────────
export interface CatalogIdentifier {
  sku: string;
  productName: string;
  gtin: string;
  upc: string;
  lifecycle?: "ACTIVE" | "ARCHIVED" | "RETIRED" | string;
  condition?: string;
  publishedStatus?: string;
}

export interface CatalogPage {
  items: CatalogIdentifier[];
  nextCursor: string | null;
  totalCount: number | null;
  lifecycle: "ACTIVE" | "ARCHIVED" | "RETIRED";
  nextLifecycle: "ACTIVE" | "ARCHIVED" | "RETIRED" | null;
  publishedStatus: string;
}

const LIFECYCLE_ORDER: Array<"ACTIVE" | "ARCHIVED" | "RETIRED"> = ["ACTIVE", "ARCHIVED", "RETIRED"];
// Walmart returns only PUBLISHED items by default. Walk every status to capture the full catalog.
const PUBLISHED_STATUS_ORDER: string[] = [
  "PUBLISHED",
  "UNPUBLISHED",
  "STAGE",
  "IN_PROGRESS",
  "READY_TO_PUBLISH",
  "SYSTEM_PROBLEM",
];

// Walmart's /v3/items uses cursor-based pagination. Offset is capped at 10,000.
// You must pass `nextCursor=*` on the first call to opt into cursor mode and
// receive a real `nextCursor` back in the response.
export const getCatalogPage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        cursor: z.string().nullable().optional(),
        lifecycle: z.enum(["ACTIVE", "ARCHIVED", "RETIRED"]).optional(),
      })
      .parse(data)
  )
  .handler(async ({ data }): Promise<CatalogPage> => {
    await getWalmartAccessToken();
    const lifecycle = data.lifecycle ?? "ACTIVE";
    const cursor = data.cursor ?? "*"; // "*" = first page in cursor mode

    let raw: any;
    try {
      raw = await walmartApi.getItems(cursor, lifecycle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("[404]") || msg.includes("CONTENT_NOT_FOUND")) {
        const idx = LIFECYCLE_ORDER.indexOf(lifecycle);
        return {
          items: [],
          nextCursor: null,
          totalCount: null,
          lifecycle,
          nextLifecycle: LIFECYCLE_ORDER[idx + 1] ?? null,
          publishedStatus: "PUBLISHED",
        };
      }
      throw err;
    }

    const page = (raw as any)?.payload ?? raw;
    const list: any[] =
      page?.ItemResponse ??
      page?.itemResponse ??
      page?.items ??
      page?.elements ??
      page?.list?.elements?.item ??
      [];

    const items: CatalogIdentifier[] = list
      .map((it: any) => ({
        sku: String(it.sku ?? it.SKU ?? it.mart_sku ?? ""),
        productName: String(it.productName ?? it.product_name ?? it.name ?? ""),
        gtin: String(it.gtin ?? it.GTIN ?? ""),
        upc: String(
          it.upc ??
            it.UPC ??
            it.productIdentifiers?.find?.((p: any) => p.productIdType === "UPC")?.productId ??
            ""
        ),
      }))
      .filter((i) => i.sku);

    const totalCount: number | null =
      page?.totalItems ??
      page?.totalCount ??
      page?.meta?.totalCount ??
      page?.list?.meta?.totalCount ??
      null;

    let nextCursor: string | null =
      page?.nextCursor ??
      page?.meta?.nextCursor ??
      page?.list?.meta?.nextCursor ??
      null;
    // Treat "*", empty, or unchanged cursor as terminal. Keep the full querystring
    // (with leading "?") intact — getItems appends it verbatim to /v3/items.
    if (nextCursor === "*" || nextCursor === "" || nextCursor === cursor) {
      nextCursor = null;
    }

    let nextLifecycle: "ACTIVE" | "ARCHIVED" | "RETIRED" | null = null;
    if (!nextCursor) {
      const idx = LIFECYCLE_ORDER.indexOf(lifecycle);
      nextLifecycle = LIFECYCLE_ORDER[idx + 1] ?? null;
    }

    console.log(
      `[WFS:catalog] lifecycle=${lifecycle} cursorIn=${cursor.slice(0, 20)} returned ${items.length}, totalCount=${totalCount}, nextCursor=${nextCursor ? nextCursor.slice(0, 40) : "no"}, pageKeys=${Object.keys(page ?? {}).join(",")}`
    );

    return { items, nextCursor, totalCount, lifecycle, nextLifecycle };
  });

// ─── Cached Catalog (persisted in DB) ───────────────────

export interface CatalogSyncState {
  cursor: string | null;
  lifecycle: Lifecycle;
  last_sync_at: string | null;
  last_full_sync_at: string | null;
  status: string;
  error: string | null;
  pages_this_run: number;
  items_this_run: number;
}

type Lifecycle = "ACTIVE" | "ARCHIVED" | "RETIRED";

export interface CachedCatalogResponse {
  items: CatalogIdentifier[];
  state: CatalogSyncState;
  totalCached: number;
}

export const getCachedCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CachedCatalogResponse> => {
    // Page through to bypass Supabase 1000-row limit
    const PAGE = 1000;
    let from = 0;
    const items: CatalogIdentifier[] = [];
    while (true) {
      const { data, error } = await supabaseAdmin
        .from("catalog_items")
        .select("sku, product_name, gtin, upc, lifecycle")
        .order("sku", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`catalog cache read failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) {
        items.push({ sku: r.sku, productName: r.product_name ?? "", gtin: r.gtin ?? "", upc: r.upc ?? "", lifecycle: r.lifecycle ?? "" });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    const { data: stateRow, error: stateErr } = await supabaseAdmin
      .from("catalog_sync_state")
      .select("*")
      .eq("id", 1)
      .single();
    if (stateErr) throw new Error(`catalog state read failed: ${stateErr.message}`);

    return {
      items,
      totalCached: items.length,
      state: stateRow as CatalogSyncState,
    };
  }
);

const FULL_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SyncStepResult {
  added: number;
  updated: number;
  pageItems: number;
  totalCached: number;
  done: boolean;
  state: CatalogSyncState;
}

export const syncCatalogStep = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ reset: z.boolean().optional() }).parse(data ?? {})
  )
  .handler(async ({ data }): Promise<SyncStepResult> => {
    const { data: stateRow, error: stateErr } = await supabaseAdmin
      .from("catalog_sync_state")
      .select("*")
      .eq("id", 1)
      .single();
    if (stateErr) throw new Error(`sync state read failed: ${stateErr.message}`);

    let cursor: string | null = stateRow.cursor;
    let lifecycle: Lifecycle = (stateRow.lifecycle as Lifecycle) ?? "ACTIVE";
    let pagesThisRun = stateRow.pages_this_run ?? 0;
    let itemsThisRun = stateRow.items_this_run ?? 0;

    // Decide if a fresh full re-sync is due
    const lastFull = stateRow.last_full_sync_at ? new Date(stateRow.last_full_sync_at).getTime() : 0;
    const fullDue = Date.now() - lastFull > FULL_RESYNC_INTERVAL_MS;
    const startingFresh = data.reset || stateRow.status === "idle" || stateRow.status === "done" || stateRow.status === "error";

    if (data.reset || (startingFresh && fullDue)) {
      cursor = null;
      lifecycle = "ACTIVE";
      pagesThisRun = 0;
      itemsThisRun = 0;
    } else if (startingFresh) {
      // Resume: keep saved cursor/lifecycle, reset run counters
      pagesThisRun = 0;
      itemsThisRun = 0;
    }

    // Fetch one page from Walmart
    const page = await getCatalogPageInternal(cursor, lifecycle);

    // Upsert items
    let added = 0;
    let updated = 0;
    if (page.items.length) {
      const now = new Date().toISOString();
      // Find which SKUs already exist
      const skus = page.items.map((i) => i.sku);
      const { data: existing } = await supabaseAdmin
        .from("catalog_items")
        .select("sku")
        .in("sku", skus);
      const existingSet = new Set((existing ?? []).map((r: any) => r.sku));
      added = skus.filter((s) => !existingSet.has(s)).length;
      updated = skus.length - added;

      const rows = page.items.map((it) => ({
        sku: it.sku,
        product_name: it.productName,
        gtin: it.gtin,
        upc: it.upc,
        lifecycle: page.lifecycle,
        last_seen_at: now,
        last_synced_at: now,
      }));
      // Upsert in chunks
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error: upErr } = await supabaseAdmin
          .from("catalog_items")
          .upsert(slice, { onConflict: "sku", ignoreDuplicates: false });
        if (upErr) throw new Error(`catalog upsert failed: ${upErr.message}`);
      }
    }

    // Compute next state
    let nextCursor: string | null = page.nextCursor;
    let nextLifecycle: Lifecycle = lifecycle;
    let done = false;
    if (!nextCursor && page.nextLifecycle) {
      nextLifecycle = page.nextLifecycle;
    } else if (!nextCursor && !page.nextLifecycle) {
      done = true;
    }

    pagesThisRun += 1;
    itemsThisRun += page.items.length;

    const nowIso = new Date().toISOString();
    const update: any = {
      cursor: done ? null : nextCursor,
      lifecycle: done ? "ACTIVE" : nextLifecycle,
      last_sync_at: nowIso,
      status: done ? "done" : "running",
      error: null,
      pages_this_run: pagesThisRun,
      items_this_run: itemsThisRun,
    };
    if (done) update.last_full_sync_at = nowIso;

    const { data: newState, error: updErr } = await supabaseAdmin
      .from("catalog_sync_state")
      .update(update)
      .eq("id", 1)
      .select("*")
      .single();
    if (updErr) throw new Error(`sync state update failed: ${updErr.message}`);

    const { count } = await supabaseAdmin
      .from("catalog_items")
      .select("sku", { count: "exact", head: true });

    return {
      added,
      updated,
      pageItems: page.items.length,
      totalCached: count ?? 0,
      done,
      state: newState as CatalogSyncState,
    };
  });

// Internal helper that mirrors getCatalogPage handler logic without the server-fn wrapper
async function getCatalogPageInternal(
  cursorIn: string | null,
  lifecycle: Lifecycle
): Promise<CatalogPage> {
  await getWalmartAccessToken();
  const cursor = cursorIn ?? "*";
  let raw: any;
  try {
    raw = await walmartApi.getItems(cursor, lifecycle);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("[404]") || msg.includes("CONTENT_NOT_FOUND")) {
      const idx = LIFECYCLE_ORDER.indexOf(lifecycle);
      return { items: [], nextCursor: null, totalCount: null, lifecycle, nextLifecycle: LIFECYCLE_ORDER[idx + 1] ?? null };
    }
    throw err;
  }
  const page = (raw as any)?.payload ?? raw;
  const list: any[] =
    page?.ItemResponse ?? page?.itemResponse ?? page?.items ?? page?.elements ?? page?.list?.elements?.item ?? [];
  const items: CatalogIdentifier[] = list
    .map((it: any) => ({
      sku: String(it.sku ?? it.SKU ?? it.mart_sku ?? ""),
      productName: String(it.productName ?? it.product_name ?? it.name ?? ""),
      gtin: String(it.gtin ?? it.GTIN ?? ""),
      upc: String(
        it.upc ?? it.UPC ?? it.productIdentifiers?.find?.((p: any) => p.productIdType === "UPC")?.productId ?? ""
      ),
    }))
    .filter((i) => i.sku);
  const totalCount: number | null =
    page?.totalItems ?? page?.totalCount ?? page?.meta?.totalCount ?? page?.list?.meta?.totalCount ?? null;
  let nextCursor: string | null =
    page?.nextCursor ?? page?.meta?.nextCursor ?? page?.list?.meta?.nextCursor ?? null;
  if (nextCursor === "*" || nextCursor === "" || nextCursor === cursor) nextCursor = null;
  let nextLifecycle: Lifecycle | null = null;
  if (!nextCursor) {
    const idx = LIFECYCLE_ORDER.indexOf(lifecycle);
    nextLifecycle = LIFECYCLE_ORDER[idx + 1] ?? null;
  }
  console.log(
    `[WFS:catalog-sync] lifecycle=${lifecycle} cursorIn=${cursor.slice(0, 20)} returned ${items.length}, nextCursor=${nextCursor ? "yes" : "no"}`
  );
  return { items, nextCursor, totalCount, lifecycle, nextLifecycle };
}

