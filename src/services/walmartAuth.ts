/**
 * Walmart API Authentication
 * Handles OAuth token management for Walmart Seller APIs.
 * Uses WALMART_CLIENT_ID and WALMART_CLIENT_SECRET from environment.
 */

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

// Singleton promise: when multiple parallel callers need a token at the same time,
// they all await this one promise instead of each racing to call /v3/token.
// Concurrent bursts (from parallel order-window fetches) previously caused Walmart
// to reject the flood of simultaneous auth requests with a misleading header error.
let pendingTokenRequest: Promise<string> | null = null;

export async function getWalmartAccessToken(): Promise<string> {
  const clientId = process.env.WALMART_CLIENT_ID;
  const clientSecret = process.env.WALMART_CLIENT_SECRET;
  const baseUrl = process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";

  if (!clientId || !clientSecret) {
    throw new Error("WALMART_CLIENT_ID and WALMART_CLIENT_SECRET must be configured");
  }

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  // If a token request is already in-flight, join it instead of firing another
  if (pendingTokenRequest) {
    return pendingTokenRequest;
  }

  pendingTokenRequest = (async () => {
    const credentials = btoa(`${clientId}:${clientSecret}`);
    const correlationId = crypto.randomUUID();
    console.log("[WalmartAuth] Requesting new token, correlationId:", correlationId);

    const response = await fetch(`${baseUrl}/v3/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "WM_SVC.NAME": "Walmart Marketplace",
        "WM_QOS.CORRELATION_ID": correlationId,
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("[WalmartAuth] Token request failed:", response.status, text);
      throw new Error(`Walmart auth failed [${response.status}]: ${text}`);
    }

    const data: TokenResponse = await response.json();
    console.log("[WalmartAuth] Token acquired, expires_in:", data.expires_in);

    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return cachedToken.token;
  })().finally(() => {
    pendingTokenRequest = null;
  });

  return pendingTokenRequest;
}
