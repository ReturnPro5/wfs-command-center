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
import { classifySds } from "@/lib/sdsClassifier";
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
export type FulfillmentType =
  | "Walmart Fulfilled"
  | "Seller Fulfilled (WFS Eligible)"
  | "Seller Fulfilled"
  | "Unknown";

export interface CatalogIdentifier {
  sku: string;
  productName: string;
  gtin: string;
  upc: string;
  lifecycle?: "ACTIVE" | "ARCHIVED" | "RETIRED" | string;
  condition?: string;
  publishedStatus?: string;
  fulfillment?: FulfillmentType | string;
  category?: string;
  brand?: string;
  mainImageUrl?: string;
  price?: number | null;
  productType?: string;
  enrichmentStatus?: "pending" | "partial" | "enriched" | "error" | string;
  enrichedAt?: string | null;
}

// Rich row extracted from Walmart Item Report v4. The report has Brand,
// Product Image URL, Price, and Product Type alongside the fulfillment
// label, so we capture them here and merge them into catalog_items during
// sync — the user only needs to supply dimensions + country of origin.
export interface ItemReportRow {
  fulfillment: FulfillmentType | null;
  brand?: string;
  mainImageUrl?: string;
  price?: number | null;
  currency?: string;
  productType?: string;
  productName?: string;
  gtin?: string;
  upc?: string;
}



// Derive fulfillment label from Walmart data.
// Priority order:
// 1) WFS inventory membership by SKU → item is actively Walmart-fulfilled.
// 2) /v3/items fulfillment fields when present.
// 3) If we know the SKU is not in WFS inventory, classify as seller-fulfilled.
function deriveFulfillment(
  it: any,
  wfsSkuSet?: Set<string>,
  itemReportRows?: Map<string, ItemReportRow>
): FulfillmentType {
  const sku = String(it?.sku ?? it?.SKU ?? it?.mart_sku ?? "");
  const reported = sku ? itemReportRows?.get(sku)?.fulfillment : undefined;
  if (reported) return reported;


  const ship = String(
    it?.shippingProgramType ?? it?.shipping_program_type ?? it?.fulfillmentProgramType ?? ""
  ).toUpperCase();

  // Walmart returns WFS-eligibility under a half-dozen different field names
  // depending on endpoint version. Check them all.
  const eligibilityCandidates = [
    it?.wfsEnabled,
    it?.wfs_enabled,
    it?.isWfsEnabled,
    it?.wfsEligible,
    it?.wfs_eligible,
    it?.isWfsEligible,
    it?.eligibleForWfs,
    it?.wfsEligibility,
    it?.wfsStatus,
    it?.wfs?.eligible,
    it?.wfs?.status,
    it?.fulfillmentEligibility?.wfs,
    it?.additionalAttributes?.wfsEligible,
    it?.additionalAttributes?.wfsEnabled,
  ];
  const isTruthy = (v: unknown) =>
    v === true ||
    ["true", "yes", "y", "eligible", "enabled", "active"].includes(String(v).toLowerCase());
  const wfsEligible = eligibilityCandidates.some(isTruthy);
  const wfsEligibilityProvided = eligibilityCandidates.some((v) => v !== undefined && v !== null && v !== "");

  if (sku && wfsSkuSet?.has(sku)) return "Walmart Fulfilled";
  if (ship.includes("WFS")) return "Walmart Fulfilled";
  if (wfsEligible) return "Seller Fulfilled (WFS Eligible)";
  if (sku && wfsSkuSet && !wfsSkuSet.has(sku)) return "Seller Fulfilled";
  if (ship || wfsEligibilityProvided) return "Seller Fulfilled";
  return "Unknown";
}

async function getWfsFulfilledSkuSet(): Promise<Set<string>> {
  const inventory = await fetchAllInventory();
  return new Set(inventory.map((item) => item.sku).filter(Boolean));
}

const FULFILLMENT_REPORT_CACHE_TTL_MS = 2 * 60 * 1000;
let fulfillmentReportCache: { ts: number; promise: Promise<Map<string, ItemReportRow>> } | null = null;

let fulfillmentReportRequest: { ts: number; requestId: string } | null = null;

function normalizeFulfillmentType(value: unknown): FulfillmentType | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("wfs") && v.includes("eligible")) return "Seller Fulfilled (WFS Eligible)";
  if (v.includes("walmart") && v.includes("fulfilled")) return "Walmart Fulfilled";
  if (v.includes("seller") && v.includes("fulfilled")) return "Seller Fulfilled";
  return null;
}

function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const pipes = (firstLine.match(/\|/g) ?? []).length;
  if (tabs >= commas && tabs >= pipes && tabs > 0) return "\t";
  if (pipes > commas && pipes > 0) return "|";
  return ",";
}

// Column-name lookups for Walmart's Item Report v4. Headers are normalized
// to lowercase alphanumeric, so "Product Image URL" → "productimageurl".
const COL_ALIASES = {
  sku: ["sku", "sellersku", "merchantsku"],
  fulfillment: [
    "fulfillmenttype", "fulfillment", "wfsstatus", "wfseligibility", "shippingprogramtype",
  ],
  brand: ["brand", "brandname"],
  image: ["productimageurl", "primaryimageurl", "imageurl", "mainimageurl", "productimage"],
  price: ["price", "listprice", "yourprice", "currentprice"],
  currency: ["currency", "currencycode"],
  productType: ["producttype", "productcategory", "primarycategory"],
  productName: ["productname", "itemname", "title"],
  gtin: ["gtin"],
  upc: ["upc", "productid"],
} as const;

const REPORT_DETAIL_FIELDS: Array<keyof ItemReportRow> = [
  "brand",
  "mainImageUrl",
  "price",
  "productType",
  "productName",
  "gtin",
  "upc",
];

function mergeReportRows(base: ItemReportRow | undefined, next: ItemReportRow): ItemReportRow {
  if (!base) return next;
  const merged: ItemReportRow = { ...base };
  if (!merged.fulfillment && next.fulfillment) merged.fulfillment = next.fulfillment;
  for (const field of REPORT_DETAIL_FIELDS) {
    if ((merged[field] === undefined || merged[field] === null || merged[field] === "") && next[field] != null && next[field] !== "") {
      (merged as any)[field] = next[field];
    }
  }
  return merged;
}

function getItemImageUrl(it: any, report?: ItemReportRow): string | undefined {
  return String(
    report?.mainImageUrl ??
      it?.mainImageUrl ??
      it?.main_image_url ??
      it?.primaryImageUrl ??
      it?.primaryImageURL ??
      it?.productImageUrl ??
      it?.productMainImageUrl ??
      it?.imageUrl ??
      it?.imageURL ??
      it?.PrimaryImageURL ??
      it?.productSecondaryImageURL ??
      (Array.isArray(it?.images) ? (it.images[0]?.url ?? it.images[0]?.imageUrl ?? it.images[0]) : "") ??
      (Array.isArray(it?.productImages) ? (it.productImages[0]?.url ?? it.productImages[0]?.imageUrl ?? it.productImages[0]) : "") ??
      ""
  ).trim() || undefined;
}

function findCol(header: string[], aliases: readonly string[]): number {
  for (const a of aliases) {
    const i = header.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

function buildReportRow(
  row: string[],
  idx: Record<keyof typeof COL_ALIASES, number>,
): { sku: string; data: ItemReportRow } | null {
  const sku = row[idx.sku]?.trim();
  if (!sku) return null;
  const priceRaw = idx.price >= 0 ? row[idx.price]?.replace(/[^0-9.\-]/g, "") : "";
  const price = priceRaw ? Number(priceRaw) : null;
  const data: ItemReportRow = {
    fulfillment: idx.fulfillment >= 0 ? normalizeFulfillmentType(row[idx.fulfillment]) : null,
    brand: idx.brand >= 0 ? row[idx.brand]?.trim() || undefined : undefined,
    mainImageUrl: idx.image >= 0 ? row[idx.image]?.trim() || undefined : undefined,
    price: Number.isFinite(price as number) ? (price as number) : null,
    currency: idx.currency >= 0 ? row[idx.currency]?.trim() || undefined : undefined,
    productType: idx.productType >= 0 ? row[idx.productType]?.trim() || undefined : undefined,
    productName: idx.productName >= 0 ? row[idx.productName]?.trim() || undefined : undefined,
    gtin: idx.gtin >= 0 ? row[idx.gtin]?.trim() || undefined : undefined,
    upc: idx.upc >= 0 ? row[idx.upc]?.replace(/[^0-9]/g, "") || undefined : undefined,
  };
  return { sku, data };
}

function indexHeader(header: string[]): Record<keyof typeof COL_ALIASES, number> {
  return {
    sku: findCol(header, COL_ALIASES.sku),
    fulfillment: findCol(header, COL_ALIASES.fulfillment),
    brand: findCol(header, COL_ALIASES.brand),
    image: findCol(header, COL_ALIASES.image),
    price: findCol(header, COL_ALIASES.price),
    currency: findCol(header, COL_ALIASES.currency),
    productType: findCol(header, COL_ALIASES.productType),
    productName: findCol(header, COL_ALIASES.productName),
    gtin: findCol(header, COL_ALIASES.gtin),
    upc: findCol(header, COL_ALIASES.upc),
  };
}

function parseFulfillmentReport(csv: string): Map<string, ItemReportRow> {
  const delimiter = detectDelimiter(csv);
  const rows = parseCsv(csv, delimiter);
  const header = rows[0]?.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "")) ?? [];
  const idx = indexHeader(header);
  const map = new Map<string, ItemReportRow>();
  if (idx.sku < 0) {
    console.warn(`[WFS:catalog] item report header missing sku column. header=${header.slice(0, 30).join("|")}`);
    return map;
  }
  for (const row of rows.slice(1)) {
    const entry = buildReportRow(row, idx);
    if (entry) map.set(entry.sku, mergeReportRows(map.get(entry.sku), entry.data));
  }
  return map;
}

