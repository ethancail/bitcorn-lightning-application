// kraken-autobuy P3: the hand-written Kraken client, against fetch mocks of the
// documented shapes only. No call leaves the process: global fetch is stubbed
// for every case (spec §3 P3).
//
// Done-when → cases:
//   · each request's path, headers and body match the documented shape → R1–R12
//   · a non-empty error array is a failure, even with HTTP 200       → E1 (as
//     narrowed by Ethan's ruling K3: an array of ONLY W-severity warnings with
//     a valid result is success, and the warnings are returned → K3)
//   · nonces strictly increase                                        → N1 here,
//     and krakenNonce.test.ts T1–T8
//   · signatures: S1 is Kraken's PUBLISHED vector (/0 auth guide). Kraken
//     publishes none for Funding (Beta), so S2 computes the expected API-Sign
//     through WebCrypto (crypto.subtle), a code path separate from the
//     client's createHmac.
//
// Sources: docs.kraken.com/exchange/guides/rest/authentication,
// .../exchange/guides/rest/funding, docs.kraken.com/openapi/spot-rest.yaml.

import fs from "fs";
import path from "path";
import { webcrypto } from "crypto";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonceSource, type NonceStore } from "./krakenNonce";
import {
  KRAKEN_REQUEST_TIMEOUT_MS,
  fixedAmount,
  isValidClOrdId,
  krakenCreateWithdrawal,
  krakenFindOrderByClOrdId,
  krakenGetApiKeyInfo,
  krakenGetAssetPair,
  krakenGetBalances,
  krakenListAddresses,
  krakenListWithdrawals,
  krakenListWithdrawMethods,
  krakenPlaceMarketBuy,
  krakenQueryOrder,
  krakenQuoteWithdrawalFee,
  krakenSign,
  krakenValidateMarketBuy,
  type KrakenAuth,
} from "./krakenClient";

// ─── Kraken's published example (/0 authentication guide) ─────────────────
const DOC_SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";
const DOC_NONCE = "1616492376594";
const DOC_PAYLOAD = "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
const DOC_PATH = "/0/private/AddOrder";
const DOC_SIGN = "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==";

/** API-Sign by an INDEPENDENT path: WebCrypto's SHA-256 and HMAC-SHA-512, not the client's createHash/createHmac. */
async function subtleSign(secretB64: string, signedPath: string, nonce: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const inner = new Uint8Array(await webcrypto.subtle.digest("SHA-256", enc.encode(nonce + data)));
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(secretB64, "base64"), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const msg = new Uint8Array([...enc.encode(signedPath), ...inner]);
  return Buffer.from(await webcrypto.subtle.sign("HMAC", key, msg)).toString("base64");
}

const T = 1_894_017_600_000;
const API = "https://api.kraken.com";
const METHOD_ID = "d4ec4d52-b159-428e-ba64-f45455a978a1";
const ADDRESS_ID = "ABR6SXP-SF6CY-VJMONY";
const TXID = "OU22CG-KLAF2-FWUDD7";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal | undefined };
let calls: Call[];
let responder: (c: Call) => Promise<Response> | Response;
let store: NonceStore & { value: bigint | null };
let auth: KrakenAuth;

