// The daily-close fetcher INTERFACE for Daybreak's Z intake (spec §3.4.1).
//
// Intake depends on this interface, never on a vendor. H.1 names the series —
// Yahoo `ZC=F` for corn and `BTC-USD` for Bitcoin — but no adapter lives here:
// the vendor's bar-date convention and whether its series ends in an
// in-progress bar are UNVERIFIED (the recon was rate-limited), and an adapter
// built against an assumed response shape would encode a guess as a fact.
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
//  - `fetchedAt` is when the data behind the result was fetched from the
//    vendor. A cached result carries its ORIGINAL fetch instant, never "now".
//  - Any HTTP error (including 429), parse failure or empty series is
//    { ok: false } with no value — never a cached value, never a default.
//
// Staleness is NOT judged here: a close's age is measured against the edition
// it is stamped into (J.1), which only intake knows.

import type { CentralDate } from "./dates";

export type PriceSymbol = "ZC=F" | "BTC-USD";

export type CloseFetchFailure = "http_error" | "network_error" | "unparseable" | "empty_series";

export type CloseFetchResult =
  | { ok: true; symbol: PriceSymbol; date: CentralDate; close: number; fetchedAt: string }
  | { ok: false; symbol: PriceSymbol; reason: CloseFetchFailure; detail: string };

export interface CloseFetcher {
  latestCompletedClose(symbol: PriceSymbol): Promise<CloseFetchResult>;
}
