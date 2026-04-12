/**
 * Walmart Seller API Client
 * Centralized API layer for all Walmart Marketplace / WFS endpoints.
 * All methods return raw API responses; transformation happens in the business logic layer.
 */

import { getWalmartAccessToken } from "./walmartAuth";

const getBaseUrl = () =>
  process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

async function walmartFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getWalmartAccessToken();
  const baseUrl = getBaseUrl();

  const channelType = process.env.WALMART_CHANNEL_TYPE;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.log(`[WalmartAPI] Retry ${attempt}/${MAX_RETRIES} for ${path} after ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: AbortSignal.timeout(30_000),
        headers: {
          "WM_SEC.ACCESS_TOKEN": token,
          // Optional: channel type for request tracking (set WALMART_CHANNEL_TYPE env var)
          ...(channelType ? { "WM_CONSUMER.CHANNEL.TYPE": channelType } : {}),
          "WM_SVC.NAME": "Walmart Marketplace",
          "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
          "Accept": "application/json",
          // Only set Content-Type for requests that have a body (POST/PUT/PATCH)
          ...((options.method && options.method !== "GET") ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        const status = response.status;

        // Retry on 5xx (server errors) and 429 (rate limit)
        if (status >= 500 || status === 429) {
          lastError = new Error(`Walmart API error [${status}] ${path}: ${text}`);
          continue;
        }

        throw new Error(`Walmart API error [${status}] ${path}: ${text}`);
      }

      return response.json() as Promise<T>;
    } catch (err: any) {
      // Retry on network/timeout errors
      if (err?.name === "TimeoutError" || err?.name === "AbortError" || err?.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
        lastError = err;
        continue;
      }
      // If it's our own retryable error from above, it's already stored in lastError
      if (lastError && err === lastError) continue;
      throw err;
    }
  }

  throw lastError ?? new Error(`Walmart API failed after ${MAX_RETRIES} retries: ${path}`);
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
  // Use the WFS-specific endpoint directly — no fallback, so real errors surface.
  // /v3/inventory requires a sku parameter and does not support bulk listing.
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
