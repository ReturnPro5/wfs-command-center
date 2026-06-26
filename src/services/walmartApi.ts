/**
 * Walmart Seller API Client
 * Centralized API layer for all Walmart Marketplace / WFS endpoints.
 * All methods return raw API responses; transformation happens in the business logic layer.
 */

import { getWalmartAccessToken } from "./walmartAuth";

const getBaseUrl = () =>
  process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";

const MAX_RETRIES = 1;
const RETRY_BASE_MS = 500;

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
        signal: AbortSignal.timeout(10_000),
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

async function walmartFetchRaw(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getWalmartAccessToken();
  const baseUrl = getBaseUrl();
  const channelType = process.env.WALMART_CHANNEL_TYPE;
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "WM_SEC.ACCESS_TOKEN": token,
      ...(channelType ? { "WM_CONSUMER.CHANNEL.TYPE": channelType } : {}),
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      "Accept": "application/json,text/csv,*/*",
      ...((options.method && options.method !== "GET") ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walmart API error [${response.status}] ${path}: ${text}`);
  }
  return response;
}

// ─── Inventory ──────────────────────────────────────────
export async function getInventory(nextCursor?: string) {
  const params = new URLSearchParams({ limit: "200" });
  if (nextCursor) params.set("nextCursor", nextCursor);
  return walmartFetch<any>(`/v3/inventory?${params}`);
}

export async function getWfsInventory(nextCursor?: string) {
  const params = new URLSearchParams({ limit: "500" });
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
  shipNodeType?: "SellerFulfilled" | "WFSFulfilled" | "3PLFulfilled";
}) {
  // Walmart returns nextCursor as a complete query string (e.g.
  //   "?limit=200&cursor=...&soIndex=...&poIndex=...&createdStartDate=...").
  // The recommended use is to append it directly to the endpoint, untouched —
  // re-parsing through URLSearchParams can mangle the base64 cursor.
  if (params.nextCursor) {
    const qs = params.nextCursor.startsWith("?") ? params.nextCursor : `?${params.nextCursor}`;
    return walmartFetch<any>(`/v3/orders${qs}`);
  }

  const searchParams = new URLSearchParams({
    createdStartDate: params.createdStartDate,
    limit: String(params.limit || 200),
    ...(params.createdEndDate ? { createdEndDate: params.createdEndDate } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.shipNodeType ? { shipNodeType: params.shipNodeType } : {}),
  });

  return walmartFetch<any>(`/v3/orders?${searchParams}`);
}

export async function getOrder(purchaseOrderId: string) {
  return walmartFetch<any>(`/v3/orders/${encodeURIComponent(purchaseOrderId)}`);
}

// ─── Inbound Shipments (WFS) ────────────────────────────
// Walmart requires `fromCreatedDate` for this endpoint; default to a wide
// rolling window so we don't silently return empty.
export async function getInboundShipments(params?: {
  status?: string;
  nextCursor?: string;
  limit?: number;
  fromCreatedDate?: string;
  toCreatedDate?: string;
}) {
  const fromDefault = new Date();
  fromDefault.setDate(fromDefault.getDate() - 180);
  const searchParams = new URLSearchParams({
    limit: String(params?.limit || 50),
    fromCreatedDate: params?.fromCreatedDate || fromDefault.toISOString(),
    ...(params?.toCreatedDate ? { toCreatedDate: params.toCreatedDate } : {}),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.nextCursor ? { nextCursor: params.nextCursor } : {}),
  });
  return walmartFetch<any>(`/v3/fulfillment/inbound-shipments?${searchParams}`);
}

export async function getInboundShipment(shipmentId: string) {
  return walmartFetch<any>(`/v3/fulfillment/inbound-shipments/${encodeURIComponent(shipmentId)}`);
}

// ─── Items / Catalog ────────────────────────────────────
export async function getItems(nextCursor?: string, lifecycleStatus?: string, publishedStatus?: string) {
  // Build params fresh on every call. Walmart's cursor is opaque and must be sent
  // ALONG WITH the original limit + filter params — otherwise the next call returns
  // empty after page 1. Some Walmart responses return nextCursor as a bare token,
  // others as a full query string like "?nextCursor=X&limit=200&...". Normalize:
  // strip any leading "?" and extract just the cursor token, then rebuild the QS.
  let cursorToken = "*";
  if (nextCursor && nextCursor !== "*" && nextCursor.length > 0) {
    let raw = nextCursor.startsWith("?") ? nextCursor.slice(1) : nextCursor;
    if (raw.includes("=") || raw.includes("&")) {
      const parsed = new URLSearchParams(raw);
      cursorToken = parsed.get("nextCursor") ?? raw;
    } else {
      cursorToken = raw;
    }
  }
  const params = new URLSearchParams({ limit: "200", nextCursor: cursorToken });
  if (lifecycleStatus) params.set("lifecycleStatus", lifecycleStatus);
  if (publishedStatus) params.set("publishedStatus", publishedStatus);
  return walmartFetch<any>(`/v3/items?${params}`);
}

export async function getItem(sku: string) {
  return walmartFetch<any>(`/v3/items/${encodeURIComponent(sku)}`);
}

// ─── Reports ────────────────────────────────────────────
// The on-request ITEM report v4 is Walmart's documented source for
// fulfillment type: WFS Eligible, Walmart Fulfilled, or Seller Fulfilled.
const ITEM_REPORT_KEEP_COLUMNS = new Set([
  "SKU",
  "Product Name",
  "Product Category",
  "Product Type",
  "Price",
  "Currency",
  "Fulfillment Type",
  "GTIN",
  "UPC",
  "Primary Image URL",
  "Brand",
]);
const ITEM_REPORT_V4_COLUMNS = [
  "SKU",
  "Item ID",
  "Product Name",
  "Lifecycle Status",
  "Publish Status",
  "Status Change Reason",
  "Product Category",
  "Product Type",
  "Price",
  "Currency",
  "Buy Box Item Price",
  "Buy Box Shipping Price",
  "Buy Box Eligible",
  "MSRP",
  "Product Tax Code",
  "Ship Methods",
  "Shipping Weight",
  "Fulfillment Lag Time",
  "Fulfillment Type",
  "WFS Sales Restriction",
  "WPID",
  "GTIN",
  "UPC",
  "Item Page URL",
  "Primary Image URL",
  "Shelf Name",
  "Primary Category Path",
  "Brand",
  "Offer Start Date",
  "Offer End Date",
  "Item Creation Date",
  "Item Last Updated",
  "Reviews Count",
  "Average Rating",
  "Searchable?",
  "Variant Group Id",
  "Primary Variant?",
  "Variant Grouping Attributes",
  "Variant Grouping Values",
  "Competitor URL",
  "Competitor Price",
  "Competitor Ship Price",
  "Competitor Last Date Fetched",
  "Repricer Strategy",
  "Minimum Seller Allowed Price",
  "Maximum Seller Allowed Price",
  "Repricer Status",
];

export async function createItemReportRequest(): Promise<any> {
  const reportHeaders = {
    "WM_MARKET": "us",
    "WM_GLOBAL_VERSION": "3.1",
  };
  async function postItemReport(path: string, includeVersion: boolean, filtered: boolean) {
    const params = new URLSearchParams({
      reportType: "ITEM",
      ...(includeVersion ? { reportVersion: "v4" } : {}),
    });
    const body = filtered
      ? {
          excludeColumns: ITEM_REPORT_V4_COLUMNS.filter((column) => !ITEM_REPORT_KEEP_COLUMNS.has(column)),
        }
      : undefined;
    return walmartFetch<any>(`${path}?${params}`, {
      method: "POST",
      headers: reportHeaders,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  try {
    return await postItemReport("/v3/reports/reportRequests", true, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/excludeColumns|column|filter|payload|body|400/i.test(msg)) {
      return postItemReport("/v3/reports/reportRequests", true, false);
    }
    if (/404|CONTENT_NOT_FOUND/i.test(msg)) return postItemReport("/v3/reports/requests", true, true);
    if (/reportVersion|version/i.test(msg)) return postItemReport("/v3/reports/reportRequests", false, true);
    throw err;
  }
}

export async function getReportRequestStatus(requestId: string): Promise<any> {
  const headers = { "WM_MARKET": "us", "WM_GLOBAL_VERSION": "3.1" };
  try {
    return await walmartFetch<any>(`/v3/reports/reportRequests/${encodeURIComponent(requestId)}`, { headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404|CONTENT_NOT_FOUND/i.test(msg)) {
      return walmartFetch<any>(`/v3/reports/requests/${encodeURIComponent(requestId)}`, { headers });
    }
    throw err;
  }
}

export async function listItemReportRequests(): Promise<any> {
  const headers = { "WM_MARKET": "us", "WM_GLOBAL_VERSION": "3.1" };
  const params = new URLSearchParams({ reportType: "ITEM", reportVersion: "v4" });
  return walmartFetch<any>(`/v3/reports/reportRequests?${params}`, { headers });
}

export async function downloadReport(requestId: string): Promise<{ body: string; contentType: string }> {
  const { bytes, contentType } = await downloadReportFile(requestId);

  // Detect ZIP (PK\x03\x04) and extract the first text entry. This helper is
  // only used for small reports; fulfillment parsing uses streaming code in the
  // caller so huge Item reports don't allocate the full unzipped file at once.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const { unzipSync, strFromU8 } = await import("fflate");
    const entries = unzipSync(bytes);
    const names = Object.keys(entries);
    if (names.length === 0) throw new Error("report zip is empty");
    const pick = names.find((n) => /\.(csv|tsv|txt)$/i.test(n)) ?? names[0];
    return { body: strFromU8(entries[pick]), contentType: "text/plain" };
  }
  return { body: new TextDecoder().decode(bytes), contentType };
}

export async function downloadReportFile(requestId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await walmartFetchRaw(
    `/v3/reports/downloadReport?requestId=${encodeURIComponent(requestId)}`,
    { headers: { Accept: "application/json", "WM_MARKET": "us", "WM_GLOBAL_VERSION": "3.1" } },
  );
  const contentType = response.headers.get("content-type") ?? "";

  // Step 1: if Walmart returns JSON with a downloadURL, follow it; otherwise the
  // response IS the file (zip/csv/tsv).
  let buffer: ArrayBuffer;
  let finalContentType = contentType;
  if (contentType.includes("json")) {
    const text = await response.text();
    let url: string | undefined;
    try {
      const parsed = JSON.parse(text);
      url = parsed?.downloadURL ?? parsed?.downloadUrl ?? parsed?.url ?? parsed?.payload?.downloadURL ?? parsed?.payload?.downloadUrl;
    } catch { /* fall through */ }
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const file = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!file.ok) throw new Error(`report file download failed [${file.status}]`);
      buffer = await file.arrayBuffer();
      finalContentType = file.headers.get("content-type") ?? "";
    } else {
      return { bytes: new TextEncoder().encode(text), contentType };
    }
  } else {
    buffer = await response.arrayBuffer();
  }

  return { bytes: new Uint8Array(buffer), contentType: finalContentType };
}


// ─── Feeds (WFS Conversion) ─────────────────────────────
// Submit a feed. Used for feedType=OMNI_WFS (convert Seller-Fulfilled items to WFS).
// Walmart's WFS convert endpoint takes a JSON body directly (NOT multipart).
export async function submitFeed(feedType: string, feedBody: unknown): Promise<any> {
  const token = await getWalmartAccessToken();
  const baseUrl = getBaseUrl();
  const channelType = process.env.WALMART_CHANNEL_TYPE;

  const response = await fetch(`${baseUrl}/v3/feeds?feedType=${encodeURIComponent(feedType)}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "WM_SEC.ACCESS_TOKEN": token,
      ...(channelType ? { "WM_CONSUMER.CHANNEL.TYPE": channelType } : {}),
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(feedBody),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Walmart feed submit [${response.status}] ${feedType}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function getFeedStatus(feedId: string, includeDetails = true): Promise<any> {
  const params = new URLSearchParams({
    feedId,
    includeDetails: String(includeDetails),
    limit: "1000",
  });
  return walmartFetch<any>(`/v3/feeds/${encodeURIComponent(feedId)}?${params}`);
}

