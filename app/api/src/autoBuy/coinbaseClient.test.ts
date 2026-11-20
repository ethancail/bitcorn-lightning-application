// P0 Suite A — characterization of the Coinbase client (coinbaseClient.ts).
//
// Authority: bitcorn-research/specs/2026-11-18-kraken-autobuy-slice-1-spec.md
// §3 P0 (Suite A), decision D3. This suite PINS CURRENT BEHAVIOUR. A case that
// reads like a defect (A16, A18b, A20b) is pinned as it is and listed in the
// P0 report as a finding; it is not fixed here.
//
// Mock boundary: global fetch only (vi.stubGlobal). The module under test is
// real, and so is the JWT: a P-256 key pair is generated per file, exported as
// both SEC1 and PKCS#8 PEM, and every signature is checked against the public
// key. No network: fetch is a stub for every case.
//
// Module state: the client has none, so no reset is needed.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, type KeyObject } from "crypto";
import { compactVerify, decodeJwt, decodeProtectedHeader } from "jose";
import {
  listAccounts,
  placeMarketBuy,
  placeWithdraw,
  pollOrder,
  pollWithdraw,
  type CoinbaseCredentials,
} from "./coinbaseClient";

/** 2026-09-20T12:00:00Z. */
const NOW = 1789905600;
const KEY_NAME = "organizations/org-1/apiKeys/key-1";

let publicKey: KeyObject;
let sec1Pem: string;
let pkcs8Pem: string;
let creds: CoinbaseCredentials;

const fetchMock = vi.fn();

beforeAll(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  publicKey = pair.publicKey;
  sec1Pem = pair.privateKey.export({ type: "sec1", format: "pem" }).toString();
  pkcs8Pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  creds = { keyName: KEY_NAME, privateKeyPem: sec1Pem };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const respond = (status: number, body: string) =>
  fetchMock.mockResolvedValueOnce(new Response(body, { status }));
const respondJson = (status: number, body: unknown) => respond(status, JSON.stringify(body));

/** The single fetch call's [url, init]. */
function onlyCall(): [string, RequestInit & { headers: Record<string, string> }] {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0] as any;
}