function createFulfillmentReportParser() {
  const map = new Map<string, ItemReportRow>();
  let buffer = "";
  let delimiter = ",";
  let idx: Record<keyof typeof COL_ALIASES, number> | null = null;
  let headerParsed = false;

  function ingestLine(rawLine: string) {
    const line = rawLine.replace(/\r$/, "").replace(/^\uFEFF/, "");
    if (!line) return;
    if (!headerParsed) {
      delimiter = detectDelimiter(line);
      const header = parseCsvLine(line, delimiter).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
      const shiftedHeader = header.some((h, i) => h !== (header[i - 1] ?? "") && header.indexOf(h) !== i);
      idx = indexHeader(header);
      headerParsed = true;
      if (idx.sku < 0) {
        console.warn(`[WFS:catalog] item report header missing sku column. header=${header.slice(0, 30).join("|")}`);
      } else if (shiftedHeader) {
        console.warn(`[WFS:catalog] item report header has duplicate names; CSV may be malformed. header=${header.slice(0, 55).join("|")}`);
      } else {
        console.log(`[WFS:catalog] item report cols sku=${idx.sku} fulfillment=${idx.fulfillment} brand=${idx.brand} image=${idx.image} price=${idx.price} productType=${idx.productType}`);
      }
      return;
    }
    if (!idx || idx.sku < 0) return;
    const row = parseCsvLine(line, delimiter);
    const entry = buildReportRow(row, idx);
    if (entry) map.set(entry.sku, mergeReportRows(map.get(entry.sku), entry.data));
  }

  return {
    push(text: string, final = false) {
      buffer += text;
      const lines = buffer.split("\n");
      const tail = lines.pop() ?? "";
      buffer = final ? "" : tail;
      for (const line of lines) ingestLine(line);
      if (final && tail) ingestLine(tail);
    },
    map,
  };
}

async function parseFulfillmentReportFile(bytes: Uint8Array, contentType: string): Promise<Map<string, ItemReportRow>> {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) {
    return parseFulfillmentReport(new TextDecoder().decode(bytes));
  }

  const { Unzip, UnzipInflate, DecodeUTF8 } = await import("fflate");
  const parser = createFulfillmentReportParser();
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  let selected = false;
  let streamError: Error | null = null;

  unzipper.onfile = (file) => {
    if (selected) return;
    if (!/\.(csv|tsv|txt)$/i.test(file.name) && file.name) return;
    selected = true;
    const decoder = new DecodeUTF8((text, final) => parser.push(text, final));
    file.ondata = (err, data, final) => {
      if (err) {
        streamError = err;
        return;
      }
      decoder.push(data, final);
    };
    file.start();
  };

  unzipper.push(bytes, true);
  if (streamError) throw streamError;
  if (!selected) throw new Error(`report zip did not contain a text file (${contentType || "unknown content type"})`);
  return parser.map;
}



function getReportRequestId(payload: any): string | null {
  return String(
    payload?.requestId ??
      payload?.requestID ??
      payload?.id ??
      payload?.payload?.requestId ??
      payload?.payload?.requestID ??
      ""
  ) || null;
}

function getReadyReportRequestId(payload: any): string | null {
  const list =
    payload?.requests ??
    payload?.reportRequests ??
    payload?.payload?.requests ??
    payload?.payload?.reportRequests ??
    payload?.payload?.reportRequest ??
    payload?.elements ??
    [];
  const rows = Array.isArray(list) ? list : [list].filter(Boolean);
  const readyRows = rows.filter((row) => {
    const status = String(row?.status ?? row?.requestStatus ?? "").toUpperCase();
    return /READY|COMPLETE|COMPLETED|DONE|SUCCESS/.test(status) && getReportRequestId(row);
  });
  const preferred =
    readyRows.find((row) => String(row?.reportVersion ?? "").toLowerCase() === "v6") ??
    readyRows.find((row) => /scheduler|sc/i.test(String(row?.src ?? ""))) ??
    readyRows[0];
  if (preferred) {
    const id = getReportRequestId(preferred);
    if (id) return id;
  }
  return null;
}

async function getItemReportFulfillmentMap(): Promise<Map<string, ItemReportRow>> {
  if (fulfillmentReportCache && Date.now() - fulfillmentReportCache.ts < FULFILLMENT_REPORT_CACHE_TTL_MS) {
    return fulfillmentReportCache.promise;
  }

  const promise = (async (): Promise<Map<string, ItemReportRow>> => {
    try {
      if (!fulfillmentReportRequest || Date.now() - fulfillmentReportRequest.ts > FULFILLMENT_REPORT_CACHE_TTL_MS) {
        let requestId: string | null = null;
        try {
          requestId = getReadyReportRequestId(await walmartApi.listItemReportRequests());
        } catch (err) {
          console.warn("[WFS:catalog] item report list unavailable", err instanceof Error ? err.message : err);
        }
        if (!requestId) {
          const request = await walmartApi.createItemReportRequest();
          requestId = getReportRequestId(request);
        }
        if (!requestId) throw new Error(`missing requestId in item report response`);
        fulfillmentReportRequest = { ts: Date.now(), requestId };
      }
      const requestId = fulfillmentReportRequest.requestId;

      const lastStatus = await walmartApi.getReportRequestStatus(requestId);
      const rawStatus = String(
        lastStatus?.status ??
          lastStatus?.requestStatus ??
          lastStatus?.payload?.status ??
          lastStatus?.payload?.requestStatus ??
          ""
      ).toUpperCase();
      if (/FAIL|FAILED|ERROR/.test(rawStatus)) throw new Error(`item report status ${rawStatus}`);
      if (!/READY|COMPLETE|COMPLETED|DONE|SUCCESS/.test(rawStatus)) {
        throw new Error(`item report is ${rawStatus || "not ready"}`);
      }

      const downloaded = await walmartApi.downloadReportFile(requestId);
      const map = await parseFulfillmentReportFile(downloaded.bytes, downloaded.contentType);
      if (map.size === 0) throw new Error("item report did not include any rows");
      const withBrand = Array.from(map.values()).filter((r) => r.brand).length;
      const withImage = Array.from(map.values()).filter((r) => r.mainImageUrl).length;
      console.log(`[WFS:catalog] item report rows=${map.size} brand=${withBrand} image=${withImage}`);
      fulfillmentReportRequest = null;
      return map;
    } catch (err) {
      console.warn("[WFS:catalog] item report unavailable; falling back to Items/WFS Inventory fields", err instanceof Error ? err.message : err);
      return new Map<string, ItemReportRow>();
    }
  })();

  fulfillmentReportCache = { ts: Date.now(), promise };
  promise.catch(() => { fulfillmentReportCache = null; });
  return promise;
}


export interface CatalogPage {
  items: CatalogIdentifier[];
  nextCursor: string | null;
  totalCount: number | null;
  lifecycle: "ACTIVE" | "ARCHIVED" | "RETIRED";
  nextLifecycle: "ACTIVE" | "ARCHIVED" | "RETIRED" | null;
  publishedStatus: string;
}

// Only sync ACTIVE + PUBLISHED items (~9k expected).
const LIFECYCLE_ORDER: Array<"ACTIVE" | "ARCHIVED" | "RETIRED"> = ["ACTIVE"];
const PUBLISHED_STATUS_ORDER: string[] = ["PUBLISHED"];

