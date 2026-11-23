import type Database from "better-sqlite3";
import * as coinbase from "./coinbaseProvider";
import * as kraken from "./krakenProvider";
import type {
  Balances,
  ExchangeProvider,
  ExchangeResult,
  ExchangeSession,
  OpenSessionResult,
  OrderReport,
  ProviderPolicy,
  QuoteCurrency,
  WithdrawalReport,
} from "./exchangeProvider";

// The scheduler's only route to an exchange (kraken-autobuy spec §2, §3 P1, P4).
// The scheduler imports this module and nothing provider-specific; that is
// asserted by exchangeBoundary.test.ts.
//
// P4 (Ethan's ruling R1, 2026-11-20): the provider is chosen by a PLAIN BRANCH
// that calls each adapter's top-level function directly, never through an
// ExchangeProvider-typed value. The outflow-taint walk
// (utils/action-confirmation.coverage.test.ts) records no edge for a call
// through an interface member, so a dispatch table would cut
// /api/autobuy/execute-now and /api/autobuy/catch-up off from both providers'
// primitives (P1 control T-1). R2 prefers this to seeding the interface,
// because seeding it would hide whether each implementation is covered.
//
// The session carries its provider; openSession reads the node's active one.

// Compile-time only: each adapter satisfies the interface.
void (coinbase satisfies ExchangeProvider);
void (kraken satisfies ExchangeProvider);

/**
 * The node's active provider (autobuy_config.provider, migration 084). A
 * database without that column reads as Coinbase: the P0 scheduler suites
 * build their schema from migrations 034/049/050/054 only.
 */
export function activeProvider(db: Database.Database): "coinbase" | "kraken" {
  const row = db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get() as { provider?: string } | undefined;
  const provider = row?.provider ?? "coinbase";
  if (provider !== "coinbase" && provider !== "kraken") throw new Error(`unknown_autobuy_provider: ${provider}`);
  return provider;
}

export function openSession(db: Database.Database): OpenSessionResult {
  return activeProvider(db) === "kraken" ? kraken.openSession(db) : coinbase.openSession(db);
}

export async function getBalances(s: ExchangeSession): Promise<ExchangeResult<{ balances: Balances }>> {
  return s.provider === "kraken" ? kraken.getBalances(s) : coinbase.getBalances(s);
}

export async function buy(
  s: ExchangeSession,
  quoteUsd: number,
  currency: QuoteCurrency,
  clientOrderId?: string,
): Promise<ExchangeResult<{ orderId: string }>> {
  return s.provider === "kraken"
    ? kraken.buy(s, quoteUsd, currency, clientOrderId)
    : coinbase.buy(s, quoteUsd, currency, clientOrderId);
}

export async function getOrder(s: ExchangeSession, orderId: string): Promise<ExchangeResult<{ order: OrderReport }>> {
  return s.provider === "kraken" ? kraken.getOrder(s, orderId) : coinbase.getOrder(s, orderId);
}

export async function withdraw(
  s: ExchangeSession,
  toAddress: string,
  btcAmount: number,
): Promise<ExchangeResult<{ withdrawalId: string; parked?: boolean }>> {
  return s.provider === "kraken" ? kraken.withdraw(s, toAddress, btcAmount) : coinbase.withdraw(s, toAddress, btcAmount);
}

export async function getWithdrawal(
  s: ExchangeSession,
  withdrawalId: string,
): Promise<ExchangeResult<{ withdrawal: WithdrawalReport }>> {
  return s.provider === "kraken" ? kraken.getWithdrawal(s, withdrawalId) : coinbase.getWithdrawal(s, withdrawalId);
}

export async function withdrawalMinimumBtc(s: ExchangeSession): Promise<ExchangeResult<{ minimumBtc: number }>> {
  return s.provider === "kraken" ? kraken.withdrawalMinimumBtc(s) : coinbase.withdrawalMinimumBtc(s);
}

export async function buyMinimumUsd(s: ExchangeSession, priceUsd: number): Promise<ExchangeResult<{ minimumUsd: number }>> {
  return s.provider === "kraken" ? kraken.buyMinimumUsd(s, priceUsd) : coinbase.buyMinimumUsd(s, priceUsd);
}

export function policy(s: ExchangeSession): ProviderPolicy {
  return s.provider === "kraken" ? kraken.policy(s) : coinbase.policy(s);
}

/**
 * The active provider's policy without a session: for paths where opening one
 * failed (no or unreadable credentials), which S5 still treats per provider.
 * Both adapters' policy() is static and ignores the session it is given.
 */
export function activePolicy(db: Database.Database): ProviderPolicy {
  return activeProvider(db) === "kraken" ? kraken.policy({ provider: "kraken" }) : coinbase.policy({ provider: "coinbase" });
}

// Compile-time only: this module's own functions satisfy the interface too. Not
// exported, so nothing can call them through it.
void ({
  openSession, getBalances, buy, getOrder, withdraw, getWithdrawal, withdrawalMinimumBtc, buyMinimumUsd, policy,
} satisfies ExchangeProvider);
