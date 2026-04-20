import { createPrivateKey } from "crypto";
import { SignJWT } from "jose";

const API_HOST = "api.coinbase.com";
const BASE_URL = `https://${API_HOST}`;

export interface CoinbaseCredentials {
  keyName: string;    // e.g. "organizations/abc/apiKeys/xyz"
  privateKeyPem: string; // SEC1 or PKCS#8 PEM, BEGIN [EC] PRIVATE KEY
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
}

export interface PlaceOrderResult {
  order_id: string;
}

export interface PolledOrder {
  order_id: string;
  status: "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED" | "FAILED" | "PENDING";
  filled_size: string;      // BTC amount
  filled_value: string;     // USD value
  filled_at?: string;
}

export interface PlaceWithdrawResult {
  transaction_id: string;
}

export interface PolledWithdraw {
  transaction_id: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  network_tx_hash?: string;
}

// ───────────────────────────────────────────────────────────────────────
// JWT signing
// ───────────────────────────────────────────────────────────────────────

async function signJwt(creds: CoinbaseCredentials, method: string, path: string): Promise<string> {
  // Node's createPrivateKey handles both SEC1 ("BEGIN EC PRIVATE KEY") and
  // PKCS#8 ("BEGIN PRIVATE KEY") PEMs directly — no SEC1→PKCS#8 conversion
  // needed (that workaround only existed in the Worker because Web Crypto
  // only accepts PKCS#8).
  const keyObj = createPrivateKey({ key: creds.privateKeyPem, format: "pem" });
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: creds.keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri: `${method} ${API_HOST}${path}`,
  })
    .setProtectedHeader({ alg: "ES256", kid: creds.keyName, typ: "JWT" })
    .sign(keyObj);
}

// ───────────────────────────────────────────────────────────────────────
// HTTP helper
// ───────────────────────────────────────────────────────────────────────

async function coinbaseRequest<T>(
  creds: CoinbaseCredentials,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string }> {
  const jwt = await signJwt(creds, method, path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    if (text === "") {
      return { ok: true, status: res.status, data: undefined as unknown as T };
    }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, status: res.status, error: `non_json_response: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Operations used by the scheduler
// ───────────────────────────────────────────────────────────────────────

/**
 * Verify credentials work. Returns the full account list on success.
 * Called from POST /api/autobuy/credentials/verify and from the scheduler
 * before each buy to fetch USD + BTC account UUIDs and balances.
 */
export async function listAccounts(creds: CoinbaseCredentials) {
  return coinbaseRequest<{ accounts: CoinbaseAccount[] }>(creds, "GET", "/api/v3/brokerage/accounts");
}

/**
 * Place a market BUY order for the given USD amount (quote_size).
 * Returns the Coinbase order_id on success. Uses a random client_order_id
 * to prevent accidental duplicate fills on retry.
 */
export async function placeMarketBuy(
  creds: CoinbaseCredentials,
  quoteSizeUsd: number,
): Promise<{ ok: true; order_id: string } | { ok: false; status: number; error: string }> {
  const clientOrderId = `autobuy-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const body = {
    client_order_id: clientOrderId,
    product_id: "BTC-USD",
    side: "BUY",
    order_configuration: {
      market_market_ioc: { quote_size: quoteSizeUsd.toFixed(2) },
    },
  };
  const res = await coinbaseRequest<{
    success: boolean;
    order_id?: string;
    success_response?: { order_id: string };
    error_response?: { error: string; message?: string };
  }>(creds, "POST", "/api/v3/brokerage/orders", body);
  if (!res.ok) return res;
  const orderId = res.data.order_id || res.data.success_response?.order_id;
  if (!orderId) {
    const err = res.data.error_response?.message || res.data.error_response?.error || "no_order_id_in_response";
    return { ok: false, status: 200, error: err };
  }
  return { ok: true, order_id: orderId };
}

/**
 * Poll a previously-placed order. Returns normalized status + filled amounts.
 */
export async function pollOrder(
  creds: CoinbaseCredentials,
  orderId: string,
): Promise<{ ok: true; order: PolledOrder } | { ok: false; status: number; error: string }> {
  const res = await coinbaseRequest<{ order: PolledOrder }>(
    creds,
    "GET",
    `/api/v3/brokerage/orders/historical/${encodeURIComponent(orderId)}`,
  );
  if (!res.ok) return res;
  return { ok: true, order: res.data.order };
}

/**
 * Withdraw BTC from the Coinbase BTC account to an on-chain address. Uses
 * the /v2 transactions endpoint with type=send. The BTC account UUID comes
 * from listAccounts() output.
 */
export async function placeWithdraw(
  creds: CoinbaseCredentials,
  btcAccountId: string,
  toAddress: string,
  btcAmount: number,
): Promise<{ ok: true; transaction_id: string } | { ok: false; status: number; error: string }> {
  const body = {
    type: "send",
    to: toAddress,
    amount: btcAmount.toFixed(8),
    currency: "BTC",
  };
  const res = await coinbaseRequest<{ data: { id: string } }>(
    creds,
    "POST",
    `/v2/accounts/${encodeURIComponent(btcAccountId)}/transactions`,
    body,
  );
  if (!res.ok) return res;
  return { ok: true, transaction_id: res.data.data.id };
}

/**
 * Poll a previously-placed withdraw transaction for confirmation status.
 */
export async function pollWithdraw(
  creds: CoinbaseCredentials,
  btcAccountId: string,
  transactionId: string,
): Promise<{ ok: true; withdraw: PolledWithdraw } | { ok: false; status: number; error: string }> {
  const res = await coinbaseRequest<{
    data: { id: string; status: string; network?: { hash?: string } };
  }>(
    creds,
    "GET",
    `/v2/accounts/${encodeURIComponent(btcAccountId)}/transactions/${encodeURIComponent(transactionId)}`,
  );
  if (!res.ok) return res;
  const normalized: PolledWithdraw = {
    transaction_id: res.data.data.id,
    status: res.data.data.status as PolledWithdraw["status"],
    network_tx_hash: res.data.data.network?.hash,
  };
  return { ok: true, withdraw: normalized };
}
