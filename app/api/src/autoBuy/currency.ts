// Currency-adaptive Auto-Buy (Phase 1) — pure selection logic.
//
// Implements specs/2026-06-03-currency-adaptive-autobuy-phase-1.md §2.
// Deterministic, no I/O: takes the configured preference and the two balances
// (already read by the scheduler) and returns which currency to spend, or null
// to skip. The scheduler maps the result to a Coinbase product_id and writes
// the run row. Keeping this pure is what makes it unit-testable in isolation
// (§8) without touching the DB or Coinbase.

export type CurrencyPreference =
  | "usd_only"
  | "usdc_only"
  | "usd_preferred"
  | "usdc_preferred";

export type Currency = "USD" | "USDC";

/**
 * Choose the currency to spend for a single run, or null to skip.
 *
 * Binding rules (§2):
 *  - Independent coverage only: a currency is eligible iff *that one balance
 *    alone* is >= intendedBuyUsd. Split-fill across currencies is out of scope.
 *  - USDC is treated 1:1 with USD for the comparison.
 *  - The boundary balance === intendedBuyUsd counts as covered (>=).
 *  - null is a skip (insufficient funds), not a failure.
 */
export function selectCurrency(
  preference: CurrencyPreference,
  usdBalance: number,
  usdcBalance: number,
  intendedBuyUsd: number,
): Currency | null {
  const usdCovers = usdBalance >= intendedBuyUsd;
  const usdcCovers = usdcBalance >= intendedBuyUsd;

  switch (preference) {
    case "usd_only":
      return usdCovers ? "USD" : null;
    case "usdc_only":
      return usdcCovers ? "USDC" : null;
    case "usd_preferred":
      if (usdCovers) return "USD";
      if (usdcCovers) return "USDC";
      return null;
    case "usdc_preferred":
      if (usdcCovers) return "USDC";
      if (usdCovers) return "USD";
      return null;
  }
}

/**
 * The set of currencies a preference *considers*, for the run's
 * `currencies_checked` column. Determined by the preference alone, independent
 * of the outcome, and always in canonical order (USD before USDC) regardless
 * of which the algorithm checks first (§2).
 */
export function currenciesCheckedFor(preference: CurrencyPreference): string {
  switch (preference) {
    case "usd_only":
      return "USD";
    case "usdc_only":
      return "USDC";
    case "usd_preferred":
    case "usdc_preferred":
      return "USD,USDC";
  }
}

/** Map the selected currency to its Coinbase Advanced Trade v3 product_id. */
export function productIdFor(currency: Currency): "BTC-USD" | "BTC-USDC" {
  return currency === "USD" ? "BTC-USD" : "BTC-USDC";
}
