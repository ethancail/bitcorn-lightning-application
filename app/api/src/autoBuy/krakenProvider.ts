import type Database from "better-sqlite3";
import { decrypt } from "./credentials";
import { krakenNonceSource } from "./krakenNonce";
import {
  KRAKEN_BALANCE_KEYS,
  krakenCreateWithdrawal,
  krakenFindOrderByClOrdId,
  krakenGetAssetPair,
  krakenGetBalances,
  krakenListWithdrawals,
  krakenListWithdrawMethods,
  krakenPlaceMarketBuy,
  krakenQueryOrder,
  krakenQuoteWithdrawalFee,
  type KrakenAuth,
  type KrakenFailure,
  type KrakenOrder,
} from "./krakenClient";
import type {
  Balances,
  ErrorClass,
  ExchangeFailure,
  ExchangeResult,
  ExchangeSession,
  OpenSessionResult,
  OrderReport,
  OrderState,
  ProviderPolicy,
  QuoteCurrency,
  WithdrawalReport,
  WithdrawalState,
} from "./exchangeProvider";

// The Kraken adapter (kraken-autobuy spec §3 P4, P4a): the ExchangeProvider
// interface over krakenClient.ts. Kraken-shaped detail lives here and nowhere
// else in the scheduler's path:
//   · the kraken_credentials row, its decryption (label "kraken-autobuy"), and
//     the withdraw method_id / address_id resolved at verify (P4d);
//   · the classifier: Kraken's E-codes and failure kinds → ErrorClass;
//   · reconciliation: a buy is looked up by cl_ord_id before it is placed and
//     after an ambiguous failure, and a withdrawal is looked up in List Funding
//     Withdrawals after an ambiguous failure. Nothing is ever re-sent blind
//     (spec §4);
//   · E9: USD only.
//
// Every operation is a top-level function called directly (never through an
// object), so the coverage walk follows exchange.ts → here → the client's
// outflow primitives (R1, R2).

interface KrakenSession extends ExchangeSession {
  readonly provider: "kraken";
  auth: KrakenAuth;
  /** Resolved at credential verify (P4d); null until the node's address is matched. */
  methodId: string | null;
  addressId: string | null;
}

function asKraken(s: ExchangeSession): KrakenSession {
  return s as KrakenSession;
}

const SWEEP_FLOOR_BTC = 0.0001; // the scheduler's SWEEP_MIN_BTC; STOP 1 takes the larger of this and Kraken's

export function openSession(db: Database.Database): OpenSessionResult {
  const row = db.prepare(
    `SELECT api_key, encrypted_secret, nonce, withdraw_method_id, withdraw_address_id FROM kraken_credentials WHERE id = 1`,
  ).get() as
    | { api_key: string; encrypted_secret: Buffer; nonce: Buffer; withdraw_method_id: string | null; withdraw_address_id: string | null }
    | undefined;
  if (!row) return { kind: "absent" };
  let secret: string;
  try {
    secret = decrypt({ ciphertext: row.encrypted_secret, nonce: row.nonce }, "kraken-autobuy");
  } catch {
    return { kind: "corrupted" };
  }
  const session: KrakenSession = {
    provider: "kraken",
    auth: { apiKey: row.api_key, secret, nonce: krakenNonceSource(db) },
    methodId: row.withdraw_method_id,
    addressId: row.withdraw_address_id,
  };
  return { kind: "ok", session };
}

// ───────────────────────────────────────────────────────────────────────────
// The classifier (spec §4 "Errors"; codes from
// https://docs.kraken.com/exchange/guides/general/errors, read 2026-11-23)
// ───────────────────────────────────────────────────────────────────────────

