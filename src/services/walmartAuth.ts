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

export async function getWalmartAccessToken(): Promise<string> {
  const clientId = process.env.WALMART_CLIENT_ID;
  const clientSecret = process.env.WALMART_CLIENT_SECRET;
  const baseUrl = process.env.WALMART_API_BASE_URL || "https://marketplace.walmartapis.com";

  console.log("[WalmartAuth] ENV check — CLIENT_ID:", clientId ? "set" : "MISSING", "CLIENT_SECRET:", clientSecret ? "set" : "MISSING", "BASE_URL:", baseUrl);

  if (!clientId || !clientSecret) {
    throw new Error("WALMART_CLIENT_ID and WALMART_CLIENT_SECRET must be configured");
  }

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(`${baseUrl}/v3/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walmart auth failed [${response.status}]: ${text}`);
  }

  const data: TokenResponse = await response.json();

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}
