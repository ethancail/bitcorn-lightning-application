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
  /**
   * For an outflow (buy, withdraw), what the adapter knows about whether it
   * happened. Absent means "the exchange answered and refused": the outcome is
   * known. Only Kraken's adapter sets it (P4a); Coinbase's never does, so every
   * Coinbase path is unchanged.
   *   not_sent  nothing reached the exchange's outflow call (a pre-step failed)
   *   unknown   the outflow call may have taken effect, and a lookup did not find it
   */
  delivery?: "not_sent" | "unknown";
  /** Set when the exchange refused a buy for being below its minimum (Kraken; P4c skips it, STOP 2). */
  belowMinimum?: boolean;
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
  readonly provider: "coinbase" | "kraken";
}

/**
 * Static per-provider behaviour the scheduler branches on, so that it never
 * branches on a provider's NAME (spec §2; ruling D-P4-1).
 *   alertOnSilentPaths  raise an alert where Coinbase's path is silent (S5: Coinbase's stay silent)
 *   usdcBuys            the provider can buy BTC with USDC (Kraken: no, E9)
 *   reconcileBuys       buys carry a client order id and are reconciled by it
 *   snapshotBalances    balances are persisted each tick and drive the low-funds
 *                       warning (P5, ruling S3: the Kraken path only)
 */
export interface ProviderPolicy {
  alertOnSilentPaths: boolean;
  usdcBuys: boolean;
  reconcileBuys: boolean;
  snapshotBalances: boolean;
}

export type OpenSessionResult =
  | { kind: "ok"; session: ExchangeSession }
  | { kind: "absent" }
  | { kind: "corrupted" };

export interface ExchangeProvider {
  /** Load and decrypt this provider's stored credentials. No network call. */
  openSession(db: Database.Database): OpenSessionResult;
  getBalances(s: ExchangeSession): Promise<ExchangeResult<{ balances: Balances }>>;
  /**
   * `clientOrderId` identifies the buy for reconciliation after an unknown
   * outcome (Kraken's cl_ord_id). Coinbase's adapter ignores it.
   */
  buy(
    s: ExchangeSession,
    quoteUsd: number,
    currency: QuoteCurrency,
    clientOrderId?: string,
  ): Promise<ExchangeResult<{ orderId: string }>>;
  getOrder(s: ExchangeSession, orderId: string): Promise<ExchangeResult<{ order: OrderReport }>>;
  /** `parked`: the exchange accepted the withdrawal but holds it for approval (Kraken's approval_request_id). */
  withdraw(s: ExchangeSession, toAddress: string, btcAmount: number): Promise<ExchangeResult<{ withdrawalId: string; parked?: boolean }>>;
  getWithdrawal(s: ExchangeSession, withdrawalId: string): Promise<ExchangeResult<{ withdrawal: WithdrawalReport }>>;
  /** The smallest sweep the exchange will send, in BTC (STOP 1). */
  withdrawalMinimumBtc(s: ExchangeSession): Promise<ExchangeResult<{ minimumBtc: number }>>;
  /** The smallest buy the exchange will take, in USD, at `priceUsd` per BTC (STOP 2). */
  buyMinimumUsd(s: ExchangeSession, priceUsd: number): Promise<ExchangeResult<{ minimumUsd: number }>>;
  policy(s: ExchangeSession): ProviderPolicy;
}