/** Credentials refused or unusable. EAPI:Invalid nonce is here by ruling D-P4-9: with the node's serialized nonce it means the key is used elsewhere. */
const AUTH_CODES = [
  "EAPI:Invalid key",
  "EAPI:Invalid signature",
  "EAPI:Invalid nonce",
  "EGeneral:Permission denied",
  "EAccount:Invalid permissions",
  "EAuth:Account temporary disabled",
  "EAuth:Account unconfirmed",
];
/** Throttled, locked out for a while, or the exchange unavailable: transient. */
const TRANSIENT_CODES = [
  "EAPI:Rate limit exceeded",
  "EOrder:Rate limit exceeded",
  "EOrder:Domain rate limit exceeded",
  "EAuth:Rate limit exceeded",
  "EAuth:Too many requests",
  "EGeneral:Temporary lockout",
  "EGeneral:Internal error",
  "EService:",
];
const BELOW_MINIMUM_CODES = ["EOrder:Order minimum not met", "EOrder:Cost minimum not met"];

const startsWithAny = (e: string, codes: string[]) => codes.some((c) => e.startsWith(c));

function httpStatusOf(f: KrakenFailure): number {
  return "httpStatus" in f ? f.httpStatus : 0;
}

function detailOf(f: KrakenFailure): string {
  switch (f.kind) {
    case "api_error": return f.errors.join("; ");
    case "http_error": return `http_${f.httpStatus}: ${f.text}`;
    case "timeout": return `timeout_after_${f.timeoutMs}ms`;
    default: return `${f.kind}: ${f.detail}`;
  }
}

/** Kraken's failure → the interface's error class. Exported for the classifier tests. */
export function classifyKrakenFailure(f: KrakenFailure): ErrorClass {
  switch (f.kind) {
    case "api_error":
      if (f.errors.some((e) => startsWithAny(e, AUTH_CODES))) return "auth";
      if (f.errors.some((e) => startsWithAny(e, TRANSIENT_CODES))) return "rate_limit";
      return "other";
    case "http_error":
      if (f.httpStatus === 401 || f.httpStatus === 403) return "auth";
      if (f.httpStatus === 429 || f.httpStatus >= 500) return "rate_limit";
      return "other";
    case "timeout":
    case "network":
      return "rate_limit";
    default:
      return "other"; // bad_response, invalid_request, local_error
  }
}

function fail(f: KrakenFailure, extra: Partial<Pick<ExchangeFailure, "delivery" | "belowMinimum" | "errorClass">> = {}): ExchangeFailure {
  return {
    ok: false,
    errorClass: extra.errorClass ?? classifyKrakenFailure(f),
    httpStatus: httpStatusOf(f),
    detail: detailOf(f),
    ...(extra.delivery ? { delivery: extra.delivery } : {}),
    ...(extra.belowMinimum ? { belowMinimum: true } : {}),
  };
}

function localFail(detail: string, delivery: "not_sent"): ExchangeFailure {
  return { ok: false, errorClass: "other", httpStatus: 0, detail, delivery };
}

/**
 * Could an outflow call that failed this way still have taken effect? No
 * response, a 5xx, or Kraken's own service/internal errors: yes. A definite
 * refusal (any other E-code, a 4xx): no.
 */
