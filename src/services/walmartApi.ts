/**
 * Walmart Seller API Client
 * Centralized API layer for all Walmart Marketplace / WFS endpoints.
 * All methods return raw API responses; transformation happens in the business logic layer.
 */

import { getWalmartAccessToken } from "./walmartAuth";

const getBaseUrl = () =>
  process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";

async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getWalmartAccessToken();
  const baseUrl = getBaseUrl();

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Authorization": `Basic ${token}`, // Walmart uses the token in this header
      "WM_SEC.ACCESS_TOKEN": token,
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walmart API error [${response.status}] ${path}: ${text}`);
  }

  return response.json() as Promise<T>;
}

// ─── Inventory ──────────────────────────────────────────
export async function getInventory(nextCursor?: string) {
  const params = new URLSearchParams({ limit: "200" });
  if (nextCursor) params.set("nextCursor", nextCursor);
  return walmartFetch<any>(`/v3/inventory?${params}`);
}

export async function getWfsInventory(nextCursor?: string) {
  const params = new URLSearchParams({ limit: "200" });
  if (nextCursor) params.set("nextCursor", nextCursor);
  return walmartFetch<any>(`/v3/fulfillment/inventory?${params}`);
}

export async function getInventoryForSku(sku: string) {
  return walmartFetch<any>(`/v3/inventory?sku=${encodeURIComponent(sku)}`);
}

// ─── Orders ─────────────────────────────────────────────
export async function getOrders(params: {
  createdStartDate: string;
  createdEndDate?: string;
  nextCursor?: string;
  limit?: number;
  status?: string;
}) {
  const searchParams = new URLSearchParams({
    createdStartDate: params.createdStartDate,
    limit: String(params.limit || 200),
    ...(params.createdEndDate ? { createdEndDate: params.createdEndDate } : {}),
    ...(params.nextCursor ? { nextCursor: params.nextCursor } : {}),
    ...(params.status ? { status: params.status } : {}),
  });
  return walmartFetch<any>(`/v3/orders?${searchParams}`);
}

export async function getOrder(purchaseOrderId: string) {
  return walmartFetch<any>(`/v3/orders/${encodeURIComponent(purchaseOrderId)}`);
}

// ─── Inbound Shipments (WFS) ────────────────────────────
export async function getInboundShipments(params?: {
  status?: string;
  nextCursor?: string;
  limit?: number;
}) {
  const searchParams = new URLSearchParams({
    limit: String(params?.limit || 50),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.nextCursor ? { nextCursor: params.nextCursor } : {}),
  });
  return walmartFetch<any>(`/v3/fulfillment/inbound-shipments?${searchParams}`);
}

export async function getInboundShipment(shipmentId: string) {
  return walmartFetch<any>(`/v3/fulfillment/inbound-shipments/${encodeURIComponent(shipmentId)}`);
}

// ─── Items / Catalog ────────────────────────────────────
export async function getItems(nextCursor?: string) {
  const params = new URLSearchParams({ limit: "200" });
  if (nextCursor) params.set("nextCursor", nextCursor);
  return walmartFetch<any>(`/v3/items?${params}`);
}

export async function getItem(sku: string) {
  return walmartFetch<any>(`/v3/items/${encodeURIComponent(sku)}`);
}
