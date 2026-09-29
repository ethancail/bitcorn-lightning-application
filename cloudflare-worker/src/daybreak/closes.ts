// The daily-close fetcher INTERFACE for Daybreak's Z intake (spec §3.4.1).
//
// Intake depends on this interface, never on a vendor. H.1 names the series —
// Yahoo `ZC=F` for corn and `BTC-USD` for Bitcoin. The adapter that implements
// it is yahooCloses.ts, built against captured Yahoo responses and the adapter
// rulings of 2026-09-28 and 2026-09-29; this file stays vendor-free.
//
// ─── WHY THIS IS NOT valuation/inputs/priceHistory.ts ────────────────────
//
// priceHistory.ts is the valuation arc's file, feeds three live valuation
// inputs, and FAILS OPEN: every failure path returns the cached series with no
// age, or [] with no cache. That is the opposite of this contract. An adapter
// for this interface is a SIBLING of it — it never imports or edits it.
//
// ─── THE CONTRACT AN ADAPTER MUST KEEP ───────────────────────────────────
//
//  - The close is the latest COMPLETED daily bar. An in-progress bar (Bitcoin
//    trades continuously; corn futures reopen in the evening) is never a close.
//  - `date` is the calendar date of the trading day that close belongs to,
//    YYYY-MM-DD. Mapping the vendor's timestamps to it is the adapter's job.
//  - `close` is in the unit computePowerLawZ takes (powerLawZ.ts): corn in
//    $/bu, Bitcoin in USD. Converting the vendor's unit is the adapter's job.
//  - `fetchedAt` is when the data behind the result was fetched from the
//    vendor. A cached result carries its ORIGINAL fetch instant, never "now".
//  - Any HTTP error (including 429), parse failure or empty series is
//    { ok: false } with no value — never a cached value, never a default.
//
// Staleness is NOT judged here: a close's age is measured against the edition
// it is stamped into (J.1), which only intake knows.

import type { CentralDate } from "./dates";

export type PriceSymbol = "ZC=F" | "BTC-USD";

// The last five are the Yahoo adapter's (yahooCloses.ts): a non-null
// `chart.error`, timestamp/close arrays of unequal length, a currency that is
// neither USX nor USD, no bar finished by the fetcher's clock, and a null or
// non-finite close on the bar the rule chose (no fallback — ruling A).
export type CloseFetchFailure =
  | "http_error"
  | "network_error"
  | "unparseable"
  | "empty_series"
  | "chart_error"
  | "unequal_arrays"
  | "unsupported_currency"
  | "no_finished_bar"
  | "invalid_close";

export type CloseFetchResult =
  | { ok: true; symbol: PriceSymbol; date: CentralDate; close: number; fetchedAt: string }
  | { ok: false; symbol: PriceSymbol; reason: CloseFetchFailure; detail: string };

export interface CloseFetcher {
  latestCompletedClose(symbol: PriceSymbol): Promise<CloseFetchResult>;
}