// Walmart's /v3/items uses cursor-based pagination. Offset is capped at 10,000.
// You must pass `nextCursor=*` on the first call to opt into cursor mode and
// receive a real `nextCursor` back in the response.
export const getCatalogPage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        cursor: z.string().nullable().optional(),
        lifecycle: z.enum(["ACTIVE", "ARCHIVED", "RETIRED"]).optional(),
        publishedStatus: z.string().optional(),
      })
      .parse(data)
  )
  .handler(async ({ data }): Promise<CatalogPage> => {
    await getWalmartAccessToken();
    const [wfsSkuSet, itemReportFulfillment] = await Promise.all([
      getWfsFulfilledSkuSet(),
      getItemReportFulfillmentMap(),
    ]);
    const lifecycle = data.lifecycle ?? "ACTIVE";
    const publishedStatus = data.publishedStatus ?? "PUBLISHED";
    const cursor = data.cursor ?? "*"; // "*" = first page in cursor mode

    let raw: any;
    try {
      raw = await walmartApi.getItems(cursor, lifecycle, publishedStatus);
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
          publishedStatus,
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

    if (list[0]) {
      const sample = list[0];
      console.log(
        `[WFS:catalog] sample item keys=${Object.keys(sample).join(",")} | wfs-like fields=` +
          JSON.stringify({
            shippingProgramType: sample.shippingProgramType,
            fulfillmentProgramType: sample.fulfillmentProgramType,
            wfsEnabled: sample.wfsEnabled,
            wfsEligible: sample.wfsEligible,
            eligibleForWfs: sample.eligibleForWfs,
            wfsEligibility: sample.wfsEligibility,
            wfsStatus: sample.wfsStatus,
            wfs: sample.wfs,
            fulfillmentEligibility: sample.fulfillmentEligibility,
            additionalAttributes: sample.additionalAttributes,
          })
      );
    }

    const items: CatalogIdentifier[] = list
      .map((it: any) => {
        const sku = String(it.sku ?? it.SKU ?? it.mart_sku ?? "");
        const report = sku ? itemReportFulfillment.get(sku) : undefined;
        return {
          sku,
          productName: String(it.productName ?? it.product_name ?? it.name ?? report?.productName ?? ""),
          gtin: String(it.gtin ?? it.GTIN ?? report?.gtin ?? ""),
          upc: String(
            it.upc ??
              it.UPC ??
              it.productIdentifiers?.find?.((p: any) => p.productIdType === "UPC")?.productId ??
              report?.upc ??
              ""
          ),
          condition: String(it.condition ?? it.itemCondition ?? "New"),
          publishedStatus: String(it.publishedStatus ?? it.published_status ?? ""),
          fulfillment: deriveFulfillment(it, wfsSkuSet, itemReportFulfillment),
          brand: report?.brand,
          mainImageUrl: getItemImageUrl(it, report),
          price: report?.price ?? null,
          productType: report?.productType,
        };
      })
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
    // Walmart may repeat the same cursor token across many pages while still
    // returning new results, so only treat truly empty cursors as terminal.
    if (nextCursor === "*" || nextCursor === "") {
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

    return { items, nextCursor, totalCount, lifecycle, nextLifecycle, publishedStatus };
  });

// ─── Cached Catalog (persisted in DB) ───────────────────

export interface CatalogSyncState {
  cursor: string | null;
  lifecycle: Lifecycle;
  published_status: string;
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
    const PAGE = 1000;
    let from = 0;
    const items: CatalogIdentifier[] = [];
    while (true) {
      const { data, error } = await supabaseAdmin
        .from("catalog_items")
        .select("sku, product_name, gtin, upc, lifecycle, condition, published_status, fulfillment, category, brand, main_image_url, price, product_type, enrichment_status, enriched_at")
        .order("sku", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`catalog cache read failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as any[]) {
        // Walmart's items API rarely returns `category` for seller-fulfilled
        // SKUs but does populate `productType` — fall back so the category
        // filter actually buckets items instead of collapsing everything to
        // "Uncategorized".
        const cat = (r.category && String(r.category).trim()) || (r.product_type && String(r.product_type).trim()) || "";
        items.push({
          sku: r.sku,
          productName: r.product_name ?? "",
          gtin: r.gtin ?? "",
          upc: r.upc ?? "",
          lifecycle: r.lifecycle ?? "",
          condition: r.condition ?? "",
          publishedStatus: r.published_status ?? "",
          fulfillment: r.fulfillment ?? "Unknown",
          category: cat,
          brand: r.brand ?? "",
          mainImageUrl: r.main_image_url ?? "",
          price: typeof r.price === "number" ? r.price : r.price == null ? null : Number(r.price),
          productType: r.product_type ?? "",
          enrichmentStatus: r.enrichment_status ?? "pending",
          enrichedAt: r.enriched_at ?? null,
        });
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
   estimatedTotal: number | null;
   currentFilters: {
    lifecycle: Lifecycle;
    publishedStatus: string;
   };
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
    let publishedStatus: string = stateRow.published_status ?? "PUBLISHED";
    let pagesThisRun = stateRow.pages_this_run ?? 0;
    let itemsThisRun = stateRow.items_this_run ?? 0;

    // Every sync starts fresh: drop the cache and re-pull from Walmart.
    // Resume only happens mid-run (status === "running").
    const startingFresh = data.reset || stateRow.status !== "running";

    if (startingFresh) {
      const { error: clearErr } = await supabaseAdmin
        .from("catalog_items")
        .delete()
        .neq("sku", "");
      if (clearErr) throw new Error(`catalog reset failed: ${clearErr.message}`);

      cursor = null;
      lifecycle = "ACTIVE";
      publishedStatus = "PUBLISHED";
      pagesThisRun = 0;
      itemsThisRun = 0;
    }

    // Fetch one page from Walmart
    const page = await getCatalogPageInternal(cursor, lifecycle, publishedStatus);

    // Upsert items
    let added = 0;
    let updated = 0;
    if (page.items.length) {
      const now = new Date().toISOString();
      const skus = page.items.map((i) => i.sku);
      const { data: existing } = await supabaseAdmin
        .from("catalog_items")
        .select("sku")
        .in("sku", skus);
      const existingSet = new Set((existing ?? []).map((r: any) => r.sku));
      added = skus.filter((s) => !existingSet.has(s)).length;
      updated = skus.length - added;

      const rows = page.items.map((it) => {
        const row: any = {
          sku: it.sku,
          product_name: it.productName,
          gtin: it.gtin,
          upc: it.upc,
          lifecycle: page.lifecycle,
          condition: it.condition ?? "New",
          published_status: it.publishedStatus ?? publishedStatus,
          fulfillment: it.fulfillment ?? "Unknown",
          category: it.category ?? it.productType ?? "",
          last_seen_at: now,
          last_synced_at: now,
        };
        // Fields auto-populated from the Walmart Item Report v4. Always
        // include with safe defaults so batched upserts have a uniform
        // column set (Postgres NOT NULL columns reject undefined→null).
        row.brand = it.brand ?? "";
        row.main_image_url = it.mainImageUrl ?? "";
        if (typeof it.price === "number" && Number.isFinite(it.price)) row.price = it.price;
        row.product_type = it.productType ?? "";

        return row;
      });

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error: upErr } = await supabaseAdmin
          .from("catalog_items")
          .upsert(slice as any, { onConflict: "sku", ignoreDuplicates: false });
        if (upErr) throw new Error(`catalog upsert failed: ${upErr.message}`);
      }
    }

    // Compute next state — walk cursor → publishedStatus → lifecycle
    let nextCursor: string | null = page.nextCursor;
    let nextLifecycle: Lifecycle = lifecycle;
    let nextPublished: string = publishedStatus;
    let done = false;

    if (nextCursor) {
      // More pages in current bucket
      nextLifecycle = lifecycle;
      nextPublished = publishedStatus;
    } else if (page.nextLifecycle) {
      // Bucket exhausted, but more lifecycles to walk
      nextLifecycle = page.nextLifecycle;
      nextPublished = page.publishedStatus;
    } else if (page.publishedStatus !== publishedStatus) {
      // Bucket exhausted, same lifecycle, next publishedStatus
      nextLifecycle = lifecycle;
      nextPublished = page.publishedStatus;
    } else {
      done = true;
    }

    pagesThisRun += 1;
    itemsThisRun += page.items.length;

    const nowIso = new Date().toISOString();
    const update: any = {
      cursor: done ? null : nextCursor,
      lifecycle: done ? "ACTIVE" : nextLifecycle,
      published_status: done ? "PUBLISHED" : nextPublished,
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
      estimatedTotal: page.totalCount,
      currentFilters: {
        lifecycle,
        publishedStatus,
      },
      done,
      state: newState as CatalogSyncState,
    };
  });

// ─── Backfill Unknown Fulfillment ───────────────────────
// Re-queries Walmart for only the SKUs currently flagged "Unknown" fulfillment
// and updates them in place — no full re-sync needed.
export interface BackfillFulfillmentResult {
  processed: number;
  updated: number;
  stillUnknown: number;
  remaining: number;
  done: boolean;
}

export const backfillUnknownFulfillment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        batchSize: z.number().int().min(1).max(200).optional(),
        afterSku: z.string().optional(),
      })
      .parse(data ?? {})
  )
  .handler(async ({ data }): Promise<BackfillFulfillmentResult & { nextAfterSku: string | null }> => {
    const batchSize = data.batchSize ?? 40;
    await getWalmartAccessToken();
    const [wfsSkuSet, itemReportFulfillment] = await Promise.all([
      getWfsFulfilledSkuSet(),
      getItemReportFulfillmentMap(),
    ]);

    // Walk Unknown rows by sku cursor so each SKU is touched at most once per run,
    // even if the update leaves it as "Unknown" (otherwise we'd re-fetch forever).
    let query = supabaseAdmin
      .from("catalog_items")
      .select("sku")
      .eq("fulfillment", "Unknown")
      .order("sku", { ascending: true })
      .limit(batchSize);
    if (data.afterSku) query = query.gt("sku", data.afterSku);

    const { data: rows, error } = await query;
    if (error) throw new Error(`backfill read failed: ${error.message}`);
    const skus = (rows ?? []).map((r: any) => r.sku);

    let updated = 0;
    let stillUnknown = 0;
    const now = new Date().toISOString();

    const CONCURRENCY = 4;
    let idx = 0;
    async function worker() {
      while (idx < skus.length) {
        const i = idx++;
        const sku = skus[i];
        try {
          const raw = await walmartApi.getItem(sku);
          const payload = (raw as any)?.payload ?? raw;
          const candidate =
            (Array.isArray(payload?.ItemResponse) ? payload.ItemResponse[0] : payload?.ItemResponse) ??
            (Array.isArray(payload?.itemResponse) ? payload.itemResponse[0] : payload?.itemResponse) ??
            (Array.isArray(payload?.items) ? payload.items[0] : payload?.items) ??
            payload;
          const fulfillment = deriveFulfillment(candidate, wfsSkuSet, itemReportFulfillment);
          const { error: uErr } = await supabaseAdmin
            .from("catalog_items")
            .update({ fulfillment, last_synced_at: now })
            .eq("sku", sku);
          if (uErr) {
            console.warn(`[WFS:backfill] update failed sku=${sku}: ${uErr.message}`);
            stillUnknown++;
            continue;
          }
          if (fulfillment === "Unknown") stillUnknown++;
          else updated++;
        } catch (e) {
          console.warn(`[WFS:backfill] fetch failed sku=${sku}:`, (e as Error).message);
          stillUnknown++;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, skus.length)) }, worker)
    );

    const { count } = await supabaseAdmin
      .from("catalog_items")
      .select("sku", { count: "exact", head: true })
      .eq("fulfillment", "Unknown");

    const remaining = count ?? 0;
    const nextAfterSku = skus.length > 0 ? skus[skus.length - 1] : null;
    return {
      processed: skus.length,
      updated,
      stillUnknown,
      remaining,
      // Stop when this batch returned fewer rows than requested — we've reached the end.
      done: skus.length < batchSize,
      nextAfterSku,
    };
  });

// Internal helper that mirrors getCatalogPage handler logic without the server-fn wrapper.
// Walks both lifecycleStatus AND publishedStatus so the full catalog is captured.
async function getCatalogPageInternal(
  cursorIn: string | null,
  lifecycle: Lifecycle,
  publishedStatus: string = "PUBLISHED"
): Promise<CatalogPage> {
  await getWalmartAccessToken();
  const [wfsSkuSet, itemReportFulfillment] = await Promise.all([
    getWfsFulfilledSkuSet(),
    getItemReportFulfillmentMap(),
  ]);
  const cursor = cursorIn ?? "*";

  const pubIdx = PUBLISHED_STATUS_ORDER.indexOf(publishedStatus);
  const nextPublished = PUBLISHED_STATUS_ORDER[pubIdx + 1];
  const lifecycleIdx = LIFECYCLE_ORDER.indexOf(lifecycle);
  const nextLifecycleFinal = LIFECYCLE_ORDER[lifecycleIdx + 1] ?? null;

  let raw: any;
  try {
    raw = await walmartApi.getItems(cursor, lifecycle, publishedStatus);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("[404]") || msg.includes("CONTENT_NOT_FOUND")) {
      // Empty bucket — advance to next publishedStatus (or next lifecycle if exhausted)
      return {
        items: [],
        nextCursor: null,
        totalCount: null,
        lifecycle,
        nextLifecycle: nextPublished ? lifecycle : nextLifecycleFinal,
        publishedStatus: nextPublished ?? "PUBLISHED",
      };
    }
    throw err;
  }
  const page = (raw as any)?.payload ?? raw;
  const list: any[] =
    page?.ItemResponse ?? page?.itemResponse ?? page?.items ?? page?.elements ?? page?.list?.elements?.item ?? [];
  const items: CatalogIdentifier[] = list
    .map((it: any) => {
      const sku = String(it.sku ?? it.SKU ?? it.mart_sku ?? "");
      const report = sku ? itemReportFulfillment.get(sku) : undefined;
      return {
        sku,
        productName: String(it.productName ?? it.product_name ?? it.name ?? report?.productName ?? ""),
        gtin: String(it.gtin ?? it.GTIN ?? report?.gtin ?? ""),
        upc: String(
          it.upc ?? it.UPC ?? it.productIdentifiers?.find?.((p: any) => p.productIdType === "UPC")?.productId ?? report?.upc ?? ""
        ),
        condition: String(it.condition ?? it.itemCondition ?? "New"),
        publishedStatus: String(it.publishedStatus ?? it.published_status ?? publishedStatus),
        fulfillment: deriveFulfillment(it, wfsSkuSet, itemReportFulfillment),
        category: String(it.category ?? it.productType ?? it.primaryCategory ?? report?.productType ?? ""),
        brand: report?.brand,
        mainImageUrl: getItemImageUrl(it, report),
        price: report?.price ?? null,
        productType: report?.productType,
      };
    })
    .filter((i) => i.sku);
  const totalCount: number | null =
    page?.totalItems ?? page?.totalCount ?? page?.meta?.totalCount ?? page?.list?.meta?.totalCount ?? null;
  let nextCursor: string | null =
    page?.nextCursor ?? page?.meta?.nextCursor ?? page?.list?.meta?.nextCursor ?? null;
  if (nextCursor === "*" || nextCursor === "") nextCursor = null;

  // Determine what's next: more cursor pages → same bucket; else next publishedStatus; else next lifecycle.
  let nextLifecycle: Lifecycle | null = lifecycle;
  let nextPub = publishedStatus;
  if (!nextCursor) {
    if (nextPublished) {
      nextPub = nextPublished;
      nextLifecycle = lifecycle;
    } else {
      nextLifecycle = nextLifecycleFinal;
      nextPub = "PUBLISHED";
    }
  }

  console.log(
    `[WFS:catalog-sync] lifecycle=${lifecycle} pub=${publishedStatus} cursorIn=${cursor.slice(0, 20)} returned ${items.length}, nextCursor=${nextCursor ? "yes" : "no"}, nextPub=${nextPub}, nextLifecycle=${nextLifecycle}`
  );
  return {
    items,
    nextCursor,
    totalCount,
    lifecycle,
    nextLifecycle: nextCursor ? null : nextLifecycle,
    publishedStatus: nextPub,
  };
}


// ─── Country of Origin normalizer ────────────────────────
// Walmart requires "CC - Country Name" format, not bare country names.
const COUNTRY_MAP: Record<string, string> = {
  "china": "CN - China", "cn": "CN - China",
  "united states": "US - United States", "us": "US - United States", "usa": "US - United States",
  "india": "IN - India", "in": "IN - India",
  "mexico": "MX - Mexico", "mx": "MX - Mexico",
  "japan": "JP - Japan", "jp": "JP - Japan",
  "germany": "DE - Germany", "de": "DE - Germany",
  "united kingdom": "GB - United Kingdom", "gb": "GB - United Kingdom", "uk": "GB - United Kingdom",
  "france": "FR - France", "fr": "FR - France",
  "italy": "IT - Italy", "it": "IT - Italy",
  "canada": "CA - Canada", "ca": "CA - Canada",
  "south korea": "KR - Korea, South", "korea": "KR - Korea, South", "kr": "KR - Korea, South",
  "taiwan": "TW - Taiwan", "tw": "TW - Taiwan",
  "vietnam": "VN - Vietnam", "vn": "VN - Vietnam",
  "thailand": "TH - Thailand", "th": "TH - Thailand",
  "indonesia": "ID - Indonesia", "id": "ID - Indonesia",
  "malaysia": "MY - Malaysia", "my": "MY - Malaysia",
  "philippines": "PH - Philippines", "ph": "PH - Philippines",
  "brazil": "BR - Brazil", "br": "BR - Brazil",
  "turkey": "TR - Turkey", "tr": "TR - Turkey",
  "poland": "PL - Poland", "pl": "PL - Poland",
  "spain": "ES - Spain", "es": "ES - Spain",
  "netherlands": "NL - Netherlands", "nl": "NL - Netherlands",
  "australia": "AU - Australia", "au": "AU - Australia",
  "bangladesh": "BD - Bangladesh", "bd": "BD - Bangladesh",
  "pakistan": "PK - Pakistan", "pk": "PK - Pakistan",
  "cambodia": "KH - Cambodia", "kh": "KH - Cambodia",
  "sri lanka": "LK - Sri Lanka", "lk": "LK - Sri Lanka",
  "singapore": "SG - Singapore", "sg": "SG - Singapore",
  "hong kong": "HK - Hong Kong", "hk": "HK - Hong Kong",
  "switzerland": "CH - Switzerland", "ch": "CH - Switzerland",
  "sweden": "SE - Sweden", "se": "SE - Sweden",
  "ireland": "IE - Ireland", "ie": "IE - Ireland",
  "israel": "IL - Israel", "il": "IL - Israel",
  "egypt": "EG - Egypt", "eg": "EG - Egypt",
  "south africa": "ZA - South Africa", "za": "ZA - South Africa",
  "colombia": "CO - Colombia", "co": "CO - Colombia",
  "chile": "CL - Chile", "cl": "CL - Chile",
  "peru": "PE - Peru", "pe": "PE - Peru",
  "argentina": "AR - Argentina", "ar": "AR - Argentina",
  "portugal": "PT - Portugal", "pt": "PT - Portugal",
  "czech republic": "CZ - Czech Republic", "cz": "CZ - Czech Republic",
  "romania": "RO - Romania", "ro": "RO - Romania",
  "hungary": "HU - Hungary", "hu": "HU - Hungary",
  "austria": "AT - Austria", "at": "AT - Austria",
  "denmark": "DK - Denmark", "dk": "DK - Denmark",
  "finland": "FI - Finland", "fi": "FI - Finland",
  "norway": "NO - Norway", "no": "NO - Norway",
  "new zealand": "NZ - New Zealand", "nz": "NZ - New Zealand",
  "costa rica": "CR - Costa Rica", "cr": "CR - Costa Rica",
  "dominican republic": "DO - Dominican Republic", "do": "DO - Dominican Republic",
  "guatemala": "GT - Guatemala", "gt": "GT - Guatemala",
  "honduras": "HN - Honduras", "hn": "HN - Honduras",
  "el salvador": "SV - El Salvador", "sv": "SV - El Salvador",
  "nicaragua": "NI - Nicaragua", "ni": "NI - Nicaragua",
  "panama": "PA - Panama", "pa": "PA - Panama",
  "ecuador": "EC - Ecuador", "ec": "EC - Ecuador",
  "uruguay": "UY - Uruguay", "uy": "UY - Uruguay",
  "paraguay": "PY - Paraguay", "py": "PY - Paraguay",
  "bolivia": "BO - Bolivia", "bo": "BO - Bolivia",
  "venezuela": "VE - Venezuela", "ve": "VE - Venezuela",
  "puerto rico": "PR - Puerto Rico", "pr": "PR - Puerto Rico",
  "myanmar": "MM - Myanmar", "mm": "MM - Myanmar",
  "nepal": "NP - Nepal", "np": "NP - Nepal",
  "russia": "RU - Russian Federation", "ru": "RU - Russian Federation",
  "ukraine": "UA - Ukraine", "ua": "UA - Ukraine",
  "morocco": "MA - Morocco", "ma": "MA - Morocco",
  "nigeria": "NG - Nigeria", "ng": "NG - Nigeria",
  "kenya": "KE - Kenya", "ke": "KE - Kenya",
  "ethiopia": "ET - Ethiopia", "et": "ET - Ethiopia",
  "ghana": "GH - Ghana", "gh": "GH - Ghana",
  "tunisia": "TN - Tunisia", "tn": "TN - Tunisia",
  "jordan": "JO - Jordan", "jo": "JO - Jordan",
  "saudi arabia": "SA - Saudi Arabia", "sa": "SA - Saudi Arabia",
  "united arab emirates": "AE - United Arab Emirates", "ae": "AE - United Arab Emirates", "uae": "AE - United Arab Emirates",
  "qatar": "QA - Qatar", "qa": "QA - Qatar",
  "kuwait": "KW - Kuwait", "kw": "KW - Kuwait",
  "iraq": "IQ - Iraq", "iq": "IQ - Iraq",
  "iran": "IR - Iran", "ir": "IR - Iran",
  "greece": "GR - Greece", "gr": "GR - Greece",
  "belgium": "BE - Belgium", "be": "BE - Belgium",
  "luxembourg": "LU - Luxembourg", "lu": "LU - Luxembourg",
};

/** Convert bare country name/code to Walmart's "CC - Name" format */
function normalizeCountryOfOrigin(raw: string): string {
  const trimmed = raw.trim();
  // Already in "XX - Name" format
  if (/^[A-Z]{2}\s*-\s*.+/.test(trimmed)) return trimmed;
  const key = trimmed.toLowerCase();
  return COUNTRY_MAP[key] ?? trimmed;
}

// ─── Bulk WFS Conversion ────────────────────────────────
// Submits selected SKUs to Walmart via the WFS item feed.
// NOTE: Walmart's WFS feed typically requires additional attributes
// (weight, dimensions, hazmat flag, country of origin). The catalog cache
// only stores SKU + identifiers + product name, so first-pass submissions
// will likely return per-SKU validation errors for missing fields — those
// are surfaced verbatim back to the UI so you know what to fix.
export interface WfsConversionFailedItem {
  sku: string;
  status: string;
  reason: string;
}

export interface WfsConversionRunResult {
  runId: string;
  feedId: string | null;
  status: string;
  submittedCount: number;
  itemsReceived: number | null;
  itemsSucceeded: number | null;
  itemsFailed: number | null;
  successSkus: string[];
  failedItems: WfsConversionFailedItem[];
  ingestionErrors: Array<{ sku?: string; type?: string; description?: string }>;
  timedOut: boolean;
}

function genRequestId(): string {
  // RFC4122-ish v4 without crypto dep
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const submitWfsConversion = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        skus: z
          .array(z.string().min(1).max(50).regex(/^[\w.\-]+$/))
          .min(1)
          .max(500),
      })
      .parse(data)
  )
  .handler(async ({ data }): Promise<WfsConversionRunResult> => {
    // Walmart's "Convert Seller-Fulfilled item to WFS" uses feedType=OMNI_WFS
    // with the SupplierItem schema (v1.4). The payload requires a
    // SupplierItemFeedHeader carrying a SINGLE subCategory — every item in
    // one feed must share that subCategory — plus SupplierItem entries with
    // Visible/Orderable/TradeItem blocks. We group selected SKUs by
    // subCategory (derived from productType) and submit one feed per group,
    // aggregating per-SKU outcomes across all groups into one run record.
    const feedType = process.env.WALMART_WFS_FEED_TYPE || "OMNI_WFS";

    const { data: rows, error: readErr } = await supabaseAdmin
      .from("catalog_items")
      .select(
        "sku, product_name, gtin, upc, brand, manufacturer, main_image_url, price, currency, product_type, sub_category, country_of_origin, shipping_weight, shipping_weight_unit, shipping_length, shipping_width, shipping_height, shipping_dim_unit"
      )
      .in("sku", data.skus);
    if (readErr) throw new Error(`catalog lookup failed: ${readErr.message}`);

    const bySku = new Map<string, any>();
    for (const r of rows ?? []) bySku.set((r as any).sku, r);

    if (bySku.size === 0) {
      throw new Error("None of the selected SKUs were found in the cached catalog.");
    }

    // Preflight: drop any SKU that's missing data the OMNI_WFS schema
    // requires. Each dropped SKU is reported as a failed item with a
    // human-readable reason so the operator knows exactly which field to
    // fill via the Import CSV.
    const preflightFailed: WfsConversionFailedItem[] = [];
    type Ready = {
      r: any;
      subCategory: string;
      visibleKey: string;
      length: number;
      width: number;
      height: number;
      weight: number;
      isHazmat: boolean;
      gtin: string;
      brand: string;
      manufacturer: string;
    };

    const ready: Ready[] = [];

    const slug = (s: string) =>
      String(s ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    for (const sku of data.skus) {
      const r = bySku.get(sku);
      if (!r) {
        preflightFailed.push({
          sku,
          status: "MISSING",
          reason: "SKU not found in cached catalog — re-sync catalog first",
        });
        continue;
      }
      const length = Number(r.shipping_length ?? 0);
      const width = Number(r.shipping_width ?? 0);
      const height = Number(r.shipping_height ?? 0);
      const weight = Number(r.shipping_weight ?? 0);
      const missing: string[] = [];
      if (!(length > 0)) missing.push("length");
      if (!(width > 0)) missing.push("width");
      if (!(height > 0)) missing.push("height");
      if (!(weight > 0)) missing.push("weight");
      const brand = (r.brand ?? "").trim();
      // Manufacturer defaults to Brand when not separately provided —
      // Walmart accepts that and most sellers carry the same value.
      const manufacturer = (r.manufacturer ?? "").trim() || brand;
      if (!brand) missing.push("brand");
      if (!manufacturer) missing.push("manufacturer");
      if (!(r.main_image_url ?? "").trim()) missing.push("mainImageUrl");

      if (!(r.country_of_origin ?? "").trim()) missing.push("countryOfOrigin");
      if (!(r.product_type ?? "").trim()) missing.push("productType");
      if (r.price == null) missing.push("price");
      const gtin = String(r.gtin || r.upc || "").trim();
      if (!gtin) missing.push("gtin/upc");
      if (missing.length > 0) {
        preflightFailed.push({
          sku: r.sku,
          status: "MISSING_FIELDS",
          reason: `Missing required field(s): ${missing.join(", ")} — re-sync/re-enrich or fill via Import CSV`,
        });
        continue;
      }
      const sds = classifySds(r.product_name);
      const isHazmat = sds.requirement === "Likely required";
      const subCategory =
        slug(r.sub_category) || slug(r.product_type) || "general";
      const visibleKey = String(r.product_type).trim();
      ready.push({
        r,
        subCategory,
        visibleKey,
        length,
        width,
        height,
        weight,
        isHazmat,
        gtin,
        brand,
        manufacturer,
      });

    }

    // Group ready items by subCategory — Walmart accepts only ONE
    // subCategory per OMNI_WFS feed, so we fan out one submission per
    // group. Cap the fan-out at 10 distinct groups per run so a single
    // submit doesn't flood Walmart's feed queue.
    const groups = new Map<string, Ready[]>();
    for (const item of ready) {
      const list = groups.get(item.subCategory) ?? [];
      list.push(item);
      groups.set(item.subCategory, list);
    }
    const MAX_GROUPS = 10;
    if (groups.size > MAX_GROUPS) {
      const overflow: string[] = [];
      const sorted = Array.from(groups.entries()).sort(
        (a, b) => b[1].length - a[1].length
      );
      for (const [g] of sorted.slice(MAX_GROUPS)) overflow.push(g);
      for (const g of overflow) {
        for (const item of groups.get(g) ?? []) {
          preflightFailed.push({
            sku: item.r.sku,
            status: "DEFERRED",
            reason: `Skipped — selection spans ${groups.size} subCategories, only the largest ${MAX_GROUPS} were sent this run (subCategory=${g})`,
          });
        }
        groups.delete(g);
      }
    }

    const submittedCount = Array.from(groups.values()).reduce(
      (n, list) => n + list.length,
      0
    );

    const { data: runRow, error: insErr } = await supabaseAdmin
      .from("wfs_conversion_runs")
      .insert({
        sku_count: submittedCount,
        skus: Array.from(groups.values()).flat().map((i) => i.r.sku),
        status: submittedCount === 0 ? "no_eligible" : "submitting",
        response: {
          preflightFailed: preflightFailed as unknown as Record<string, unknown>[],
          subCategories: Array.from(groups.keys()),
        } as any,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(`conversion log insert failed: ${insErr.message}`);
    const runId = (runRow as any).id as string;

    if (submittedCount === 0) {
      return {
        runId,
        feedId: null,
        status: "no_eligible",
        submittedCount: 0,
        itemsReceived: null,
        itemsSucceeded: null,
        itemsFailed: preflightFailed.length,
        successSkus: [],
        failedItems: preflightFailed,
        ingestionErrors: [],
        timedOut: false,
      };
    }

    // Build one SupplierItem feed per subCategory and submit sequentially.
    const allFeedIds: string[] = [];
    const allSubmits: any[] = [];
    const allStatuses: any[] = [];
    const allSuccess: string[] = [];
    const allFailed: WfsConversionFailedItem[] = [];
    const allErrs: Array<{ sku?: string; type?: string; description?: string }> = [];
    let aggReceived = 0;
    let aggSucceeded = 0;
    let aggFailed = 0;
    let anyTimedOut = false;
    let lastStatus = "submitted";

    try {
      for (const [subCategory, items] of groups) {
        const supplierItems = items.map((it) => {
          const { r, gtin, isHazmat, length, width, height, weight, brand, manufacturer } = it;
          const img = String(r.main_image_url ?? "").trim();
          return {
            Visible: {
              [it.visibleKey]: {
                manufacturer,
                ...(img ? { mainImageUrl: img } : {}),
              },
            },
            Orderable: {
              sku: r.sku,
              productName: String(r.product_name).trim(),
              brand,

              productIdentifiers: {
                productId: gtin,
                productIdType: gtin.length === 12 ? "UPC" : "GTIN",
              },
              price: Number(r.price),
              startDate: new Date().toISOString(),
              endDate: "2040-01-01T00:00:00.000Z",
              stateRestrictions: [{ stateRestrictionsText: "None" }],
              batteryTechnologyType: "Does Not Contain a Battery",
              electronicsIndicator: "No",
              chemicalAerosolPesticide: "No",
            },
            TradeItem: {
              sku: r.sku,
              orderableGTIN: gtin,
              countryOfOriginAssembly: [normalizeCountryOfOrigin(String(r.country_of_origin))],
              each: {
                eachDepth: length,
                eachWidth: width,
                eachHeight: height,
                eachWeight: weight,
                eachGTIN: gtin,
              },
            },



          };
        });

        const feedBody = {
          SupplierItemFeedHeader: {
            subCategory,
            sellingChannel: "fbw",
            processMode: "REPLACE",
            locale: "en",
            version: "1.4",
            subset: "EXTERNAL",
          },
          SupplierItem: supplierItems,
        };

        let submitRes: any = null;
        let statusPayload: any = null;
        let timedOut = false;
        try {
          submitRes = await walmartApi.submitFeed(feedType, feedBody);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          for (const it of items) {
            allFailed.push({
              sku: it.r.sku,
              status: "SUBMIT_ERROR",
              reason: `Feed submit failed for subCategory=${subCategory}: ${msg}`,
            });
          }
          allSubmits.push({ subCategory, error: msg });
          continue;
        }
        const feedId: string | null =
          submitRes?.feedId ?? submitRes?.payload?.feedId ?? null;
        if (feedId) allFeedIds.push(feedId);
        allSubmits.push({ subCategory, feedId, raw: submitRes });

        if (feedId) {
          const MAX_ATTEMPTS = 8;
          const DELAY_MS = 5000;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
              statusPayload = await walmartApi.getFeedStatus(feedId, true);
            } catch (e) {
              console.warn(
                `[WFS:convert] getFeedStatus attempt ${attempt + 1} failed`,
                e instanceof Error ? e.message : e
              );
            }
            const fs = String(statusPayload?.feedStatus ?? "").toUpperCase();
            if (fs && fs !== "RECEIVED" && fs !== "INPROGRESS") break;
            if (attempt < MAX_ATTEMPTS - 1) {
              await new Promise((res) => setTimeout(res, DELAY_MS));
            } else {
              timedOut = true;
            }
          }
        }
        if (timedOut) anyTimedOut = true;
        allStatuses.push({ subCategory, feedId, status: statusPayload, timedOut });
        lastStatus = statusPayload?.feedStatus ?? submitRes?.feedStatus ?? lastStatus;

        aggReceived += Number(statusPayload?.itemsReceived ?? 0);
        aggSucceeded += Number(statusPayload?.itemsSucceeded ?? 0);
        aggFailed += Number(statusPayload?.itemsFailed ?? 0);

        // Capture top-level ingestionErrors that aren't tied to a SKU.
        const topErrs: any[] =
          statusPayload?.ingestionErrors?.ingestionError ??
          statusPayload?.ingestionErrors ??
          [];
        for (const e of Array.isArray(topErrs) ? topErrs : []) {
          allErrs.push({
            type: e?.type ?? e?.errorType,
            description: e?.description ?? e?.errorDescription ?? e?.message,
          });
        }

        const itemDetails: any[] =
          statusPayload?.itemDetails?.itemIngestionStatus ??
          statusPayload?.itemDetails ??
          [];
        const seen = new Set<string>();
        for (const d of Array.isArray(itemDetails) ? itemDetails : []) {
          const sku: string = d?.sku ?? d?.martSku ?? "";
          if (sku) seen.add(sku);
          const ingestionStatus: string = String(
            d?.ingestionStatus ?? d?.status ?? ""
          ).toUpperCase();
          const ingErrs: any[] =
            d?.ingestionErrors?.ingestionError ?? d?.ingestionErrors ?? [];
          const errList = Array.isArray(ingErrs) ? ingErrs : [];

          if (ingestionStatus === "PROCESSED" || ingestionStatus === "SUCCESS") {
            if (sku) allSuccess.push(sku);
          } else if (sku) {
            const firstErr = errList[0];
            allFailed.push({
              sku,
              status: ingestionStatus || "ERROR",
              reason:
                firstErr?.description ??
                firstErr?.errorDescription ??
                firstErr?.message ??
                "No error description provided",
            });
          }

          for (const e of errList) {
            allErrs.push({
              sku: sku || undefined,
              type: e?.type ?? e?.errorType,
              description: e?.description ?? e?.errorDescription ?? e?.message,
            });
          }
        }
        // If Walmart returned a system-level error (itemsReceived = 0) with
        // no per-SKU details, surface that against every SKU in the group so
        // the operator sees why they failed.
        const fsUp = String(statusPayload?.feedStatus ?? "").toUpperCase();
        if (
          (fsUp === "ERROR" || fsUp === "PROCESSED_WITH_ERROR") &&
          aggReceived === 0 &&
          topErrs.length > 0
        ) {
          const desc =
            topErrs[0]?.description ??
            topErrs[0]?.errorDescription ??
            topErrs[0]?.message ??
            "Walmart rejected the feed";
          for (const it of items) {
            if (!seen.has(it.r.sku)) {
              allFailed.push({
                sku: it.r.sku,
                status: "FEED_ERROR",
                reason: `${desc} (subCategory=${subCategory})`,
              });
            }
          }
        }
      }

      await supabaseAdmin
        .from("wfs_conversion_runs")
        .update({
          feed_id: allFeedIds.join(",") || null,
          status: lastStatus,
          response: {
            submits: allSubmits,
            statuses: allStatuses,
            successSkus: allSuccess,
            failedItems: allFailed as unknown as Record<string, unknown>[],
            preflightFailed: preflightFailed as unknown as Record<string, unknown>[],
            timedOut: anyTimedOut,
          } as any,
        })
        .eq("id", runId);

      return {
        runId,
        feedId: allFeedIds[0] ?? null,
        status: lastStatus,
        submittedCount,
        itemsReceived: aggReceived,
        itemsSucceeded: aggSucceeded,
        itemsFailed: aggFailed + preflightFailed.length,
        successSkus: allSuccess,
        failedItems: [...preflightFailed, ...allFailed],
        ingestionErrors: allErrs,
        timedOut: anyTimedOut,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabaseAdmin
        .from("wfs_conversion_runs")
        .update({ status: "error", error: msg })
        .eq("id", runId);
      throw err;
    }
  });


// ─── Import dimensions CSV ───────────────────────────────
// Operator workflow: export UPCs → fill dims in a spreadsheet →
// upload here. This bypasses the items API enrichment for shipping
// weight & dimensions (which Walmart doesn't reliably return) and
// marks updated SKUs as fully enriched so they appear in the
// "Ready to submit" view.

export interface ImportDimensionsRow {
  sku: string;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  weight?: number | null;
  weightUnit?: string;
  dimUnit?: string;
  countryOfOrigin?: string;
  brand?: string;
  manufacturer?: string;
  mainImageUrl?: string;
  price?: number | null;
  productType?: string;
}

export interface ImportDimensionsResult {
  received: number;
  updated: number;
  skipped: number;
  errors: Array<{ sku: string; reason: string }>;
}

export const importDimensions = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        rows: z
          .array(
            z.object({
              sku: z.string().min(1).max(50),
              length: z.number().positive().nullable().optional(),
              width: z.number().positive().nullable().optional(),
              height: z.number().positive().nullable().optional(),
              weight: z.number().positive().nullable().optional(),
              weightUnit: z.string().max(8).optional(),
              dimUnit: z.string().max(8).optional(),
              countryOfOrigin: z.string().max(64).optional(),
              brand: z.string().max(120).optional(),
              manufacturer: z.string().max(120).optional(),
              mainImageUrl: z.string().max(500).optional(),
              price: z.number().positive().nullable().optional(),
              productType: z.string().max(120).optional(),
            })
          )
          .min(1)
          .max(10000),
      })
      .parse(data)
  )
  .handler(async ({ data }): Promise<ImportDimensionsResult> => {
    const errors: Array<{ sku: string; reason: string }> = [];
    let updated = 0;
    let skipped = 0;

    const existingBySku = new Map<string, any>();
    const uniqueSkus = Array.from(new Set(data.rows.map((row) => row.sku)));
    for (let i = 0; i < uniqueSkus.length; i += 1000) {
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("catalog_items")
        .select("sku, brand, manufacturer, main_image_url, price, product_type, country_of_origin, shipping_weight, shipping_length, shipping_width, shipping_height")
        .in("sku", uniqueSkus.slice(i, i + 1000));
      if (existingErr) throw new Error(`catalog lookup failed: ${existingErr.message}`);
      for (const row of existing ?? []) existingBySku.set((row as any).sku, row);
    }

    const finalValue = (patch: Record<string, unknown>, current: any, key: string) =>
      patch[key] !== undefined ? patch[key] : current?.[key];

    const isReadyAfterPatch = (patch: Record<string, unknown>, current: any): boolean => {
      const brand = String(finalValue(patch, current, "brand") ?? "").trim();
      const manufacturer = String(finalValue(patch, current, "manufacturer") ?? "").trim() || brand;
      const image = String(finalValue(patch, current, "main_image_url") ?? "").trim();
      const country = String(finalValue(patch, current, "country_of_origin") ?? "").trim();
      const productType = String(finalValue(patch, current, "product_type") ?? "").trim();
      const price = Number(finalValue(patch, current, "price") ?? 0);
      const weight = Number(finalValue(patch, current, "shipping_weight") ?? 0);
      const length = Number(finalValue(patch, current, "shipping_length") ?? 0);
      const width = Number(finalValue(patch, current, "shipping_width") ?? 0);
      const height = Number(finalValue(patch, current, "shipping_height") ?? 0);
      return Boolean(
        brand &&
          manufacturer &&
          image &&
          country &&
          productType &&
          price > 0 &&
          weight > 0 &&
          length > 0 &&
          width > 0 &&
          height > 0
      );
    };

    const tasks = data.rows.map((row) => async () => {
      const patch: Record<string, unknown> = {};
      // Dims are optional now — we accept partial enrichment rows. The
      // submit step will reject any SKU that still has gaps.
      if ((row.length ?? 0) > 0) patch.shipping_length = row.length;
      if ((row.width ?? 0) > 0) patch.shipping_width = row.width;
      if ((row.height ?? 0) > 0) patch.shipping_height = row.height;
      if ((row.weight ?? 0) > 0) patch.shipping_weight = row.weight;
      if (row.dimUnit) patch.shipping_dim_unit = row.dimUnit;
      if (row.weightUnit) patch.shipping_weight_unit = row.weightUnit;
      if (row.countryOfOrigin?.trim()) patch.country_of_origin = row.countryOfOrigin.trim();
      if (row.brand?.trim()) patch.brand = row.brand.trim();
      if (row.manufacturer?.trim()) patch.manufacturer = row.manufacturer.trim();
      if (row.mainImageUrl?.trim()) patch.main_image_url = row.mainImageUrl.trim();
      if (row.productType?.trim()) patch.product_type = row.productType.trim();
      if (row.price != null && row.price > 0) patch.price = row.price;

      if (Object.keys(patch).length === 0) {
        skipped++;
        errors.push({ sku: row.sku, reason: "no fields to update" });
        return;
      }
      patch.enriched_at = new Date().toISOString();
      patch.enrichment_status = isReadyAfterPatch(patch, existingBySku.get(row.sku)) ? "enriched" : "partial";

      const { error, count } = await supabaseAdmin
        .from("catalog_items")
        .update(patch as any, { count: "exact" })
        .eq("sku", row.sku);
      if (error) {
        errors.push({ sku: row.sku, reason: error.message });
        return;
      }
      if ((count ?? 0) === 0) {
        skipped++;
        errors.push({ sku: row.sku, reason: "SKU not found in catalog" });
        return;
      }
      updated++;
    });

    const CONCURRENCY = 25;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (cursor < tasks.length) {
          const idx = cursor++;
          await tasks[idx]();
        }
      })
    );

    return { received: data.rows.length, updated, skipped, errors };
  });



export interface WfsConversionRunSummary {
  id: string;
  feedId: string | null;
  skuCount: number;
  status: string;
  error: string | null;
  createdAt: string;
}

export const listWfsConversionRuns = createServerFn({ method: "GET" }).handler(
  async (): Promise<WfsConversionRunSummary[]> => {
    const { data, error } = await supabaseAdmin
      .from("wfs_conversion_runs")
      .select("id, feed_id, sku_count, status, error, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw new Error(`conversion runs read failed: ${error.message}`);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      feedId: r.feed_id,
      skuCount: r.sku_count,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
    }));
  }
);

// ─── Catalog Enrichment ─────────────────────────────────
// Pulls extra SupplierItem attributes (brand, manufacturer, price, image,
// dimensions, country of origin, sub category, etc.) from Walmart's
// /v3/items/{sku} endpoint and stores them on catalog_items so the WFS
// convert feed can be built without per-SKU manual data entry.
//
// Walmart's items endpoint returns most descriptive attributes but does NOT
// reliably return shipping weight/dimensions or country of origin — those
// fields are stored in the item spec / setup data. We capture what we can
// and mark the row as "partial" so the UI can flag what still needs manual
// entry before submission.

type EnrichmentStatus = "pending" | "enriched" | "partial" | "error";

interface EnrichedFields {
  brand: string;
  manufacturer: string;
  short_description: string;
  main_image_url: string;
  price: number | null;
  currency: string;
  product_type: string;
  category: string;
  sub_category: string;
  country_of_origin: string;
  shipping_weight: number | null;
  shipping_weight_unit: string;
  shipping_length: number | null;
  shipping_width: number | null;
  shipping_height: number | null;
  shipping_dim_unit: string;
}

const REQUIRED_FOR_WFS: Array<keyof EnrichedFields> = [
  "brand",
  "main_image_url",
  "price",
  "product_type",
  "country_of_origin",
  "shipping_weight",
  "shipping_length",
  "shipping_width",
  "shipping_height",
];

function extractAdditionalAttr(attrs: any, names: string[]): string {
  if (!attrs) return "";
  const list = Array.isArray(attrs) ? attrs : attrs?.additionalProductAttribute ?? [];
  if (!Array.isArray(list)) return "";
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const a of list) {
    const k = String(a?.productAttributeName ?? a?.name ?? "").toLowerCase();
    if (wanted.has(k)) {
      const v = a?.productAttributeValue ?? a?.value ?? "";
      return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
    }
  }
  return "";
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function parseEnrichedFields(raw: any, report?: ItemReportRow): EnrichedFields {
  const payload = raw?.payload ?? raw ?? {};
  const candidate =
    (Array.isArray(payload?.ItemResponse) ? payload.ItemResponse[0] : payload?.ItemResponse) ??
    (Array.isArray(payload?.itemResponse) ? payload.itemResponse[0] : payload?.itemResponse) ??
    (Array.isArray(payload?.items) ? payload.items[0] : payload?.items) ??
    payload;
  const c = candidate ?? {};
  const attrs = c?.additionalProductAttributes ?? c?.AdditionalProductAttributes;
  const priceAmt = toNumberOrNull(c?.price?.amount ?? c?.price) ?? report?.price ?? null;
  const currency = String(c?.price?.currency ?? c?.currency ?? report?.currency ?? "USD") || "USD";

  return {
    brand: String(c?.brand ?? report?.brand ?? extractAdditionalAttr(attrs, ["brand"]) ?? ""),
    manufacturer: String(
      c?.manufacturer ??
        extractAdditionalAttr(attrs, ["manufacturer", "manufacturer_name"]) ??
        ""
    ),
    short_description: String(
      c?.shortDescription ?? c?.shortdescription ?? c?.productDescription ?? ""
    ),
    main_image_url: String(
      getItemImageUrl(c, report) ??
        extractAdditionalAttr(attrs, [
          "main_image_url",
          "mainimageurl",
          "product_image_url",
          "productimageurl",
          "primary_image_url",
        ]) ??
        ""
    ),
    price: priceAmt,
    currency,
    product_type: String(c?.productType ?? c?.productSubType ?? report?.productType ?? ""),
    category: String(c?.productCategory ?? c?.category ?? report?.productType ?? ""),
    sub_category: String(
      c?.subCategory ??
        extractAdditionalAttr(attrs, ["sub_category", "subcategory"]) ??
        ""
    ),
    country_of_origin: String(
      extractAdditionalAttr(attrs, [
        "country_of_origin",
        "country_of_origin_textiles",
        "country_of_origin_assembly",
        "countryoforiginassembly",
      ]) ?? ""
    ),
    shipping_weight: toNumberOrNull(
      c?.shippingWeight?.value ??
        c?.shippingWeight ??
        extractAdditionalAttr(attrs, ["shipping_weight", "weight"])
    ),
    shipping_weight_unit: String(c?.shippingWeight?.unit ?? "lb") || "lb",
    shipping_length: toNumberOrNull(
      c?.shippingLength?.value ??
        c?.shippingLength ??
        extractAdditionalAttr(attrs, ["shipping_length", "length"])
    ),
    shipping_width: toNumberOrNull(
      c?.shippingWidth?.value ??
        c?.shippingWidth ??
        extractAdditionalAttr(attrs, ["shipping_width", "width"])
    ),
    shipping_height: toNumberOrNull(
      c?.shippingHeight?.value ??
        c?.shippingHeight ??
        extractAdditionalAttr(attrs, ["shipping_height", "height"])
    ),
    shipping_dim_unit: String(c?.shippingLength?.unit ?? "in") || "in",
  };
}

function hasEnrichedValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  return true;
}

function existingEnrichedFields(row: any): EnrichedFields {
  return {
    brand: String(row?.brand ?? ""),
    manufacturer: String(row?.manufacturer ?? ""),
    short_description: String(row?.short_description ?? ""),
    main_image_url: String(row?.main_image_url ?? ""),
    price: toNumberOrNull(row?.price),
    currency: String(row?.currency ?? "USD") || "USD",
    product_type: String(row?.product_type ?? ""),
    category: String(row?.category ?? ""),
    sub_category: String(row?.sub_category ?? ""),
    country_of_origin: String(row?.country_of_origin ?? ""),
    shipping_weight: toNumberOrNull(row?.shipping_weight),
    shipping_weight_unit: String(row?.shipping_weight_unit ?? "lb") || "lb",
    shipping_length: toNumberOrNull(row?.shipping_length),
    shipping_width: toNumberOrNull(row?.shipping_width),
    shipping_height: toNumberOrNull(row?.shipping_height),
    shipping_dim_unit: String(row?.shipping_dim_unit ?? "in") || "in",
  };
}

function mergeEnrichedFields(next: EnrichedFields, previous: EnrichedFields): EnrichedFields {
  const merged = { ...previous } as EnrichedFields;
  for (const key of Object.keys(next) as Array<keyof EnrichedFields>) {
    if (hasEnrichedValue(next[key])) {
      (merged as any)[key] = next[key];
    }
  }
  return merged;
}

function classifyEnrichment(fields: EnrichedFields): EnrichmentStatus {
  for (const k of REQUIRED_FOR_WFS) {
    const v = fields[k];
    if (v === null || v === undefined || v === "") return "partial";
  }
  return "enriched";
}

export interface EnrichCatalogResult {
  processed: number;
  enriched: number;
  partial: number;
  failed: number;
  remaining: number;
  done: boolean;
  nextAfterSku: string | null;
}

export const enrichCatalogStep = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        batchSize: z.number().int().min(1).max(500).optional(),
        afterSku: z.string().optional(),
        reenrich: z.boolean().optional(),
      })
      .parse(data ?? {})
  )
  .handler(async ({ data }): Promise<EnrichCatalogResult> => {
    const batchSize = data.batchSize ?? 200;
    await getWalmartAccessToken();

    const reportMapPromise = getItemReportFulfillmentMap();

    let query = supabaseAdmin
      .from("catalog_items")
      .select("sku, brand, manufacturer, short_description, main_image_url, price, currency, product_type, category, sub_category, country_of_origin, shipping_weight, shipping_weight_unit, shipping_length, shipping_width, shipping_height, shipping_dim_unit")
      .order("sku", { ascending: true })
      .limit(batchSize);
    if (!data.reenrich) {
      query = query.in("enrichment_status", ["pending", "error"]);
    }
    if (data.afterSku) query = query.gt("sku", data.afterSku);

    const { data: rows, error } = await query;
    if (error) throw new Error(`enrichment read failed: ${error.message}`);
    const rowList = (rows ?? []) as any[];
    const skus = rowList.map((r: any) => r.sku);
    const reportMap = await reportMapPromise;

    let enriched = 0;
    let partial = 0;
    let failed = 0;
    const now = new Date().toISOString();

    const CONCURRENCY = 16;
    let idx = 0;
    async function worker() {
      while (idx < skus.length) {
        const i = idx++;
        const existingRow = rowList[i];
        const sku = existingRow.sku;
        try {
          const raw = await walmartApi.getItem(sku);
          const fields = mergeEnrichedFields(
            parseEnrichedFields(raw, reportMap.get(sku)),
            existingEnrichedFields(existingRow)
          );
          const status = classifyEnrichment(fields);
          const { error: uErr } = await supabaseAdmin
            .from("catalog_items")
            .update({
              ...fields,
              enrichment_status: status,
              enrichment_error: null,
              enriched_at: now,
              enrichment_raw: raw as any,
              last_synced_at: now,
            })
            .eq("sku", sku);
          if (uErr) {
            failed++;
            console.warn(`[WFS:enrich] update failed sku=${sku}: ${uErr.message}`);
            continue;
          }
          if (status === "enriched") enriched++;
          else partial++;
        } catch (e) {
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[WFS:enrich] fetch failed sku=${sku}:`, msg);
          await supabaseAdmin
            .from("catalog_items")
            .update({
              enrichment_status: "error",
              enrichment_error: msg.slice(0, 500),
              enriched_at: now,
            })
            .eq("sku", sku);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, skus.length)) }, worker)
    );

    const { count: pendingCount } = await supabaseAdmin
      .from("catalog_items")
      .select("sku", { count: "exact", head: true })
      .in("enrichment_status", ["pending", "error"]);

    const nextAfterSku = skus.length > 0 ? skus[skus.length - 1] : null;
    const done = skus.length < batchSize;

    await supabaseAdmin
      .from("catalog_enrichment_state")
      .update({
        status: done ? "idle" : "running",
        cursor: done ? null : nextAfterSku,
        last_run_at: now,
        ...(done ? { last_full_run_at: now } : {}),
        processed_this_run: skus.length,
        enriched_this_run: enriched,
        partial_this_run: partial,
        failed_this_run: failed,
        error: null,
      })
      .eq("id", 1);

    return {
      processed: skus.length,
      enriched,
      partial,
      failed,
      remaining: pendingCount ?? 0,
      done,
      nextAfterSku,
    };
  });