function ambiguous(f: KrakenFailure): boolean {
  if (f.kind === "timeout" || f.kind === "network") return true;
  if (f.kind === "http_error") return f.httpStatus === 0 || f.httpStatus >= 500;
  if (f.kind === "api_error") return f.errors.some((e) => e.startsWith("EService:") || e.startsWith("EGeneral:Internal error"));
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Operations
// ───────────────────────────────────────────────────────────────────────────

export async function getBalances(s: ExchangeSession): Promise<ExchangeResult<{ balances: Balances }>> {
  const res = await krakenGetBalances(asKraken(s).auth);
  if (!res.ok) return fail(res);
  const available = (key: string) => res.balances[key]?.available ?? 0; // Kraken lists no key for an asset never held: 0
  return {
    ok: true,
    balances: {
      usd: available(KRAKEN_BALANCE_KEYS.usd),
      usdc: available(KRAKEN_BALANCE_KEYS.usdc),
      btc: available(KRAKEN_BALANCE_KEYS.btc),
    },
  };
}

/**
 * A USD market buy, idempotent per client order id: an order already carrying
 * the id is returned instead of placing another (a retry after a crash or an
 * unknown outcome finds it). After an ambiguous failure the id is looked up
 * again; not finding it reports delivery "unknown".
 */
export async function buy(
  s: ExchangeSession,
  quoteUsd: number,
  currency: QuoteCurrency,
  clientOrderId?: string,
): Promise<ExchangeResult<{ orderId: string }>> {
  const { auth } = asKraken(s);
  if (currency !== "USD") return localFail(`kraken_usd_only: ${currency} buys are not supported (E9)`, "not_sent");
  if (!clientOrderId) return localFail("kraken_client_order_id_required", "not_sent");

  const before = await krakenFindOrderByClOrdId(auth, clientOrderId);
  if (!before.ok) return fail(before, { delivery: "not_sent" });
  if (before.order) return { ok: true, orderId: before.order.txid };

  const placed = await krakenPlaceMarketBuy(auth, { quoteUsd, clOrdId: clientOrderId });
  if (placed.ok) return { ok: true, orderId: placed.txids[0] };
  if (!ambiguous(placed)) {
    const belowMinimum = placed.kind === "api_error" && placed.errors.some((e) => startsWithAny(e, BELOW_MINIMUM_CODES));
    return fail(placed, { belowMinimum });
  }
  const after = await krakenFindOrderByClOrdId(auth, clientOrderId);
  if (after.ok && after.order) return { ok: true, orderId: after.order.txid };
  return fail(placed, { delivery: "unknown" });
}

function orderStateOf(o: KrakenOrder): OrderState {
  // A closed, cancelled or expired market order that executed anything bought
  // that BTC: report the fill, so it is held and swept, never stranded.
  if (o.status === "closed" || o.status === "canceled" || o.status === "expired") {
    if (o.volExec > 0) return "filled";
    return o.status === "closed" ? "failed" : o.status === "canceled" ? "cancelled" : "expired";
  }
  return "pending"; // pending, open, and any word Kraken adds: poll again next tick
}

export async function getOrder(s: ExchangeSession, orderId: string): Promise<ExchangeResult<{ order: OrderReport }>> {
  const res = await krakenQueryOrder(asKraken(s).auth, orderId);
  if (!res.ok) return fail(res);
  if (!res.order) return { ok: false, errorClass: "other", httpStatus: 200, detail: `order_not_found: ${orderId}` };
  const o = res.order;
  return {
    ok: true,
    order: {
      state: orderStateOf(o),
      rawStatus: o.status,
      filledBtc: o.volExec,
      // USD debited: cost plus fee (a buy's fee is charged in the quote currency by default).
      filledUsd: o.cost + o.fee,
      filledAt: o.closeTm !== null ? Math.floor(o.closeTm) : null,
    },
  };
}

/** Does a listed withdrawal match the one just requested (same saved address, same amount, gross or net)? */
function sameWithdrawal(w: { addressId: string | null; amount: number | null; fee: number | null; createTime: string | null }, addressId: string, btcAmount: number, sinceMs: number): boolean {
  if (w.addressId !== addressId || w.amount === null) return false;
  const gross = w.amount + (w.fee ?? 0);
  const amountMatches = Math.abs(gross - btcAmount) < 5e-9 || Math.abs(w.amount - btcAmount) < 5e-9;
  const created = w.createTime ? Date.parse(w.createTime) : NaN;
  return amountMatches && Number.isFinite(created) && created >= sinceMs - 120_000;
}

/**
 * A sweep: quote the fee (E2: quoted_fee), then create the withdrawal with that
 * token and expected_address. fee_included=true (D-P4-5): the debit is exactly
 * the BTC bought. A failed quote sent nothing. After an ambiguous create
 * failure, List Funding Withdrawals is checked; the withdrawal is never re-sent.
 */
export async function withdraw(
  s: ExchangeSession,
  toAddress: string,
  btcAmount: number,
): Promise<ExchangeResult<{ withdrawalId: string; parked?: boolean }>> {
  const { auth, methodId, addressId } = asKraken(s);
  if (!methodId || !addressId) return localFail("kraken_withdraw_address_unresolved", "not_sent");

  const quote = await krakenQuoteWithdrawalFee(auth, { methodId, btcAmount, feeIncluded: true });
  if (!quote.ok) return fail(quote, { delivery: "not_sent" });
  if (!quote.feeToken) return { ok: false, errorClass: "other", httpStatus: 200, detail: "kraken_fee_quote_without_token", delivery: "not_sent" };

  const startedMs = Date.now();
  const created = await krakenCreateWithdrawal(auth, {
    methodId,
    addressId,
    btcAmount,
    feeToken: quote.feeToken,
    feeIncluded: true,
    expectedAddress: toAddress,
  });
  if (created.ok) return { ok: true, withdrawalId: created.withdrawalId, parked: created.approvalRequestId !== null };

  if (!ambiguous(created)) {
    // D-P4-10, provisional: Funding error bodies are undocumented. A 4xx whose
    // body mentions the address is treated as the address refused (it pauses).
    const addressRefused =
      created.kind === "http_error" && created.httpStatus >= 400 && created.httpStatus < 500 &&
      /address/i.test(created.text);
    return fail(created, addressRefused ? { errorClass: "withdraw_address_rejected" } : {});
  }

  const listed = await krakenListWithdrawals(auth);
  if (listed.ok) {
    const hit = listed.withdrawals.find((w) => sameWithdrawal(w, addressId, btcAmount, startedMs));
    if (hit) return { ok: true, withdrawalId: hit.withdrawalId };
  }
  return fail(created, { delivery: "unknown" });
}

function withdrawalStateOf(status: string): WithdrawalState {
  // List Funding Withdrawals: pending | success | failed. Anything else polls again.
  return status === "success" ? "completed" : status === "failed" ? "failed" : "pending";
}

const WITHDRAWAL_LIST_PAGES = 5;

/** The withdrawal's state from List Funding Withdrawals (newest first). Not listed yet reads pending. */
export async function getWithdrawal(
  s: ExchangeSession,
  withdrawalId: string,
): Promise<ExchangeResult<{ withdrawal: WithdrawalReport }>> {
  const { auth } = asKraken(s);
  let cursor: string | undefined;
  for (let page = 0; page < WITHDRAWAL_LIST_PAGES; page++) {
    const res = await krakenListWithdrawals(auth, cursor ? { cursor } : {});
    if (!res.ok) return fail(res);
    const hit = res.withdrawals.find((w) => w.withdrawalId === withdrawalId);
    if (hit) return { ok: true, withdrawal: { state: withdrawalStateOf(hit.status), txHash: hit.txHash } };
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return { ok: true, withdrawal: { state: "pending", txHash: null } };
}

/** STOP 1: the larger of the sweep floor and the withdraw method's minimum_amount, read now. */
export async function withdrawalMinimumBtc(s: ExchangeSession): Promise<ExchangeResult<{ minimumBtc: number }>> {
  const { auth, methodId } = asKraken(s);
  if (!methodId) return localFail("kraken_withdraw_address_unresolved", "not_sent");
  const res = await krakenListWithdrawMethods(auth);
  if (!res.ok) return fail(res);
  const method = res.methods.find((m) => m.methodId === methodId);
  if (!method) return { ok: false, errorClass: "other", httpStatus: 200, detail: `kraken_withdraw_method_not_listed: ${methodId}` };
  return { ok: true, minimumBtc: Math.max(SWEEP_FLOOR_BTC, method.minimumAmount ?? 0) };
}

/** STOP 2: the larger of the pair's costmin (USD) and ordermin (BTC) at `priceUsd`. Public data, unsigned. */
export async function buyMinimumUsd(_s: ExchangeSession, priceUsd: number): Promise<ExchangeResult<{ minimumUsd: number }>> {
  const res = await krakenGetAssetPair();
  if (!res.ok) return fail(res);
  return { ok: true, minimumUsd: Math.max(res.pair.costmin ?? 0, res.pair.ordermin * priceUsd) };
}

/** Kraken alerts where Coinbase is silent (S5), buys USD only (E9), reconciles buys by cl_ord_id, and keeps a balance snapshot (S3). */
export function policy(_s: ExchangeSession): ProviderPolicy {
  return { alertOnSilentPaths: true, usdcBuys: false, reconcileBuys: true, snapshotBalances: true };
}
