import type Database from "better-sqlite3";
import {
  listAccounts,
  placeMarketBuy,
  placeWithdraw,
  pollOrder,
  pollWithdraw,
  type CoinbaseAccount,
  type CoinbaseCredentials,
} from "./coinbaseClient";
import { decrypt } from "./credentials";
import { classifyCoinbaseError } from "./alerts";
import type {
  Balances,
  ErrorClass,
  ExchangeFailure,
  ExchangeResult,
  ExchangeSession,
  OpenSessionResult,
  OrderReport,
  OrderState,
  QuoteCurrency,
  WithdrawalReport,
  WithdrawalState,
} from "./exchangeProvider";

// The Coinbase adapter: a thin mapping from the ExchangeProvider interface onto
// coinbaseClient.ts, which it imports and does not replace. Coinbase-shaped
// detail lives here and nowhere else in the scheduler's path:
//   · the coinbase_credentials row and its decryption;
//   · account UUIDs: withdraw and getWithdrawal need the BTC account's UUID;
//   · the status table (classifyCoinbaseError: 401/403 auth, 429/5xx rate_limit);
//   · the 400 rule: a 400 from a withdrawal means the address is not whitelisted;
//   · Coinbase's string balances and status words.
//
// Every operation is a top-level function called directly, never a method on an
// object: the outflow-taint walk follows top-level functions only (see
// exchangeProvider.ts).

interface CoinbaseSession extends ExchangeSession {
  creds: CoinbaseCredentials;
  /**
   * The BTC account's UUID, as this session's last getBalances found it; null
   * before any getBalances, or when there is no BTC account. withdraw and
   * getWithdrawal use it rather than looking it up themselves, so a scheduler
   * step makes exactly the listAccounts calls it made before the adapter existed.
   */
  btcAccountId: string | null;
}

function asCoinbase(s: ExchangeSession): CoinbaseSession {
  return s as CoinbaseSession;
}

function fail(status: number, error: string, errorClass?: ErrorClass): ExchangeFailure {
  return { ok: false, errorClass: errorClass ?? classifyCoinbaseError(status, error), httpStatus: status, detail: error };
}

/** Absent or non-finite reads 0 (the scheduler's rule before the adapter existed). */
function balanceOf(acct: CoinbaseAccount | undefined): number {
  const parsed = acct ? Number(acct.available_balance.value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function openSession(db: Database.Database): OpenSessionResult {
  const row = db.prepare(
    `SELECT key_name, encrypted_private_key, nonce FROM coinbase_credentials WHERE id = 1`,
  ).get() as { key_name: string; encrypted_private_key: Buffer; nonce: Buffer } | undefined;
  if (!row) return { kind: "absent" };
  let privateKeyPem: string;
  try {
    privateKeyPem = decrypt({ ciphertext: row.encrypted_private_key, nonce: row.nonce });
  } catch {
    return { kind: "corrupted" };
  }
  const session: CoinbaseSession = {
    provider: "coinbase",
    creds: { keyName: row.key_name, privateKeyPem },
    btcAccountId: null,
  };
  return { kind: "ok", session };
}

export async function getBalances(s: ExchangeSession): Promise<ExchangeResult<{ balances: Balances }>> {
  const session = asCoinbase(s);
  const res = await listAccounts(session.creds);
  if (!res.ok) return fail(res.status, res.error);
  const accounts = res.data.accounts;
  const btcAcct = accounts.find((a) => a.currency === "BTC");
  session.btcAccountId = btcAcct ? btcAcct.uuid : null;
  return {
    ok: true,
    balances: {
      usd: balanceOf(accounts.find((a) => a.currency === "USD")),
      usdc: balanceOf(accounts.find((a) => a.currency === "USDC")),
      btc: btcAcct ? balanceOf(btcAcct) : null,
    },
  };
}

export async function buy(
  s: ExchangeSession,
  quoteUsd: number,
  currency: QuoteCurrency,
): Promise<ExchangeResult<{ orderId: string }>> {
  const res = await placeMarketBuy(asCoinbase(s).creds, quoteUsd, currency);
  if (!res.ok) return fail(res.status, res.error);
  return { ok: true, orderId: res.order_id };
}

function orderStateOf(status: string): OrderState {
  switch (status) {
    case "FILLED": return "filled";
    case "CANCELLED": return "cancelled";
    case "EXPIRED": return "expired";
    case "FAILED": return "failed";
    default: return "pending"; // OPEN, PENDING, and any word Coinbase adds: poll again next tick
  }
}

export async function getOrder(s: ExchangeSession, orderId: string): Promise<ExchangeResult<{ order: OrderReport }>> {
  const res = await pollOrder(asCoinbase(s).creds, orderId);
  if (!res.ok) return fail(res.status, res.error);
  const o = res.order;
  const parsedMs = o.filled_at ? Date.parse(o.filled_at) : NaN;
  return {
    ok: true,
    order: {
      state: orderStateOf(o.status),
      rawStatus: o.status,
      filledBtc: Number(o.filled_size),
      filledUsd: Number(o.filled_value),
      filledAt: Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : null,
    },
  };
}

export async function withdraw(
  s: ExchangeSession,
  toAddress: string,
  btcAmount: number,
): Promise<ExchangeResult<{ withdrawalId: string }>> {
  const session = asCoinbase(s);
  if (session.btcAccountId === null) {
    return { ok: false, errorClass: "other", httpStatus: 0, detail: "btc_account_unknown" };
  }
  const res = await placeWithdraw(session.creds, session.btcAccountId, toAddress, btcAmount);
  if (!res.ok) return fail(res.status, res.error, res.status === 400 ? "withdraw_address_rejected" : undefined);
  return { ok: true, withdrawalId: res.transaction_id };
}

function withdrawalStateOf(status: string): WithdrawalState {
  // Coinbase's status is cast, not validated, in coinbaseClient.ts (P0 A11a).
  // An unknown word reads "pending", which leaves the sweep as it is: the
  // scheduler's behaviour before the adapter existed (P0 B33).
  return status === "completed" || status === "failed" || status === "cancelled" ? status : "pending";
}

export async function getWithdrawal(
  s: ExchangeSession,
  withdrawalId: string,
): Promise<ExchangeResult<{ withdrawal: WithdrawalReport }>> {
  const session = asCoinbase(s);
  if (session.btcAccountId === null) {
    return { ok: false, errorClass: "other", httpStatus: 0, detail: "btc_account_unknown" };
  }
  const res = await pollWithdraw(session.creds, session.btcAccountId, withdrawalId);
  if (!res.ok) return fail(res.status, res.error);
  return {
    ok: true,
    withdrawal: { state: withdrawalStateOf(res.withdraw.status), txHash: res.withdraw.network_tx_hash ?? null },
  };
}