function memStore(): NonceStore & { value: bigint | null } {
  const s = { value: null as bigint | null, load: () => s.value, save: (n: bigint) => { s.value = n; } };
  return s;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok0 = (result: unknown) => json({ error: [], result });
/** Respond to calls in order with these responses. */
const sequence = (...rs: Array<() => Response>) => { let i = 0; responder = () => rs[Math.min(i++, rs.length - 1)](); };

beforeEach(() => {
  calls = [];
  store = memStore();
  auth = { apiKey: "PUBLIC-KEY", secret: DOC_SECRET, nonce: createNonceSource(store, () => T) };
  responder = () => ok0({});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body === undefined ? undefined : String(init.body),
      signal: init.signal ?? undefined,
    };
    calls.push(c);
    return responder(c);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BUY = { quoteUsd: 25, clOrdId: "bc-42-tx5kq0" };
const ORDER = { status: "closed", cl_ord_id: "bc-42-tx5kq0", vol_exec: "0.00025000", cost: "24.98", fee: "0.10", price: "99920.0", opentm: 1894017600.1, closetm: 1894017600.4, reason: null };
const WITHDRAW = { methodId: METHOD_ID, addressId: ADDRESS_ID, btcAmount: 0.00123456, feeToken: "TOKEN-1", feeIncluded: true, expectedAddress: "bc1qnodeaddress" };
const WD_RESPONSE = {
  withdrawal_id: "FTVZiTI-e02T84mm87JmibnObWNdnW",
  net_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00121456" } },
  gross_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00123456" } },
  fee: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00002000" } },
};

// ─────────────────────────────────────────────────────────────────────────────
describe("S · signatures", () => {
  it("S1 Kraken's published /0 example: krakenSign reproduces its API-Sign exactly", () => {
    expect(krakenSign(DOC_SECRET, DOC_PATH, DOC_NONCE, DOC_PAYLOAD)).toBe(DOC_SIGN);
  });

  it("S1b the independent WebCrypto path agrees with Kraken's example too (so S2's oracle is itself checked)", async () => {
    expect(await subtleSign(DOC_SECRET, DOC_PATH, DOC_NONCE, DOC_PAYLOAD)).toBe(DOC_SIGN);
  });

  it("S2 /0 and Funding requests carry the API-Sign that the independent path computes over exactly what was sent", async () => {
    sequence(() => ok0({}), () => json({ methods: [] }), () => json(WD_RESPONSE));
    await krakenGetBalances(auth);
    await krakenListWithdrawMethods(auth);
    await krakenCreateWithdrawal(auth, WITHDRAW);
    const [bal, methods, create] = calls;

    expect(bal.headers["API-Sign"]).toBe(await subtleSign(DOC_SECRET, "/0/private/BalanceEx", String(T), bal.body!));
    // Funding GET: the signed path INCLUDES the query string; the data is empty; the nonce is the header.
    const u = new URL(methods.url);
    expect(u.search).not.toBe("");
    expect(methods.headers["API-Sign"]).toBe(await subtleSign(DOC_SECRET, u.pathname + u.search, methods.headers["API-Nonce"], ""));
    // Funding POST: the data is the exact JSON body sent.
    expect(create.headers["API-Sign"]).toBe(await subtleSign(DOC_SECRET, "/funding/v1/withdrawals", create.headers["API-Nonce"], create.body!));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R · request shapes", () => {
  const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));
  const privateHeaders = (c: Call) => {
    expect(c.method).toBe("POST");
    expect(c.headers["API-Key"]).toBe("PUBLIC-KEY");
    expect(c.headers["API-Sign"]).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(c.headers["API-Nonce"]).toBeUndefined();
  };
  const fundingGet = (c: Call) => {
    expect(c.method).toBe("GET");
    expect(c.headers["API-Key"]).toBe("PUBLIC-KEY");
    expect(c.headers["API-Nonce"]).toBe(String(T));
    expect(c.headers["Content-Type"]).toBeUndefined();
    expect(c.body).toBeUndefined();
  };

  it("R1 BalanceEx: POST /0/private/BalanceEx, body = nonce only", async () => {
    await krakenGetBalances(auth);
    expect(calls[0].url).toBe(`${API}/0/private/BalanceEx`);
    privateHeaders(calls[0]);
    expect(calls[0].body).toBe(`nonce=${T}`);
  });

  it("R2 AddOrder (real): a USD market buy, volume in quote currency (viqc), cl_ord_id, NO price, NO validate", async () => {
    responder = () => ok0({ descr: { order: "buy 25.00 XBTUSD @ market" }, txid: [TXID] });
    await krakenPlaceMarketBuy(auth, BUY);
    expect(calls[0].url).toBe(`${API}/0/private/AddOrder`);
    privateHeaders(calls[0]);
    expect(calls[0].body).toBe(`nonce=${T}&ordertype=market&type=buy&pair=XBTUSD&volume=25.00&oflags=viqc&cl_ord_id=bc-42-tx5kq0`);
    expect(form(calls[0])).not.toHaveProperty("price");
    expect(form(calls[0])).not.toHaveProperty("validate");
  });

  it("R3 AddOrder (validate-only): the same body plus validate=true", async () => {
    responder = () => ok0({ descr: { order: "buy 25.00 XBTUSD @ market" } });
    await krakenValidateMarketBuy(auth, BUY);
    expect(calls[0].body).toBe(`nonce=${T}&ordertype=market&type=buy&pair=XBTUSD&volume=25.00&oflags=viqc&cl_ord_id=bc-42-tx5kq0&validate=true`);
  });

  it("R4 QueryOrders: txid", async () => {
    await krakenQueryOrder(auth, TXID);
    expect(calls[0].url).toBe(`${API}/0/private/QueryOrders`);
    privateHeaders(calls[0]);
    expect(calls[0].body).toBe(`nonce=${T}&txid=${TXID}`);
  });

  it("R5 reconciliation by cl_ord_id: OpenOrders, then ClosedOrders, each filtered by cl_ord_id", async () => {
    sequence(() => ok0({ open: {} }), () => ok0({ closed: { [TXID]: ORDER }, count: 1 }));
    const r = await krakenFindOrderByClOrdId(auth, "bc-42-tx5kq0");
    expect(calls.map((c) => c.url)).toEqual([`${API}/0/private/OpenOrders`, `${API}/0/private/ClosedOrders`]);
    expect(calls[0].body).toBe(`nonce=${T}&cl_ord_id=bc-42-tx5kq0`);
    expect(calls[1].body).toBe(`nonce=${T + 1}&cl_ord_id=bc-42-tx5kq0`);
    expect(r.ok && r.order?.txid).toBe(TXID);
  });

  it("R6 GetApiKeyInfo: nonce only", async () => {
    responder = () => ok0({ permissions: [] });
    await krakenGetApiKeyInfo(auth);
    expect(calls[0].url).toBe(`${API}/0/private/GetApiKeyInfo`);
    privateHeaders(calls[0]);
    expect(calls[0].body).toBe(`nonce=${T}`);
  });

  it("R7 AssetPairs: an UNSIGNED GET /0/public/AssetPairs?pair=XBTUSD that consumes no nonce", async () => {
    responder = () => ok0({ XXBTZUSD: { altname: "XBTUSD", ordermin: "0.0001", costmin: "0.5" } });
    await krakenGetAssetPair();
    expect(calls[0]).toMatchObject({ url: `${API}/0/public/AssetPairs?pair=XBTUSD`, method: "GET", body: undefined });
    expect(calls[0].headers).toEqual({});
    expect(store.value).toBeNull();
  });

  it("R8 List Funding Methods: GET /funding/v1/methods/withdraw?asset[class]=currency&asset[name]=BTC, signed headers, no body", async () => {
    responder = () => json({ methods: [] });
    await krakenListWithdrawMethods(auth);
    expect(calls[0].url).toBe(`${API}/funding/v1/methods/withdraw?asset%5Bclass%5D=currency&asset%5Bname%5D=BTC`);
    fundingGet(calls[0]);
  });

  it("R9 List Funding Addresses: GET /funding/v1/addresses?scope[method_id]=…", async () => {
    responder = () => json({ addresses: [] });
    await krakenListAddresses(auth, METHOD_ID);
    expect(calls[0].url).toBe(`${API}/funding/v1/addresses?scope%5Bmethod_id%5D=${METHOD_ID}`);
    fundingGet(calls[0]);
  });

  it("R10 Calculate Funding Fees: GET /funding/v1/fees/{method_id}?amount=<8dp>&fee_included=true", async () => {
    responder = () => json({ fee: { asset: {}, amount: "0.00002" }, gross_amount: { amount: "0.00123456" }, net_amount: { amount: "0.00121456" }, withdrawal_fee_token: "TOKEN-1" });
    await krakenQuoteWithdrawalFee(auth, { methodId: METHOD_ID, btcAmount: 0.00123456, feeIncluded: true });
    expect(calls[0].url).toBe(`${API}/funding/v1/fees/${METHOD_ID}?amount=0.00123456&fee_included=true`);
    fundingGet(calls[0]);
  });

  it("R11 Create Funding Withdrawal: POST JSON with scope.method_id, address_id, wrapped amount, quoted_fee + fee_included, expected_address", async () => {
    responder = () => json(WD_RESPONSE);
    await krakenCreateWithdrawal(auth, WITHDRAW);
    const c = calls[0];
    expect(c).toMatchObject({ url: `${API}/funding/v1/withdrawals`, method: "POST" });
    expect(c.headers).toEqual({ "API-Key": "PUBLIC-KEY", "API-Sign": c.headers["API-Sign"], "API-Nonce": String(T), "Content-Type": "application/json" });
    expect(c.body).toBe(JSON.stringify({
      scope: { method_id: METHOD_ID },
      address_id: ADDRESS_ID,
      amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00123456" } },
      fee: { quoted_fee: { token: "TOKEN-1" }, fee_included: true },
      expected_address: "bc1qnodeaddress",
    }));
  });

  it("R12 List Funding Withdrawals: asset filter + limit; with a cursor, the cursor alone", async () => {
    responder = () => json({ withdrawals: [] });
    await krakenListWithdrawals(auth);
    await krakenListWithdrawals(auth, { cursor: "CURSOR-2" });
    expect(calls[0].url).toBe(`${API}/funding/v1/withdrawals?asset%5Bclass%5D=currency&asset%5Bname%5D=BTC&limit=50`);
    expect(calls[1].url).toBe(`${API}/funding/v1/withdrawals?cursor=CURSOR-2`);
    fundingGet(calls[0]);
  });

  it("R13 methods and addresses page by cursor alone ('Do not provide other request parameters with a cursor')", async () => {
    sequence(() => json({ methods: [] }), () => json({ addresses: [] }));
    await krakenListWithdrawMethods(auth, "M-CURSOR");
    await krakenListAddresses(auth, METHOD_ID, "A-CURSOR");
    expect(calls[0].url).toBe(`${API}/funding/v1/methods/withdraw?cursor=M-CURSOR`);
    expect(calls[1].url).toBe(`${API}/funding/v1/addresses?cursor=A-CURSOR`);
    fundingGet(calls[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every /0 function, with a response that would otherwise parse.
const ZERO_CASES: Array<{ name: string; call: () => Promise<{ ok: boolean }>; result: unknown }> = [
  { name: "BalanceEx", call: () => krakenGetBalances(auth), result: { ZUSD: { balance: "10", hold_trade: "0" } } },
  { name: "AddOrder", call: () => krakenPlaceMarketBuy(auth, BUY), result: { descr: { order: "x" }, txid: [TXID] } },
  { name: "AddOrder validate", call: () => krakenValidateMarketBuy(auth, BUY), result: { descr: { order: "x" } } },
  { name: "QueryOrders", call: () => krakenQueryOrder(auth, TXID), result: { [TXID]: ORDER } },
  { name: "OpenOrders/ClosedOrders", call: () => krakenFindOrderByClOrdId(auth, "bc-42-tx5kq0"), result: { open: { [TXID]: ORDER } } },
  { name: "GetApiKeyInfo", call: () => krakenGetApiKeyInfo(auth), result: { permissions: ["query-funds"] } },
  { name: "AssetPairs", call: () => krakenGetAssetPair(), result: { XXBTZUSD: { altname: "XBTUSD", ordermin: "0.0001" } } },
];

describe("E · the /0 error array and transport failures", () => {
  it.each(ZERO_CASES)("E1 $name: an E-severity entry on HTTP 200, even beside a valid result, is api_error", async ({ call, result }) => {
    responder = () => json({ error: ["EGeneral:Invalid arguments"], result });
    expect(await call()).toEqual({ ok: false, kind: "api_error", httpStatus: 200, errors: ["EGeneral:Invalid arguments"] });
    responder = () => json({ error: ["WGeneral:Notice", "EOrder:Insufficient funds"], result });
    expect(await call()).toMatchObject({ ok: false, kind: "api_error", errors: ["WGeneral:Notice", "EOrder:Insufficient funds"] });
  });

  it.each(ZERO_CASES)("K3 $name: ONLY W-severity warnings with a valid result is success, and the warnings are returned (ruling K3)", async ({ call, result }) => {
    responder = () => json({ error: ["WGeneral:Some warning"], result });
    expect(await call()).toMatchObject({ ok: true, warnings: ["WGeneral:Some warning"] });
  });

  it("K3b W-only warnings WITHOUT a valid result are not success (bad_response)", async () => {
    responder = () => json({ error: ["WGeneral:Some warning"] });
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "bad_response" });
  });

  it("E1b an entry with no recognised severity prefix is a failure, not a warning", async () => {
    responder = () => json({ error: ["Something odd"], result: {} });
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "api_error", errors: ["Something odd"] });
  });

  it("E1c AddOrder's error typed as an array of arrays (the spec's quirk) is flattened and still fails", async () => {
    responder = () => json({ error: [["EOrder:Order minimum not met"]], result: {} });
    expect(await krakenPlaceMarketBuy(auth, BUY)).toMatchObject({ ok: false, kind: "api_error", errors: ["EOrder:Order minimum not met"] });
  });

  it("E2 a non-200 with an E entry is api_error (status kept); a non-200 without one is http_error", async () => {
    responder = () => json({ error: ["EService:Unavailable"] }, 503);
    expect(await krakenGetBalances(auth)).toEqual({ ok: false, kind: "api_error", httpStatus: 503, errors: ["EService:Unavailable"] });
    responder = () => json({ error: [] }, 502);
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "http_error", httpStatus: 502 });
  });

  it("E3 not JSON: on 200 bad_response; on a Cloudflare 520 page http_error", async () => {
    responder = () => new Response("<html>oops</html>", { status: 200 });
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "bad_response", httpStatus: 200 });
    responder = () => new Response("<html>520</html>", { status: 520 });
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "http_error", httpStatus: 520, body: null, text: "<html>520</html>" });
  });

  it("E3b a malformed field in a 200 is bad_response naming it", async () => {
    responder = () => ok0({ descr: {}, txid: [] });
    expect(await krakenPlaceMarketBuy(auth, BUY)).toMatchObject({ ok: false, kind: "bad_response", detail: "missing or malformed: txid" });
    responder = () => json({ error: "EGeneral:x" });
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "bad_response", detail: "error field is not an array" });
  });

  it("E4 no response within the timeout → timeout, and the queue moves on", async () => {
    vi.useFakeTimers();
    responder = (c) => new Promise((_, reject) => c.signal!.addEventListener("abort", () => reject(c.signal!.reason)));
    const p = krakenPlaceMarketBuy(auth, BUY);
    await vi.advanceTimersByTimeAsync(KRAKEN_REQUEST_TIMEOUT_MS);
    expect(await p).toEqual({ ok: false, kind: "timeout", timeoutMs: KRAKEN_REQUEST_TIMEOUT_MS });
    vi.useRealTimers();
    responder = () => ok0({});
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: true });
  });

  it("E4b a network error whose message mentions 'abort' is network, NOT timeout (P0 finding 9)", async () => {
    responder = () => { throw Object.assign(new Error("The operation was aborted by the peer"), { name: "AbortError" }); };
    expect(await krakenPlaceMarketBuy(auth, BUY)).toEqual({ ok: false, kind: "network", detail: "The operation was aborted by the peer" });
  });

  it("E5 Funding: a non-2xx carries its JSON body as http_error (shape undocumented)", async () => {
    responder = () => json({ errors: [{ code: "InvalidAddress", message: "bad" }] }, 400);
    const r = await krakenCreateWithdrawal(auth, WITHDRAW);
    expect(r).toMatchObject({ ok: false, kind: "http_error", httpStatus: 400, body: { errors: [{ code: "InvalidAddress", message: "bad" }] } });
  });

  it("E6 Funding: a 2xx without withdrawal_id is bad_response, with its real status", async () => {
    responder = () => json({ ...WD_RESPONSE, withdrawal_id: undefined }, 201);
    expect(await krakenCreateWithdrawal(auth, WITHDRAW)).toEqual({ ok: false, kind: "bad_response", httpStatus: 201, detail: "missing or malformed: withdrawal_id" });
  });

  it("E7 a failing nonce store: local_error, and nothing is sent", async () => {
    auth = { ...auth, nonce: createNonceSource({ load: () => null, save: () => { throw new Error("SQLITE_FULL"); } }, () => T) };
    expect(await krakenPlaceMarketBuy(auth, BUY)).toEqual({ ok: false, kind: "local_error", detail: "SQLITE_FULL" });
    expect(calls).toHaveLength(0);
  });

  it("E8 invalid arguments are refused before sending (invalid_request), consuming no nonce", async () => {
    const refused = [
      await krakenPlaceMarketBuy(auth, { quoteUsd: 0, clOrdId: "ok" }),
      await krakenPlaceMarketBuy(auth, { quoteUsd: 0.001, clOrdId: "ok" }), // rounds to 0.00
      await krakenPlaceMarketBuy(auth, { quoteUsd: NaN, clOrdId: "ok" }),
      await krakenPlaceMarketBuy(auth, { quoteUsd: 25, clOrdId: "this-id-is-19-chars" }),
      await krakenValidateMarketBuy(auth, { quoteUsd: 25, clOrdId: "has space" }),
      await krakenQueryOrder(auth, "../x"),
      await krakenListAddresses(auth, "../../0/private/Withdraw"),
      await krakenQuoteWithdrawalFee(auth, { methodId: METHOD_ID, btcAmount: -1, feeIncluded: true }),
      await krakenCreateWithdrawal(auth, { ...WITHDRAW, addressId: "not-an-id" }),
      await krakenCreateWithdrawal(auth, { ...WITHDRAW, expectedAddress: "" }),
      await krakenCreateWithdrawal(auth, { ...WITHDRAW, feeToken: "" }),
      await krakenListWithdrawals(auth, { limit: 501 }),
    ];
    for (const r of refused) expect(r).toMatchObject({ ok: false, kind: "invalid_request" });
    expect(calls).toHaveLength(0);
    expect(store.value).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("P · parsing the documented responses", () => {
  it("P1 BalanceEx: string and number forms; available = balance + credit - credit_used - hold_trade", async () => {
    responder = () => ok0({
      ZUSD: { balance: "100.50", hold_trade: "25.25" },
      XXBT: { balance: 0.5, hold_trade: 0 },
      USDC: { balance: "40", hold_trade: "0", credit: "10", credit_used: "4" },
    });
    const r = await krakenGetBalances(auth);
    expect(r.ok && r.balances).toEqual({
      ZUSD: { balance: 100.5, holdTrade: 25.25, credit: 0, creditUsed: 0, available: 75.25 },
      XXBT: { balance: 0.5, holdTrade: 0, credit: 0, creditUsed: 0, available: 0.5 },
      USDC: { balance: 40, holdTrade: 0, credit: 10, creditUsed: 4, available: 46 },
    });
    responder = () => ok0({ ZUSD: { balance: "abc", hold_trade: "0" } });
    expect(await krakenGetBalances(auth)).toMatchObject({ ok: false, kind: "bad_response", detail: "missing or malformed: ZUSD.balance" });
  });

  it("P2 AddOrder: the txids and the description", async () => {
    responder = () => ok0({ descr: { order: "buy 25.00 XBTUSD @ market" }, txid: [TXID] });
    expect(await krakenPlaceMarketBuy(auth, BUY)).toEqual({ ok: true, warnings: [], txids: [TXID], description: "buy 25.00 XBTUSD @ market" });
  });

  it("P3 QueryOrders: the order's fields; an absent txid is order: null", async () => {
    responder = () => ok0({ [TXID]: ORDER });
    expect(await krakenQueryOrder(auth, TXID)).toEqual({
      ok: true, warnings: [],
      order: { txid: TXID, status: "closed", clOrdId: "bc-42-tx5kq0", volExec: 0.00025, cost: 24.98, fee: 0.1, avgPrice: 99920, openTm: 1894017600.1, closeTm: 1894017600.4, reason: null },
    });
    responder = () => ok0({});
    expect(await krakenQueryOrder(auth, TXID)).toEqual({ ok: true, warnings: [], order: null });
  });

  it("P4 reconciliation: found among open orders stops there; found nowhere is order: null after both calls", async () => {
    sequence(() => ok0({ open: { [TXID]: { ...ORDER, status: "open" } } }));
    const open = await krakenFindOrderByClOrdId(auth, "bc-42-tx5kq0");
    expect(open.ok && open.order?.status).toBe("open");
    expect(calls).toHaveLength(1);
    sequence(() => ok0({ open: {} }), () => ok0({ closed: {}, count: 0 }));
    expect(await krakenFindOrderByClOrdId(auth, "bc-42-tx5kq0")).toEqual({ ok: true, warnings: [], order: null });
  });

  it("P5 GetApiKeyInfo: snake_case (schema) and camelCase (example) both parse", async () => {
    const want = { permissions: ["query-funds", "withdraw-funds"], apiKeyName: "farm", nonceWindow: 0, ipAllowlist: ["1.2.3.4"] };
    responder = () => ok0({ permissions: want.permissions, api_key_name: "farm", nonce_window: 0, ip_allowlist: ["1.2.3.4"] });
    expect(await krakenGetApiKeyInfo(auth)).toEqual({ ok: true, warnings: [], info: want });
    responder = () => ok0({ permissions: want.permissions, apiKeyName: "farm", nonceWindow: 0, ipAllowlist: ["1.2.3.4"] });
    expect(await krakenGetApiKeyInfo(auth)).toEqual({ ok: true, warnings: [], info: want });
  });

  it("P6 AssetPairs: XXBTZUSD's minimums", async () => {
    responder = () => ok0({ XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", ordermin: "0.0001", costmin: "0.5", cost_decimals: 5, lot_decimals: 8, status: "online" } });
    expect(await krakenGetAssetPair()).toEqual({
      ok: true, warnings: [],
      pair: { key: "XXBTZUSD", altname: "XBTUSD", ordermin: 0.0001, costmin: 0.5, costDecimals: 5, lotDecimals: 8, status: "online" },
    });
  });

  it("P7 Funding reads: methods, addresses, the fee quote (flat amounts + token)", async () => {
    sequence(
      () => json({ methods: [{ method_id: METHOD_ID, method_name: "Bitcoin", minimum_amount: "0.000218", network: { network_name: "Bitcoin" }, fees: {} }], next_cursor: "N1" }),
      () => json({ addresses: [{ address_id: ADDRESS_ID, verified: true, name: "node", address_details: { crypto: { address: "bc1qnodeaddress" } }, scope: { method_id: METHOD_ID } }] }),
      () => json({ fee: { asset: { class: "currency", name: "BTC" }, amount: "0.00002" }, gross_amount: { asset: {}, amount: "0.00123456" }, net_amount: { asset: {}, amount: "0.00121456" }, fee_details: {}, withdrawal_fee_token: "TOKEN-1" }),
    );
    expect(await krakenListWithdrawMethods(auth)).toEqual({ ok: true, warnings: [], nextCursor: "N1", methods: [{ methodId: METHOD_ID, methodName: "Bitcoin", minimumAmount: 0.000218, maximumAmount: null, networkName: "Bitcoin" }] });
    expect(await krakenListAddresses(auth, METHOD_ID)).toEqual({ ok: true, warnings: [], nextCursor: null, addresses: [{ addressId: ADDRESS_ID, verified: true, address: "bc1qnodeaddress", name: "node" }] });
    expect(await krakenQuoteWithdrawalFee(auth, { methodId: METHOD_ID, btcAmount: 0.00123456, feeIncluded: true })).toEqual({ ok: true, warnings: [], fee: 0.00002, grossAmount: 0.00123456, netAmount: 0.00121456, feeToken: "TOKEN-1" });
  });

  it("P8 Create Funding Withdrawal: wrapped amounts; approval_request_id surfaced when Kraken parks it", async () => {
    responder = () => json(WD_RESPONSE);
    expect(await krakenCreateWithdrawal(auth, WITHDRAW)).toEqual({ ok: true, warnings: [], withdrawalId: WD_RESPONSE.withdrawal_id, approvalRequestId: null, netAmount: 0.00121456, grossAmount: 0.00123456, fee: 0.00002 });
    responder = () => json({ ...WD_RESPONSE, approval_request_id: "APR-1" });
    expect(await krakenCreateWithdrawal(auth, WITHDRAW)).toMatchObject({ ok: true, approvalRequestId: "APR-1" });
  });

  it("P9 List Funding Withdrawals: flat amounts, status as sent, the on-chain hash", async () => {
    responder = () => json({ withdrawals: [{ withdrawal_id: "FTabcde-x", amount: { asset: {}, amount: "0.00121456" }, fee: { asset: {}, amount: "0.00002" }, method_id: METHOD_ID, status: "success", create_time: "2030-01-07T12:00:00Z", address_id: ADDRESS_ID, onchain_transaction: "ab".repeat(32) }] });
    expect(await krakenListWithdrawals(auth)).toEqual({
      ok: true, warnings: [], nextCursor: null,
      withdrawals: [{ withdrawalId: "FTabcde-x", status: "success", amount: 0.00121456, fee: 0.00002, methodId: METHOD_ID, addressId: ADDRESS_ID, createTime: "2030-01-07T12:00:00Z", txHash: "ab".repeat(32) }],
    });
  });

  it("P10 amounts are fixed-decimal strings, never exponent notation", () => {
    expect(fixedAmount(1e-7, 8)).toBe("0.00000010");
    expect(fixedAmount(0.00000001, 8)).toBe("0.00000001");
    expect(fixedAmount(25, 2)).toBe("25.00");
    expect(fixedAmount(0.001, 2)).toBeNull();
    expect(fixedAmount(-1, 8)).toBeNull();
  });

  it("P11 cl_ord_id: the three documented formats only", () => {
    for (const ok of ["6d1b345e-2821-40e2-ad83-4ecb18a06876", "da8e4ad59b78481c93e589746b0cf91f", "arb-20240509-00010", "bc-42-tx5kq0"]) expect(isValidClOrdId(ok), ok).toBe(true);
    for (const bad of ["", "nineteen-characters", "has space", "ünicode"]) expect(isValidClOrdId(bad), bad).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("N · nonces through the client", () => {
  it("N1 60 concurrent /0 and Funding calls: one request in flight at a time, nonces strictly increasing in arrival order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const arrived: bigint[] = [];
    responder = async (c) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const nonce = c.headers["API-Nonce"] ?? new URLSearchParams(c.body).get("nonce")!;
      arrived.push(BigInt(nonce));
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
      inFlight--;
      return c.url.includes("/funding/") ? json({ withdrawals: [] }) : ok0({});
    };
    await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? krakenListWithdrawals(auth) : krakenGetBalances(auth))));
    expect(arrived).toHaveLength(60);
    expect(maxInFlight).toBe(1);
    expect(arrived.every((n, i) => i === 0 || n > arrived[i - 1])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B · structure", () => {
  const SRC = path.join(__dirname, "krakenClient.ts");
  const sf = ts.createSourceFile(SRC, fs.readFileSync(SRC, "utf8"), ts.ScriptTarget.Latest, true);
  const enclosing = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p)) return p.name?.text ?? "?";
    return "<module>";
  };
  const where = (pred: (n: ts.Node) => boolean): string[] => {
    const out: string[] = [];
    const visit = (n: ts.Node) => { if (pred(n)) out.push(enclosing(n)); ts.forEachChild(n, visit); };
    visit(sf);
    return out;
  };

  it("B1 the AddOrder call is made only by krakenPlaceMarketBuy and krakenValidateMarketBuy", () => {
    expect(where((n) => ts.isStringLiteral(n) && n.text === "AddOrder").sort()).toEqual(["krakenPlaceMarketBuy", "krakenValidateMarketBuy"]);
  });

  it("B2 the only Funding POST (a withdrawal) is made by krakenCreateWithdrawal", () => {
    const posts = where((n) => ts.isCallExpression(n) && n.expression.getText() === "fundingCall" && n.arguments[1]?.getText() === '"POST"');
    expect(posts).toEqual(["krakenCreateWithdrawal"]);
  });

  it("B3 no npm dependency: the client imports only Node's crypto and the nonce module", () => {
    const imports = sf.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    expect(imports.sort()).toEqual(["./krakenNonce", "crypto"]);
  });
});
