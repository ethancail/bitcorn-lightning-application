import { createHash, createHmac } from "crypto";
import type { NonceSource } from "./krakenNonce";

// The hand-written Kraken client (kraken-autobuy Slice 1 spec §3 P3, §4).
// No SDK and no npm dependency: Node's crypto and the global fetch only.
//
// This module speaks Kraken's documented shapes and returns them as typed
// results. It does NOT classify errors, choose a provider, or touch the
// database; that is P4 (the adapter, the classifier, the routes).
//
// ─── SOURCES (read 2026-11-23) ──────────────────────────────────────────────
//   Auth (/0):        https://docs.kraken.com/exchange/guides/rest/authentication
//   Funding (Beta):   https://docs.kraken.com/exchange/guides/rest/funding
//   Shapes:           https://docs.kraken.com/openapi/spot-rest.yaml (the source
//                     of the API reference pages)
//   Errors:           https://docs.kraken.com/exchange/guides/general/errors
//
// ─── TWO SIGNING ASSEMBLIES, ONE ALGORITHM ──────────────────────────────────
//   API-Sign = base64( HMAC-SHA512( base64decode(secret),
//                                   signedPath || SHA256(nonce || data) ) )
//   /0/private:   nonce is a BODY field; data = the form-encoded body;
//                 signedPath = "/0/private/<Method>".
//   /funding/v1:  nonce is the API-Nonce HEADER; data = the compact JSON body,
//                 or "" for a GET; signedPath = path + "?" + the exact query
//                 string sent ("the signed path includes the query string").
//
// ─── OUTFLOW PRIMITIVES ─────────────────────────────────────────────────────
// krakenPlaceMarketBuy and krakenCreateWithdrawal move money. P4 seeds both
// into utils/action-confirmation.coverage.test.ts. Their names differ from
// Coinbase's placeMarketBuy/placeWithdraw on purpose: the coverage walk flags
// any non-call use of a seeded name. krakenValidateMarketBuy sends
// validate=true and never trades; krakenClient.test.ts pins that the AddOrder
// call and the withdrawal POST are reached from nowhere else in this file.
//
// ─── BTC/USDC IS NOT EXPRESSIBLE ────────────────────────────────────────────
// Slice 1 buys BTC with USD only (E9: USD only if viqc is unsupported on
// BTC/USDC; Austin's question 5 is open, and the BTC/USDC pair names are not in
// the docs). krakenPlaceMarketBuy takes no currency, so a USDC buy cannot be
// sent. Opening it is a deliberate signature change.

const BASE_URL = "https://api.kraken.com";
export const KRAKEN_REQUEST_TIMEOUT_MS = 30_000;

/** The BTC/USD spot pair, by altname (AddOrder accepts an id or an altname). */
export const KRAKEN_PAIR_BTC_USD = "XBTUSD";
/** BalanceEx keys for the three assets Slice 1 reads. A missing key means the account holds none. */
export const KRAKEN_BALANCE_KEYS = { usd: "ZUSD", btc: "XXBT", usdc: "USDC" } as const;
/** The Funding (Beta) API names bitcoin "BTC" (List Funding Assets example), where /0 says XBT. */
export const KRAKEN_FUNDING_BTC = { class: "currency", name: "BTC" } as const;

export interface KrakenAuth {
  /** The public API key, sent as API-Key. */
  apiKey: string;
  /** The private key, base64, as Kraken issues it. Never sent. */
  secret: string;
  /** The process-wide nonce source (krakenNonceSource). */
  nonce: NonceSource;
}