export interface EnrichmentOverview {
  state: {
    status: string;
    cursor: string | null;
    lastRunAt: string | null;
    lastFullRunAt: string | null;
    error: string | null;
  };
  counts: {
    total: number;
    enriched: number;
    partial: number;
    pending: number;
    errored: number;
  };
}

export const getEnrichmentOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<EnrichmentOverview> => {
    const { data: stateRow } = await supabaseAdmin
      .from("catalog_enrichment_state")
      .select("status, cursor, last_run_at, last_full_run_at, error")
      .eq("id", 1)
      .maybeSingle();

    async function countBy(status: string | string[]) {
      let q = supabaseAdmin.from("catalog_items").select("sku", { count: "exact", head: true });
      q = Array.isArray(status) ? q.in("enrichment_status", status) : q.eq("enrichment_status", status);
      const { count } = await q;
      return count ?? 0;
    }

    const [total, enriched, partial, pending, errored] = await Promise.all([
      supabaseAdmin
        .from("catalog_items")
        .select("sku", { count: "exact", head: true })
        .then((r) => r.count ?? 0),
      countBy("enriched"),
      countBy("partial"),
      countBy("pending"),
      countBy("error"),
    ]);

    return {
      state: {
        status: (stateRow as any)?.status ?? "idle",
        cursor: (stateRow as any)?.cursor ?? null,
        lastRunAt: (stateRow as any)?.last_run_at ?? null,
        lastFullRunAt: (stateRow as any)?.last_full_run_at ?? null,
        error: (stateRow as any)?.error ?? null,
      },
      counts: { total, enriched, partial, pending, errored },
    };
  }
);
