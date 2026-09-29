// The Yahoo Finance adapter for the daily-close fetcher interface (closes.ts),
// spec §3.4.1 — the adapter rulings of 2026-09-28 (1–4) and 2026-09-29 (A–D) in
// the research vault's Daybreak spec. The spec is the authority; this header
// only restates it.
//
// ONE request per symbol: the v8 chart endpoint, range=5d, interval=1d, with a
// browser-like User-Agent. No cache, no retry. The clock and `fetch` are
// injected; the adapter never reads either itself.
//
// ─── THE RULES ───────────────────────────────────────────────────────────
//
//  - UNITS, keyed on `meta.currency`: `USX` (US cents) ÷ 100, `USD` as-is, any
//    other value fails closed. Unconverted cents shift the Z by 2/σ, silently.
//  - A BAR'S DATE is the UTC date of its timestamp. Corn bars are stamped at New
//    York midnight (04:00Z in EDT, 05:00Z in EST) and Bitcoin's at UTC
//    midnight; `centralDateOf(ts)` would put both on the day before.
//  - BITCOIN: the finished close is the last bar whose UTC day does not contain
//    the fetcher's clock — here, the last bar dated before the clock's UTC date.
//  - CORN: a bar dated D is finished once 1:20 PM Central has passed ON D, by
//    the fetcher's clock; 1:20:00 exactly counts as passed. ⚠ CBOT's close is
//    NOT in Yahoo's response — this HARDCODES it. Yahoo's trading-period window
//    (C1) and "always drop the last bar" (C4) are both ruled out.
//  - The bar is CHOSEN BY DATE ALONE. A null or non-finite close on the chosen
//    bar fails closed; there is no fallback to an earlier bar (ruling A).
//  - `fetchedAt` is the injected clock, never a time from the response.
//
// ⚠ UNVERIFIED, and not this file's to settle: whether Yahoo answers requests
// from Cloudflare's egress (every capture so far came through Firecrawl, and
// this repo's own network gets 429), and whether corn's evening session changes
// the day's bar before 10 PM Central. The captures show the day's bar holding
// the LAST TRADE after 1:20 PM, later replaced by CME's settlement.
//
// A SIBLING of valuation/inputs/priceHistory.ts, never a user of it: that file
// is another arc's and fails open (closes.ts, "WHY THIS IS NOT …").

import type { CloseFetcher, CloseFetchFailure, CloseFetchResult, PriceSymbol } from "./closes";
import { centralInstant, type CentralDate } from "./dates";

/**
 * The same VALUE as valuation/inputs/priceHistory.ts:26-28, copied, not
 * imported. That file records that Yahoo answers 429 to requests without a
 * browser-like User-Agent (:16-18).
 */
export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** CBOT's corn day-session close, Central wall-clock time (ruling D). */
export const CORN_FINAL_HOUR_CENTRAL = 13;
export const CORN_FINAL_MINUTE_CENTRAL = 20;

export interface YahooCloseDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
}

export function yahooChartUrl(symbol: PriceSymbol): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
}

/** A bar's date: the UTC calendar date of its timestamp (Unix seconds). */
export function barDate(epochSeconds: number): CentralDate {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Whether the bar dated `date` is finished at `now`. */
function isFinished(symbol: PriceSymbol, date: CentralDate, now: Date): boolean {
  if (symbol === "BTC-USD") return date < now.toISOString().slice(0, 10);
  return now.getTime() >= centralInstant(date, CORN_FINAL_HOUR_CENTRAL, CORN_FINAL_MINUTE_CENTRAL).getTime();
}

/** The divisor that turns the response's currency into $ (or USD), or null. */
function divisorFor(currency: unknown): number | null {
  if (currency === "USX") return 100;
  if (currency === "USD") return 1;
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(symbol: PriceSymbol, reason: CloseFetchFailure, detail: string): CloseFetchResult {
  return { ok: false, symbol, reason, detail };
}

/** The latest finished close in a parsed chart body, or an explicit failure. */
function selectClose(symbol: PriceSymbol, body: unknown, now: Date): CloseFetchResult {
  const chart = isObject(body) ? body.chart : undefined;
  if (!isObject(chart)) return fail(symbol, "unparseable", "no chart object");
  if (chart.error != null) return fail(symbol, "chart_error", `chart.error: ${JSON.stringify(chart.error)}`);

  const result = Array.isArray(chart.result) ? chart.result[0] : undefined;
  if (!isObject(result)) return fail(symbol, "unparseable", "no chart.result[0]");
  const meta = result.meta;
  if (!isObject(meta)) return fail(symbol, "unparseable", "no meta");
  const quote = isObject(result.indicators) && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : undefined;
  const timestamps = result.timestamp;
  const closes = isObject(quote) ? quote.close : undefined;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return fail(symbol, "unparseable", "no timestamp or close array");
  if (timestamps.length !== closes.length) {
    return fail(symbol, "unequal_arrays", `${timestamps.length} timestamps vs ${closes.length} closes`);
  }
  if (timestamps.length === 0) return fail(symbol, "empty_series", "no bars");
  if (!timestamps.every((t) => typeof t === "number" && Number.isInteger(t))) {
    return fail(symbol, "unparseable", "a timestamp is not an integer");
  }

  const divisor = divisorFor(meta.currency);
  if (divisor === null) return fail(symbol, "unsupported_currency", `currency ${JSON.stringify(meta.currency)} is neither USX nor USD`);

  let chosen = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (isFinished(symbol, barDate(timestamps[i]), now) && (chosen < 0 || timestamps[i] > timestamps[chosen])) chosen = i;
  }
  if (chosen < 0) return fail(symbol, "no_finished_bar", `no bar is finished at ${now.toISOString()}`);

  const date = barDate(timestamps[chosen]);
  const raw = closes[chosen];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(symbol, "invalid_close", `the ${date} bar's close is ${String(raw)}`);
  }
  return { ok: true, symbol, date, close: raw / divisor, fetchedAt: now.toISOString() };
}

export function createYahooCloseFetcher(deps: YahooCloseDeps): CloseFetcher {
  return {
    async latestCompletedClose(symbol) {
      const now = deps.now();
      let res: Response;
      try {
        res = await deps.fetch(yahooChartUrl(symbol), { headers: { "User-Agent": YAHOO_USER_AGENT } });
      } catch (err) {
        return fail(symbol, "network_error", err instanceof Error ? err.message : String(err));
      }
      if (res.status !== 200) return fail(symbol, "http_error", `HTTP ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return fail(symbol, "unparseable", "body is not JSON");
      }
      return selectClose(symbol, body, now);
    },
  };
}
