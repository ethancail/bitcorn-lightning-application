import type Database from "better-sqlite3";

// The exchange provider interface (kraken-autobuy Slice 1 spec §2, §3 P1).
// The scheduler reaches an exchange only through these operations: the five
// Coinbase operations (balances, buy, order poll, withdraw, withdraw poll) plus
// error classification, which every failure carries.
//
// Provider-specific detail stays in each adapter: account ids, product ids,
// request encodings, status vocabularies, the HTTP-status table, and which
// response means "the withdrawal address was refused".
//
// NAMING CONSTRAINT: no member may be called placeMarketBuy or placeWithdraw.
// The outflow-taint walk (utils/action-confirmation.coverage.test.ts) seeds on
// those names and flags any non-call use of them as a primitive passed around
// as a value.

export type QuoteCurrency = "USD" | "USDC";

/**
 * How a failed exchange call is classified. The adapter classifies at the
 * source, where it still has the whole response.
 *   auth                       credentials rejected
 *   rate_limit                 throttled or the exchange unavailable (transient)
 *   withdraw_address_rejected  the exchange refused the withdrawal's destination
 *   other                      anything else, including network failure (httpStatus 0)
 */
export type ErrorClass = "auth" | "rate_limit" | "withdraw_address_rejected" | "other";

export interface ExchangeFailure {
  ok: false;
  errorClass: ErrorClass;
  /** The HTTP status the exchange answered with; 0 when no response arrived. */
  httpStatus: number;
  /** The exchange's error text, as the adapter received it. */
  detail: string;
}

export type ExchangeResult<T> = ({ ok: true } & T) | ExchangeFailure;

/** Spendable balances. An absent or unreadable quote balance reads 0; btc is null when the exchange has no BTC account. */
export interface Balances {
  usd: number;
  usdc: number;
  btc: number | null;
}

export type OrderState = "pending" | "filled" | "cancelled" | "expired" | "failed";

export interface OrderReport {
  state: OrderState;
  /** The exchange's own status word, for alert context only; never branched on. */
  rawStatus: string;
  /** NaN when the exchange's figure does not parse; the scheduler decides what that means. */
  filledBtc: number;
  filledUsd: number;
  /** Unix seconds, or null when the exchange gave no parseable fill time. */
  filledAt: number | null;
}

export type WithdrawalState = "pending" | "completed" | "failed" | "cancelled";

export interface WithdrawalReport {
  state: WithdrawalState;
  txHash: string | null;
}

/** An adapter's per-use handle: its credentials and anything it learned during the session. Opaque to the scheduler. */
export interface ExchangeSession {
  readonly provider: "coinbase";
}

export type OpenSessionResult =
  | { kind: "ok"; session: ExchangeSession }
  | { kind: "absent" }
  | { kind: "corrupted" };

export interface ExchangeProvider {
  /** Load and decrypt this provider's stored credentials. No network call. */
  openSession(db: Database.Database): OpenSessionResult;
  getBalances(s: ExchangeSession): Promise<ExchangeResult<{ balances: Balances }>>;
  buy(s: ExchangeSession, quoteUsd: number, currency: QuoteCurrency): Promise<ExchangeResult<{ orderId: string }>>;
  getOrder(s: ExchangeSession, orderId: string): Promise<ExchangeResult<{ order: OrderReport }>>;
  withdraw(s: ExchangeSession, toAddress: string, btcAmount: number): Promise<ExchangeResult<{ withdrawalId: string }>>;
  getWithdrawal(s: ExchangeSession, withdrawalId: string): Promise<ExchangeResult<{ withdrawal: WithdrawalReport }>>;
}