/** A failed call, as data. Classification is P4's. */
export type KrakenFailure =
  /** /0: the error array held an E-severity (or unrecognised) entry; HTTP status as received. */
  | { ok: false; kind: "api_error"; httpStatus: number; errors: string[] }
  /** A non-2xx response with no usable /0 error array. `body` is the parsed JSON, or null. */
  | { ok: false; kind: "http_error"; httpStatus: number; body: unknown; text: string }
  /** No response within KRAKEN_REQUEST_TIMEOUT_MS. For an outflow, the outcome is UNKNOWN. */
  | { ok: false; kind: "timeout"; timeoutMs: number }
  /** fetch rejected for any other reason. For an outflow, the outcome is UNKNOWN. */
  | { ok: false; kind: "network"; detail: string }
  /** A 2xx response that is not JSON or lacks a required field. */
  | { ok: false; kind: "bad_response"; httpStatus: number; detail: string }
  /** Refused before sending: an argument failed validation. Nothing reached Kraken. */
  | { ok: false; kind: "invalid_request"; detail: string }
  /** Refused before sending: the nonce store failed. Nothing reached Kraken. */
  | { ok: false; kind: "local_error"; detail: string };

/** Success carries the data and any W-severity warnings Kraken sent with it (ruling K3), for logging. */
export type KrakenResult<T> = ({ ok: true; warnings: string[] } & T) | KrakenFailure;

// ───────────────────────────────────────────────────────────────────────────
// Signing and transport
// ───────────────────────────────────────────────────────────────────────────

/** API-Sign for one request. `signedPath` includes the query string for funding calls. */
export function krakenSign(secret: string, signedPath: string, nonce: string, data: string): string {
  const inner = createHash("sha256").update(nonce + data, "utf8").digest();
  return createHmac("sha512", Buffer.from(secret, "base64"))
    .update(Buffer.concat([Buffer.from(signedPath, "utf8"), inner]))
    .digest("base64");
}

type Raw = { ok: true; status: number; text: string } | KrakenFailure;

async function send(url: string, init: RequestInit): Promise<Raw> {
  const controller = new AbortController();
  // A timeout is recognised by IDENTITY: this object is the abort reason, and
  // nothing else can be. Never by matching "abort" in an error message (P0
  // finding 9: a network error that merely mentions it is not a timeout).
  const timeoutReason = new Error("kraken_request_timeout");
  const handle = setTimeout(() => controller.abort(timeoutReason), KRAKEN_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
      return { ok: false, kind: "timeout", timeoutMs: KRAKEN_REQUEST_TIMEOUT_MS };
    }
    return { ok: false, kind: "network", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(handle);
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const excerpt = (text: string) => text.slice(0, 300);

/**
 * The /0 envelope: {error: string[], result?}. HTTP status carries no meaning
 * there, so the error array decides (spec §3 P3: a non-empty error array is a
 * failure even on HTTP 200). Ruling K3 narrows it: an array of ONLY W-severity
 * warnings with a valid result is success, and the warnings are returned.
 */
function parseEnvelope(raw: Raw): KrakenResult<{ result: Record<string, unknown>; status: number }> {
  if (!raw.ok) return raw;
  const json = parseJson(raw.text);
  if (!json.ok) {
    return raw.status >= 200 && raw.status < 300
      ? { ok: false, kind: "bad_response", httpStatus: raw.status, detail: `not JSON: ${excerpt(raw.text)}` }
      : { ok: false, kind: "http_error", httpStatus: raw.status, body: null, text: excerpt(raw.text) };
  }
  const body = json.value as { error?: unknown; result?: unknown } | null;
  const errField = body && typeof body === "object" ? body.error : undefined;
  // AddOrder's schema types `error` as an array of arrays; flatten one level.
  const errors = Array.isArray(errField) ? errField.flat().map((e) => String(e)) : [];
  if (errField !== undefined && errField !== null && !Array.isArray(errField)) {
    return { ok: false, kind: "bad_response", httpStatus: raw.status, detail: "error field is not an array" };
  }
  if (errors.some((e) => !e.startsWith("W"))) {
    return { ok: false, kind: "api_error", httpStatus: raw.status, errors };
  }
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, kind: "http_error", httpStatus: raw.status, body: json.value, text: excerpt(raw.text) };
  }
  const result = body?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, kind: "bad_response", httpStatus: raw.status, detail: "no result object" };
  }
  return { ok: true, warnings: errors, result: result as Record<string, unknown>, status: raw.status };
}

