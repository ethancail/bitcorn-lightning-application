import type Database from "better-sqlite3";
import * as coinbase from "./coinbaseProvider";
import type {
  Balances,
  ExchangeProvider,
  ExchangeResult,
  ExchangeSession,
  OpenSessionResult,
  OrderReport,
  QuoteCurrency,
  WithdrawalReport,
} from "./exchangeProvider";

// The scheduler's only route to an exchange (kraken-autobuy spec §2, §3 P1).
// The scheduler imports this module and nothing provider-specific; that is
// asserted by exchangeBoundary.test.ts.
//
// P1: STATICALLY WIRED TO COINBASE. Each function calls the adapter's top-level
// function directly, never through an ExchangeProvider-typed value: the
// outflow-taint walk (utils/action-confirmation.coverage.test.ts) records no
// edge for a call through an interface member, so a call like that would cut
// /api/autobuy/execute-now and /api/autobuy/catch-up off from placeMarketBuy
// and placeWithdraw (P1 control T-1 demonstrates it).
//
// P4 DIRECTION (Ethan's ruling R1, 2026-11-20): select the provider here with a
// plain branch that calls each provider's top-level functions directly, so the
// walk follows every branch. P4's plan tries that before any change to the
// coverage test.

// Compile-time only: the Coinbase adapter satisfies the interface.
void (coinbase satisfies ExchangeProvider);

export function openSession(db: Database.Database): OpenSessionResult {
  return coinbase.openSession(db);
}

export async function getBalances(s: ExchangeSession): Promise<ExchangeResult<{ balances: Balances }>> {
  return coinbase.getBalances(s);
}

export async function buy(
  s: ExchangeSession,
  quoteUsd: number,
  currency: QuoteCurrency,
): Promise<ExchangeResult<{ orderId: string }>> {
  return coinbase.buy(s, quoteUsd, currency);
}

export async function getOrder(s: ExchangeSession, orderId: string): Promise<ExchangeResult<{ order: OrderReport }>> {
  return coinbase.getOrder(s, orderId);
}

export async function withdraw(
  s: ExchangeSession,
  toAddress: string,
  btcAmount: number,
): Promise<ExchangeResult<{ withdrawalId: string }>> {
  return coinbase.withdraw(s, toAddress, btcAmount);
}

export async function getWithdrawal(
  s: ExchangeSession,
  withdrawalId: string,
): Promise<ExchangeResult<{ withdrawal: WithdrawalReport }>> {
  return coinbase.getWithdrawal(s, withdrawalId);
}

// Compile-time only: this module's own functions satisfy the interface too. Not
// exported, so nothing can call them through it.
void ({ openSession, getBalances, buy, getOrder, withdraw, getWithdrawal } satisfies ExchangeProvider);