function bearer(init: { headers: Record<string, string> }): string {
  const auth = init.headers.Authorization;
  expect(auth.startsWith("Bearer ")).toBe(true);
  return auth.slice("Bearer ".length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Request shapes (spec: :128, :146-153, :179, :196-206, :225; Content-Type only
// with a body, :83)
// ─────────────────────────────────────────────────────────────────────────────
describe("A · request shapes", () => {
  it("A1 listAccounts: GET /api/v3/brokerage/accounts, Bearer auth, no body, no Content-Type", async () => {
    respondJson(200, { accounts: [] });
    await listAccounts(creds);

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.coinbase.com/api/v3/brokerage/accounts");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers)).toEqual(["Authorization"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("A2 placeMarketBuy USD: POST /api/v3/brokerage/orders, product BTC-USD, side BUY, Content-Type sent", async () => {
    respondJson(200, { success: true, order_id: "o-1" });
    await placeMarketBuy(creds, 25, "USD");

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.coinbase.com/api/v3/brokerage/orders");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.product_id).toBe("BTC-USD");
    expect(body.side).toBe("BUY");
    expect(Object.keys(body)).toEqual(["client_order_id", "product_id", "side", "order_configuration"]);
    expect(decodeJwt(bearer(init)).uri).toBe("POST api.coinbase.com/api/v3/brokerage/orders");
  });

  it("A3 placeMarketBuy USDC: product BTC-USDC", async () => {
    respondJson(200, { success: true, order_id: "o-1" });
    await placeMarketBuy(creds, 25, "USDC");
    const [, init] = onlyCall();
    expect(JSON.parse(init.body as string).product_id).toBe("BTC-USDC");
  });

  it("A4 quote_size is toFixed(2) under market_market_ioc", async () => {
    respondJson(200, { success: true, order_id: "o-1" });
    await placeMarketBuy(creds, 12.3, "USD");
    const [, init] = onlyCall();
    expect(JSON.parse(init.body as string).order_configuration).toEqual({
      market_market_ioc: { quote_size: "12.30" },
    });
  });

  it("A5 client_order_id is autobuy-<Date.now()>-<base36>", async () => {
    respondJson(200, { success: true, order_id: "o-1" });
    await placeMarketBuy(creds, 10, "USD");
    const [, init] = onlyCall();
    expect(JSON.parse(init.body as string).client_order_id).toMatch(new RegExp(`^autobuy-${NOW * 1000}-[0-9a-z]+$`));
  });

  it("A8 pollOrder: GET /orders/historical/<encodeURIComponent(id)>, no Content-Type, order returned unvalidated", async () => {
    const order = { order_id: "ord/1 x", status: "NOT_A_STATUS", extra: 1 };
    respondJson(200, { order });
    const res = await pollOrder(creds, "ord/1 x");

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.coinbase.com/api/v3/brokerage/orders/historical/ord%2F1%20x");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers)).toEqual(["Authorization"]);
    expect(decodeJwt(bearer(init)).uri).toBe("GET api.coinbase.com/api/v3/brokerage/orders/historical/ord%2F1%20x");
    expect(res).toEqual({ ok: true, order });
  });

  it("A9 placeWithdraw: POST /v2/accounts/<enc>/transactions, body {type:send, to, amount: toFixed(8), currency: BTC}", async () => {
    respondJson(201, { data: { id: "tx-1" } });
    const res = await placeWithdraw(creds, "acct/1", "bc1qdest", 0.000123456789);

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.coinbase.com/v2/accounts/acct%2F1/transactions");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      type: "send",
      to: "bc1qdest",
      amount: "0.00012346",
      currency: "BTC",
    });
    expect(res).toEqual({ ok: true, transaction_id: "tx-1" });
  });

  it("A10 pollWithdraw: GET /v2/accounts/<enc>/transactions/<enc>, no Content-Type", async () => {
    respondJson(200, { data: { id: "tx 1", status: "pending" } });
    await pollWithdraw(creds, "acct/1", "tx 1");

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.coinbase.com/v2/accounts/acct%2F1/transactions/tx%201");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers)).toEqual(["Authorization"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeMarketBuy's order id and its error precedence (spec: :161-165)
// ─────────────────────────────────────────────────────────────────────────────
describe("A · placeMarketBuy response handling", () => {
  it("A6a order_id is read from the top level", async () => {
    respondJson(200, { success: true, order_id: "top", success_response: { order_id: "nested" } });
    expect(await placeMarketBuy(creds, 10, "USD")).toEqual({ ok: true, order_id: "top" });
  });

  it("A6b order_id falls back to success_response.order_id", async () => {
    respondJson(200, { success: true, success_response: { order_id: "nested" } });
    expect(await placeMarketBuy(creds, 10, "USD")).toEqual({ ok: true, order_id: "nested" });
  });

  it("A7a a 200 with no order id: error_response.message wins over .error", async () => {
    respondJson(200, { success: false, error_response: { error: "INSUFFICIENT_FUND", message: "Insufficient balance" } });
    expect(await placeMarketBuy(creds, 10, "USD")).toEqual({ ok: false, status: 200, error: "Insufficient balance" });
  });

  it("A7b a 200 with no order id and no message: error_response.error", async () => {
    respondJson(200, { success: false, error_response: { error: "INSUFFICIENT_FUND" } });
    expect(await placeMarketBuy(creds, 10, "USD")).toEqual({ ok: false, status: 200, error: "INSUFFICIENT_FUND" });
  });

  it("A7c a 200 with neither: no_order_id_in_response", async () => {
    respondJson(200, { success: true });
    expect(await placeMarketBuy(creds, 10, "USD")).toEqual({ ok: false, status: 200, error: "no_order_id_in_response" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pollWithdraw's unvalidated cast (spec: :230)
// ─────────────────────────────────────────────────────────────────────────────
describe("A · pollWithdraw normalisation", () => {
  it("A11a status passes through the cast unvalidated; network.hash -> network_tx_hash", async () => {
    respondJson(200, { data: { id: "tx-1", status: "weird", network: { hash: "abc123" } } });
    expect(await pollWithdraw(creds, "acct", "tx-1")).toEqual({
      ok: true,
      withdraw: { transaction_id: "tx-1", status: "weird", network_tx_hash: "abc123" },
    });
  });

  it("A11b no network object -> network_tx_hash undefined", async () => {
    respondJson(200, { data: { id: "tx-1", status: "completed" } });
    const res = await pollWithdraw(creds, "acct", "tx-1");
    expect(res).toEqual({ ok: true, withdraw: { transaction_id: "tx-1", status: "completed", network_tx_hash: undefined } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT (spec: :50, :52-59)
// ─────────────────────────────────────────────────────────────────────────────
describe("A · the JWT", () => {
  it("A12 protected header is exactly {alg: ES256, kid: keyName, typ: JWT}", async () => {
    respondJson(200, { accounts: [] });
    await listAccounts(creds);
    const [, init] = onlyCall();
    expect(decodeProtectedHeader(bearer(init))).toEqual({ alg: "ES256", kid: KEY_NAME, typ: "JWT" });
  });

  it("A13 claims are exactly {sub, iss: cdp, nbf: now, exp: now+120, uri: '<METHOD> api.coinbase.com<path>'}", async () => {
    respondJson(200, { accounts: [] });
    await listAccounts(creds);
    const [, init] = onlyCall();
    expect(decodeJwt(bearer(init))).toEqual({
      sub: KEY_NAME,
      iss: "cdp",
      nbf: NOW,
      exp: NOW + 120,
      uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
    });
  });

  it("A14 a SEC1 (BEGIN EC PRIVATE KEY) key signs a JWT the public key verifies", async () => {
    expect(sec1Pem).toContain("BEGIN EC PRIVATE KEY");
    respondJson(200, { accounts: [] });
    await listAccounts({ keyName: KEY_NAME, privateKeyPem: sec1Pem });
    const [, init] = onlyCall();
    await expect(compactVerify(bearer(init), publicKey)).resolves.toBeDefined();
  });

  it("A15 a PKCS#8 (BEGIN PRIVATE KEY) key signs a JWT the public key verifies", async () => {
    expect(pkcs8Pem).toContain("BEGIN PRIVATE KEY");
    respondJson(200, { accounts: [] });
    await listAccounts({ keyName: KEY_NAME, privateKeyPem: pkcs8Pem });
    const [, init] = onlyCall();
    await expect(compactVerify(bearer(init), publicKey)).resolves.toBeDefined();
  });

  it("A16 [+] a non-PEM key REJECTS (it does not return {ok:false}) and fetch is never called — signJwt runs outside the try (:79)", async () => {
    await expect(listAccounts({ keyName: KEY_NAME, privateKeyPem: "not a pem" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status handling (spec: :95-111)
// ─────────────────────────────────────────────────────────────────────────────
describe("A · status handling", () => {
  it("A17a non-2xx -> {ok:false, status, error: body sliced to 500}", async () => {
    respond(500, "e".repeat(600));
    const res = await listAccounts(creds);
    expect(res).toEqual({ ok: false, status: 500, error: "e".repeat(500) });
  });

  it("A17b a 401 passes its status through", async () => {
    respond(401, "Unauthorized");
    expect(await listAccounts(creds)).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  });

  it("A18 empty 2xx -> {ok:true, status, data: undefined}", async () => {
    respond(200, "");
    expect(await listAccounts(creds)).toEqual({ ok: true, status: 200, data: undefined });
  });

  it("A18b [+][N] empty 200 on placeMarketBuy throws a TypeError (res.data.order_id, :161)", async () => {
    respond(200, "");
    await expect(placeMarketBuy(creds, 10, "USD")).rejects.toThrow(TypeError);
  });

  // REFUTED reading (P0 Phase 1 plan): "pollOrder returns order: undefined on an
  // empty 200". Observed on the base: it throws too — res.data is undefined, so
  // res.data.order (:182) is a TypeError like the others. Pinned as observed.
  it("A18c [+][N, refuted] empty 200 on pollOrder ALSO throws a TypeError (res.data.order, :182)", async () => {
    respond(200, "");
    await expect(pollOrder(creds, "o-1")).rejects.toThrow(TypeError);
  });

  it("A18d [+][N] empty 200 on placeWithdraw and pollWithdraw throws a TypeError (:209, :229)", async () => {
    respond(200, "");
    await expect(placeWithdraw(creds, "acct", "bc1qdest", 0.001)).rejects.toThrow(TypeError);
    respond(200, "");
    await expect(pollWithdraw(creds, "acct", "tx-1")).rejects.toThrow(TypeError);
  });

  it("A19 non-JSON 2xx -> {ok:false, status, error: 'non_json_response: ' + first 200 chars}", async () => {
    const html = "<html>" + "x".repeat(300);
    respond(200, html);
    expect(await listAccounts(creds)).toEqual({
      ok: false,
      status: 200,
      error: `non_json_response: ${html.slice(0, 200)}`,
    });
  });

  it("A20a fetch rejects with an Error -> {ok:false, status:0, error: its message}", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await listAccounts(creds)).toEqual({ ok: false, status: 0, error: "ECONNRESET" });
  });

  it("A20b [+] any Error whose message contains 'abort' is reported as the timeout", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket aborted by peer"));
    expect(await listAccounts(creds)).toEqual({ ok: false, status: 0, error: "timeout_after_30000ms" });
  });

  it("A21 a hung fetch is aborted at exactly 30 s -> {ok:false, status:0, error: timeout_after_30000ms}", async () => {
    let called!: () => void;
    const fetchCalled = new Promise<void>((r) => (called = r));
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      called();
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    });

    let settled = false;
    const pending = listAccounts(creds).finally(() => (settled = true));
    await fetchCalled;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, status: 0, error: "timeout_after_30000ms" });
  });

  it("A22 a non-Error rejection -> String(err)", async () => {
    fetchMock.mockRejectedValueOnce("boom");
    expect(await listAccounts(creds)).toEqual({ ok: false, status: 0, error: "boom" });
  });
});