/** A signed /0/private call. The nonce is the first body field. */
async function privateCall(
  auth: KrakenAuth,
  method: string,
  params: Array<[string, string]>,
): Promise<KrakenResult<{ result: Record<string, unknown>; status: number }>> {
  const path = `/0/private/${method}`;
  try {
    return await auth.nonce.run(async (nonce) => {
      const body = new URLSearchParams([["nonce", nonce], ...params]).toString();
      const raw = await send(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "API-Key": auth.apiKey,
          "API-Sign": krakenSign(auth.secret, path, nonce, body),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      return parseEnvelope(raw);
    });
  } catch (err) {
    return { ok: false, kind: "local_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** An unsigned /0/public GET. No nonce, so it does not wait on the nonce queue. */
async function publicGet(method: string, query: Array<[string, string]>): Promise<KrakenResult<{ result: Record<string, unknown>; status: number }>> {
  const qs = new URLSearchParams(query).toString();
  return parseEnvelope(await send(`${BASE_URL}/0/public/${method}${qs ? `?${qs}` : ""}`, { method: "GET" }));
}

/**
 * A signed Funding (Beta) call. The query string is encoded once and the SAME
 * string is signed and sent. Errors: the docs define 200 responses only; the
 * guide's helper treats any non-2xx as an error with a JSON body of
 * undocumented shape, which is returned as-is.
 */
async function fundingCall(
  auth: KrakenAuth,
  method: "GET" | "POST",
  path: string,
  query: Array<[string, string]>,
  body?: unknown,
): Promise<KrakenResult<{ value: Record<string, unknown>; status: number }>> {
  const qs = new URLSearchParams(query).toString();
  const signedPath = qs ? `${path}?${qs}` : path;
  const data = body === undefined ? "" : JSON.stringify(body);
  try {
    return await auth.nonce.run(async (nonce) => {
      const headers: Record<string, string> = {
        "API-Key": auth.apiKey,
        "API-Sign": krakenSign(auth.secret, signedPath, nonce, data),
        "API-Nonce": nonce,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const raw = await send(`${BASE_URL}${signedPath}`, { method, headers, ...(body !== undefined ? { body: data } : {}) });
      if (!raw.ok) return raw;
      const json = parseJson(raw.text);
      if (raw.status < 200 || raw.status >= 300) {
        return { ok: false, kind: "http_error", httpStatus: raw.status, body: json.ok ? json.value : null, text: excerpt(raw.text) };
      }
      if (!json.ok || !json.value || typeof json.value !== "object" || Array.isArray(json.value)) {
        return { ok: false, kind: "bad_response", httpStatus: raw.status, detail: `not a JSON object: ${excerpt(raw.text)}` };
      }
      return { ok: true, warnings: [], value: json.value as Record<string, unknown>, status: raw.status };
    });
  } catch (err) {
    return { ok: false, kind: "local_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Field parsing and argument validation
// ───────────────────────────────────────────────────────────────────────────

/** A decimal string or a number (Kraken's examples use both) → a finite number, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

class Bad extends Error {}
function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Bad(what);
  return v;
}

/** Map a parse of a successful response, turning a missing field into bad_response. */
function parsed<T, U>(r: KrakenResult<T>, httpStatus: number, f: (ok: T) => U): KrakenResult<U> {
  if (!r.ok) return r;
  try {
    return { ok: true, warnings: r.warnings, ...f(r) };
  } catch (err) {
    if (err instanceof Bad) return { ok: false, kind: "bad_response", httpStatus, detail: `missing or malformed: ${err.message}` };
    throw err;
  }
}

/** Kraken's decimal pattern (Funding schemas). Amounts are always written in fixed notation. */
const DECIMAL = /^[+-]?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))$/;

/** A positive amount as a fixed-decimal string; null if it is not one. Never String(n): String(1e-7) is "1e-7". */
export function fixedAmount(n: number, decimals: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toFixed(decimals);
  return DECIMAL.test(s) && Number(s) > 0 ? s : null;
}

const UUID = /^[0-9a-fA-F]{8}-?(?:[0-9a-fA-F]{4}-?){3}[0-9a-fA-F]{12}$/;
const ADDRESS_ID = /^AB[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}-[a-zA-Z0-9]{6}$/;
const TXID_LIKE = /^[A-Za-z0-9-]{1,64}$/;

/** cl_ord_id formats (AddOrder): a long UUID, a short UUID, or free ASCII text up to 18 characters. */
export function isValidClOrdId(id: string): boolean {
  return (
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id) ||
    /^[0-9a-fA-F]{32}$/.test(id) ||
    /^[\x21-\x7e]{1,18}$/.test(id)
  );
}

const invalid = (detail: string): KrakenFailure => ({ ok: false, kind: "invalid_request", detail });
/** The HTTP status a result came with (internal results carry it on success too). */
const statusOf = (r: KrakenResult<{ status: number }>) => (r.ok ? r.status : "httpStatus" in r ? r.httpStatus : 0);

// ───────────────────────────────────────────────────────────────────────────
// /0 endpoints
// ───────────────────────────────────────────────────────────────────────────

export interface KrakenBalance {
  balance: number;
  holdTrade: number;
  credit: number;
  creditUsed: number;
  /** balance + credit - credit_used - hold_trade (BalanceEx's documented formula). */
  available: number;
}

/** POST /0/private/BalanceEx — every asset the account holds, keyed by Kraken's asset code. */
export async function krakenGetBalances(auth: KrakenAuth): Promise<KrakenResult<{ balances: Record<string, KrakenBalance> }>> {
  const r = await privateCall(auth, "BalanceEx", []);
  return parsed(r, statusOf(r), ({ result }) => {
    const balances: Record<string, KrakenBalance> = {};
    for (const [asset, v] of Object.entries(result)) {
      const e = (v ?? {}) as Record<string, unknown>;
      const balance = need(num(e.balance), `${asset}.balance`);
      const holdTrade = need(num(e.hold_trade), `${asset}.hold_trade`);
      const credit = e.credit === undefined ? 0 : need(num(e.credit), `${asset}.credit`);
      const creditUsed = e.credit_used === undefined ? 0 : need(num(e.credit_used), `${asset}.credit_used`);
      balances[asset] = { balance, holdTrade, credit, creditUsed, available: balance + credit - creditUsed - holdTrade };
    }
    return { balances };
  });
}

export interface MarketBuyInput {
  /** USD to spend: sent as the order volume with oflags=viqc (volume in quote currency). */
  quoteUsd: number;
  /** The client order id (P4 derives it from the run id). */
  clOrdId: string;
}

/** The AddOrder body for a USD market buy of BTC. Pure: shared by the real call and the validate-only call. */
function marketBuyParams(input: MarketBuyInput): Array<[string, string]> | KrakenFailure {
  const volume = fixedAmount(input.quoteUsd, 2);
  if (volume === null) return invalid(`quoteUsd must be a positive amount, got ${input.quoteUsd}`);
  if (!isValidClOrdId(input.clOrdId)) return invalid(`cl_ord_id is not a documented format: ${JSON.stringify(input.clOrdId)}`);
  return [
    ["ordertype", "market"],
    ["type", "buy"],
    ["pair", KRAKEN_PAIR_BTC_USD],
    ["volume", volume],
    ["oflags", "viqc"],
    ["cl_ord_id", input.clOrdId],
  ];
}

/**
 * OUTFLOW PRIMITIVE. POST /0/private/AddOrder: a USD market buy of BTC. On
 * timeout or network failure the order may or may not exist; P4 reconciles by
 * cl_ord_id (krakenFindOrderByClOrdId) and never re-sends blind.
 */
export async function krakenPlaceMarketBuy(
  auth: KrakenAuth,
  input: MarketBuyInput,
): Promise<KrakenResult<{ txids: string[]; description: string | null }>> {
  const params = marketBuyParams(input);
  if (!Array.isArray(params)) return params;
  const r = await privateCall(auth, "AddOrder", params);
  return parsed(r, statusOf(r), ({ result }) => {
    const txid = result.txid;
    if (!Array.isArray(txid) || txid.length === 0 || !txid.every((t) => typeof t === "string")) throw new Bad("txid");
    const descr = (result.descr ?? {}) as Record<string, unknown>;
    return { txids: txid as string[], description: str(descr.order) };
  });
}

/** POST /0/private/AddOrder with validate=true: Kraken checks the order and does NOT trade (E10 step 1). */
export async function krakenValidateMarketBuy(
  auth: KrakenAuth,
  input: MarketBuyInput,
): Promise<KrakenResult<{ description: string | null }>> {
  const params = marketBuyParams(input);
  if (!Array.isArray(params)) return params;
  const r = await privateCall(auth, "AddOrder", [...params, ["validate", "true"]]);
  return parsed(r, statusOf(r), ({ result }) => {
    const descr = (result.descr ?? {}) as Record<string, unknown>;
    return { description: str(descr.order) };
  });
}

export interface KrakenOrder {
  txid: string;
  /** Kraken's status word as sent: pending | open | closed | canceled | expired. P4 maps it. */
  status: string;
  clOrdId: string | null;
  /** Executed volume, base currency (BTC). */
  volExec: number;
  /** Total cost, quote currency (USD). */
  cost: number;
  fee: number;
  /** Average price, quote currency. */
  avgPrice: number | null;
  openTm: number | null;
  closeTm: number | null;
  reason: string | null;
}

function parseOrder(txid: string, v: unknown): KrakenOrder {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    txid,
    status: need(str(o.status), `${txid}.status`),
    clOrdId: str(o.cl_ord_id),
    volExec: need(num(o.vol_exec), `${txid}.vol_exec`),
    cost: need(num(o.cost), `${txid}.cost`),
    fee: need(num(o.fee), `${txid}.fee`),
    avgPrice: num(o.price),
    openTm: num(o.opentm),
    closeTm: num(o.closetm),
    reason: str(o.reason),
  };
}

/**
 * POST /0/private/QueryOrders for one txid. Needs "Query open orders & trades"
 * or "Query closed orders & trades" by the order's status (ruling K1 adds the
 * second to the key). `order` is null when Kraken returns no such order.
 */
export async function krakenQueryOrder(auth: KrakenAuth, txid: string): Promise<KrakenResult<{ order: KrakenOrder | null }>> {
  if (!TXID_LIKE.test(txid)) return invalid(`txid is malformed: ${JSON.stringify(txid)}`);
  const r = await privateCall(auth, "QueryOrders", [["txid", txid]]);
  return parsed(r, statusOf(r), ({ result }) => ({ order: result[txid] === undefined ? null : parseOrder(txid, result[txid]) }));
}

/**
 * Reconciliation after an unknown AddOrder outcome: the order carrying
 * `clOrdId`, if any. QueryOrders requires a txid, so this asks OpenOrders and
 * then ClosedOrders, which both filter by cl_ord_id (two calls at most).
 */
export async function krakenFindOrderByClOrdId(auth: KrakenAuth, clOrdId: string): Promise<KrakenResult<{ order: KrakenOrder | null }>> {
  if (!isValidClOrdId(clOrdId)) return invalid(`cl_ord_id is not a documented format: ${JSON.stringify(clOrdId)}`);
  for (const [method, key] of [["OpenOrders", "open"], ["ClosedOrders", "closed"]] as const) {
    const r = await privateCall(auth, method, [["cl_ord_id", clOrdId]]);
    const found = parsed(r, statusOf(r), ({ result }) => {
      const orders = result[key];
      if (!orders || typeof orders !== "object" || Array.isArray(orders)) throw new Bad(key);
      const hit = Object.entries(orders as Record<string, unknown>).find(([, o]) => (o as Record<string, unknown>)?.cl_ord_id === clOrdId);
      return { order: hit ? parseOrder(hit[0], hit[1]) : null };
    });
    if (!found.ok || found.order) return found;
  }
  return { ok: true, warnings: [], order: null };
}

export interface KrakenApiKeyInfo {
  permissions: string[];
  apiKeyName: string | null;
  nonceWindow: number | null;
  ipAllowlist: string[];
}

/** POST /0/private/GetApiKeyInfo (no permission needed). Accepts snake_case and camelCase: the docs' schema and example disagree. */
export async function krakenGetApiKeyInfo(auth: KrakenAuth): Promise<KrakenResult<{ info: KrakenApiKeyInfo }>> {
  const r = await privateCall(auth, "GetApiKeyInfo", []);
  return parsed(r, statusOf(r), ({ result }) => {
    const pick = (snake: string, camel: string) => (result[snake] !== undefined ? result[snake] : result[camel]);
    const permissions = pick("permissions", "permissions");
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string")) throw new Bad("permissions");
    const allow = pick("ip_allowlist", "ipAllowlist");
    return {
      info: {
        permissions: permissions as string[],
        apiKeyName: str(pick("api_key_name", "apiKeyName")),
        nonceWindow: num(pick("nonce_window", "nonceWindow")),
        ipAllowlist: Array.isArray(allow) ? allow.filter((a): a is string => typeof a === "string") : [],
      },
    };
  });
}

export interface KrakenPairInfo {
  key: string;
  altname: string;
  /** Minimum order size, base currency (BTC). */
  ordermin: number;
  /** Minimum order cost, quote currency (USD). */
  costmin: number | null;
  costDecimals: number | null;
  lotDecimals: number | null;
  /** online | cancel_only | post_only | limit_only | reduce_only */
  status: string | null;
}

/** GET /0/public/AssetPairs?pair=XBTUSD (unsigned): the minimums STOP 2's ruling reads. */
export async function krakenGetAssetPair(): Promise<KrakenResult<{ pair: KrakenPairInfo }>> {
  const r = await publicGet("AssetPairs", [["pair", KRAKEN_PAIR_BTC_USD]]);
  return parsed(r, statusOf(r), ({ result }) => {
    const entries = Object.entries(result);
    const hit = entries.find(([, v]) => (v as Record<string, unknown>)?.altname === KRAKEN_PAIR_BTC_USD) ?? (entries.length === 1 ? entries[0] : undefined);
    if (!hit) throw new Bad(KRAKEN_PAIR_BTC_USD);
    const p = hit[1] as Record<string, unknown>;
    return {
      pair: {
        key: hit[0],
        altname: need(str(p.altname), "altname"),
        ordermin: need(num(p.ordermin), "ordermin"),
        costmin: num(p.costmin),
        costDecimals: num(p.cost_decimals),
        lotDecimals: num(p.lot_decimals),
        status: str(p.status),
      },
    };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Funding (Beta) endpoints
// ───────────────────────────────────────────────────────────────────────────

const BTC_ASSET_QUERY: Array<[string, string]> = [
  ["asset[class]", KRAKEN_FUNDING_BTC.class],
  ["asset[name]", KRAKEN_FUNDING_BTC.name],
];

/** A funding amount, flat ({asset, amount}) or wrapped ({asset_amount: {asset, amount}}) as the endpoint sends it. */
function fundingAmount(v: unknown, what: string): number {
  const o = (v ?? {}) as Record<string, unknown>;
  const inner = (o.asset_amount ?? o) as Record<string, unknown>;
  return need(num(inner.amount), what);
}

const cursorOf = (value: Record<string, unknown>) => str(value.next_cursor);

export interface KrakenWithdrawMethod {
  methodId: string;
  methodName: string | null;
  minimumAmount: number | null;
  maximumAmount: number | null;
  networkName: string | null;
}

/** GET /funding/v1/methods/withdraw?asset[class]=currency&asset[name]=BTC (Query Funds). */
export async function krakenListWithdrawMethods(
  auth: KrakenAuth,
  cursor?: string,
): Promise<KrakenResult<{ methods: KrakenWithdrawMethod[]; nextCursor: string | null }>> {
  // "Do not provide other request parameters with a cursor."
  const r = await fundingCall(auth, "GET", "/funding/v1/methods/withdraw", cursor ? [["cursor", cursor]] : BTC_ASSET_QUERY);
  return parsed(r, statusOf(r), ({ value }) => {
    if (!Array.isArray(value.methods)) throw new Bad("methods");
    return {
      methods: value.methods.map((m: Record<string, unknown>, i: number) => ({
        methodId: need(str(m?.method_id), `methods[${i}].method_id`),
        methodName: str(m?.method_name),
        minimumAmount: num(m?.minimum_amount),
        maximumAmount: num(m?.maximum_amount),
        networkName: str((m?.network as Record<string, unknown> | undefined)?.network_name),
      })),
      nextCursor: cursorOf(value),
    };
  });
}

export interface KrakenSavedAddress {
  addressId: string;
  verified: boolean;
  /** The on-chain address, when the entry is a crypto address. */
  address: string | null;
  name: string | null;
}

/** GET /funding/v1/addresses?scope[method_id]=… (Query Funds): addresses usable with that method. */
export async function krakenListAddresses(
  auth: KrakenAuth,
  methodId: string,
  cursor?: string,
): Promise<KrakenResult<{ addresses: KrakenSavedAddress[]; nextCursor: string | null }>> {
  if (!UUID.test(methodId)) return invalid(`method_id is not a UUID: ${JSON.stringify(methodId)}`);
  const r = await fundingCall(auth, "GET", "/funding/v1/addresses", cursor ? [["cursor", cursor]] : [["scope[method_id]", methodId]]);
  return parsed(r, statusOf(r), ({ value }) => {
    if (!Array.isArray(value.addresses)) throw new Bad("addresses");
    return {
      addresses: value.addresses.map((a: Record<string, unknown>, i: number) => {
        const verified = a?.verified;
        if (typeof verified !== "boolean") throw new Bad(`addresses[${i}].verified`);
        const crypto = ((a?.address_details as Record<string, unknown> | undefined)?.crypto ?? null) as Record<string, unknown> | null;
        return {
          addressId: need(str(a?.address_id), `addresses[${i}].address_id`),
          verified,
          address: crypto ? str(crypto.address) : null,
          name: str(a?.name),
        };
      }),
      nextCursor: cursorOf(value),
    };
  });
}

export interface WithdrawalFeeQuoteInput {
  methodId: string;
  btcAmount: number;
  /** Whether btcAmount includes the fee. The withdrawal must use the same setting as the quote. */
  feeIncluded: boolean;
}

/** GET /funding/v1/fees/{method_id}?amount=…&fee_included=… (Query Funds). The token is valid 5 minutes (E2: quoted_fee). */
export async function krakenQuoteWithdrawalFee(
  auth: KrakenAuth,
  input: WithdrawalFeeQuoteInput,
): Promise<KrakenResult<{ fee: number; grossAmount: number; netAmount: number; feeToken: string | null }>> {
  if (!UUID.test(input.methodId)) return invalid(`method_id is not a UUID: ${JSON.stringify(input.methodId)}`);
  const amount = fixedAmount(input.btcAmount, 8);
  if (amount === null) return invalid(`btcAmount must be a positive amount, got ${input.btcAmount}`);
  const r = await fundingCall(auth, "GET", `/funding/v1/fees/${input.methodId}`, [
    ["amount", amount],
    ["fee_included", input.feeIncluded ? "true" : "false"],
  ]);
  return parsed(r, statusOf(r), ({ value }) => ({
    fee: fundingAmount(value.fee, "fee"),
    grossAmount: fundingAmount(value.gross_amount, "gross_amount"),
    netAmount: fundingAmount(value.net_amount, "net_amount"),
    feeToken: str(value.withdrawal_fee_token),
  }));
}

export interface CreateWithdrawalInput {
  methodId: string;
  addressId: string;
  btcAmount: number;
  /** The token from krakenQuoteWithdrawalFee (E2: quoted_fee). */
  feeToken: string;
  /** Must match the quote's fee_included. */
  feeIncluded: boolean;
  /** The node's withdraw_address: Kraken refuses the withdrawal unless it matches address_id's stored address. */
  expectedAddress: string;
}

/**
 * OUTFLOW PRIMITIVE. POST /funding/v1/withdrawals (Withdraw Funds). The call has
 * no idempotency field: on timeout or network failure the withdrawal may exist,
 * and P4 must check krakenListWithdrawals before anything else (spec §4).
 * approvalRequestId is set when Kraken parks the withdrawal for approval.
 */
export async function krakenCreateWithdrawal(
  auth: KrakenAuth,
  input: CreateWithdrawalInput,
): Promise<KrakenResult<{ withdrawalId: string; approvalRequestId: string | null; netAmount: number; grossAmount: number; fee: number }>> {
  if (!UUID.test(input.methodId)) return invalid(`method_id is not a UUID: ${JSON.stringify(input.methodId)}`);
  if (!ADDRESS_ID.test(input.addressId)) return invalid(`address_id is malformed: ${JSON.stringify(input.addressId)}`);
  const amount = fixedAmount(input.btcAmount, 8);
  if (amount === null) return invalid(`btcAmount must be a positive amount, got ${input.btcAmount}`);
  if (!input.feeToken) return invalid("feeToken is empty");
  if (!input.expectedAddress) return invalid("expectedAddress is empty");
  const body = {
    scope: { method_id: input.methodId },
    address_id: input.addressId,
    amount: { asset_amount: { asset: { class: KRAKEN_FUNDING_BTC.class, name: KRAKEN_FUNDING_BTC.name }, amount } },
    fee: { quoted_fee: { token: input.feeToken }, fee_included: input.feeIncluded },
    expected_address: input.expectedAddress,
  };
  const r = await fundingCall(auth, "POST", "/funding/v1/withdrawals", [], body);
  return parsed(r, statusOf(r), ({ value }) => ({
    withdrawalId: need(str(value.withdrawal_id), "withdrawal_id"),
    approvalRequestId: str(value.approval_request_id),
    netAmount: fundingAmount(value.net_amount, "net_amount"),
    grossAmount: fundingAmount(value.gross_amount, "gross_amount"),
    fee: fundingAmount(value.fee, "fee"),
  }));
}

export interface KrakenWithdrawal {
  withdrawalId: string;
  /** pending | success | failed, as sent. P4 maps it. */
  status: string;
  amount: number | null;
  fee: number | null;
  methodId: string | null;
  addressId: string | null;
  createTime: string | null;
  /** The on-chain transaction hash, when available. */
  txHash: string | null;
}

/** GET /funding/v1/withdrawals?asset[class]=currency&asset[name]=BTC&limit=… (Query Funds), newest first. */
export async function krakenListWithdrawals(
  auth: KrakenAuth,
  opts: { limit?: number; cursor?: string } = {},
): Promise<KrakenResult<{ withdrawals: KrakenWithdrawal[]; nextCursor: string | null }>> {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return invalid(`limit must be 1–500, got ${limit}`);
  // With a cursor, the cursor alone identifies the page.
  const query: Array<[string, string]> = opts.cursor ? [["cursor", opts.cursor]] : [...BTC_ASSET_QUERY, ["limit", String(limit)]];
  const r = await fundingCall(auth, "GET", "/funding/v1/withdrawals", query);
  return parsed(r, statusOf(r), ({ value }) => {
    if (!Array.isArray(value.withdrawals)) throw new Bad("withdrawals");
    return {
      withdrawals: value.withdrawals.map((w: Record<string, unknown>, i: number) => {
        const amt = w?.amount === undefined ? null : fundingAmount(w.amount, `withdrawals[${i}].amount`);
        const fee = w?.fee === undefined ? null : fundingAmount(w.fee, `withdrawals[${i}].fee`);
        return {
          withdrawalId: need(str(w?.withdrawal_id), `withdrawals[${i}].withdrawal_id`),
          status: need(str(w?.status), `withdrawals[${i}].status`),
          amount: amt,
          fee,
          methodId: str(w?.method_id),
          addressId: str(w?.address_id),
          createTime: str(w?.create_time),
          txHash: str(w?.onchain_transaction),
        };
      }),
      nextCursor: cursorOf(value),
    };
  });
}
