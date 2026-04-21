import { CORS_HEADERS } from "../lib/cors";
import type { Env, CommodityPrices } from "../lib/types";

// ─── Price fetchers ──────────────────────────────────────────────────────

// OPERATIONAL RISK: TradingView scanner is an UNDOCUMENTED public endpoint.
// No API key, no SLA, no versioning. It is used by open-source libs (tradingview-ta,
// tradingview-scraper) and has been stable for years, but could change or be
// rate-limited without notice. The handlePrices() function has a KV fallback:
// if this fetch fails, the last successful cached response is served instead of
// all-null data. Monitor Worker logs for "TradingView" errors.
//
// Data delay: ~10 minutes (update_mode: "delayed_streaming_600").
// The PRICES_CACHE_TTL is intentionally set to 600s (10 min) to match this —
// caching shorter would re-fetch identical delayed quotes; caching longer
// would make the ticker feel stale for intraday-moving futures prices.
//
// NOTE: These are FUTURES prices (front-month continuous contracts), not spot.
// Historical corn charts still use USDA NASS monthly "PRICE RECEIVED" data via
// /prices/corn-history — a different data model (farm-gate spot vs. exchange
// futures). Do not mix the two without accounting for basis differential.
const TV_SCANNER_URL = "https://scanner.tradingview.com/futures/scan";

type TVSymbolConfig = {
  ticker: string;     // TradingView symbol, e.g. "COMEX:GC1!"
  label: string;      // Human-readable, e.g. "Gold"
  unit: string;       // Display unit, e.g. "$/oz"
  // Unit conversion:
  //   Gold (GC1!): quoted in USD/oz on COMEX → divisor=1, already dollars
  //   Corn (ZC1!), Soybeans (ZS1!), Wheat (ZW1!): quoted in cents/bu on CBOT
  //     → divisor=100 to convert to $/bu
  divisor: number;
  decimals: number;   // rounding precision for display (not lossy — applied last)
};

const TV_SYMBOLS: Record<string, TVSymbolConfig> = {
  gold:     { ticker: "COMEX:GC1!", label: "Gold",      unit: "$/oz", divisor: 1,   decimals: 2 },
  corn:     { ticker: "CBOT:ZC1!",  label: "Corn",      unit: "$/bu", divisor: 100, decimals: 4 },
  soybeans: { ticker: "CBOT:ZS1!",  label: "Soybeans",  unit: "$/bu", divisor: 100, decimals: 4 },
  wheat:    { ticker: "CBOT:ZW1!",  label: "Wheat",     unit: "$/bu", divisor: 100, decimals: 4 },
};

// Expected columns requested from the scanner. If TradingView changes the
// response schema, the column index mapping below will break — the per-row
// validation catches this and logs which symbol/field failed.
const TV_COLUMNS = ["close", "description", "exchange", "type", "pricescale"] as const;
const COL_CLOSE = 0;

type TVScanRow = { s: string; d: unknown[] };
type TVScanResponse = {
  totalCount: number;
  data: TVScanRow[] | null;
  error?: string;
};

/** Fetch futures prices. Returns partial results on per-symbol failure, all-null on total failure. */
async function fetchFuturesPrices(): Promise<CommodityPrices> {
  const tickers = Object.values(TV_SYMBOLS).map((s) => s.ticker);
  const now = new Date().toISOString();

  // Default: all null. Callers (handlePrices) handle fallback to cached data.
  const result: CommodityPrices = { gold: null, corn: null, soybeans: null, wheat: null };

  try {
    const res = await fetch(TV_SCANNER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers, query: { types: [] } },
        columns: [...TV_COLUMNS],
      }),
    });

    if (!res.ok) {
      console.error(`[tv-scanner] HTTP ${res.status} ${res.statusText}`);
      return result;
    }

    const data: TVScanResponse = await res.json();

    if (data.error) {
      console.error(`[tv-scanner] API error: ${data.error}`);
      return result;
    }

    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      console.error("[tv-scanner] empty or missing data array");
      return result;
    }

    // Build reverse map: ticker → commodity key
    const tickerToKey = new Map<string, string>();
    for (const [key, cfg] of Object.entries(TV_SYMBOLS)) {
      tickerToKey.set(cfg.ticker, key);
    }

    // Track which symbols we got back to log any that are missing
    const seen = new Set<string>();

    for (const row of data.data) {
      // Validate row structure
      if (!row.s || !Array.isArray(row.d)) {
        console.error("[tv-scanner] malformed row, missing 's' or 'd':", JSON.stringify(row).slice(0, 200));
        continue;
      }

      const key = tickerToKey.get(row.s) as keyof CommodityPrices | undefined;
      if (!key) {
        // Unexpected symbol in response — not an error, just skip
        continue;
      }
      seen.add(key);

      // Validate the close price field exists and is a number
      if (row.d.length <= COL_CLOSE) {
        console.error(`[tv-scanner] ${row.s}: response has ${row.d.length} columns, expected at least ${COL_CLOSE + 1}`);
        continue;
      }

      const rawPrice = row.d[COL_CLOSE];
      if (typeof rawPrice !== "number" || isNaN(rawPrice) || rawPrice <= 0) {
        console.error(`[tv-scanner] ${row.s}: invalid close price: ${JSON.stringify(rawPrice)}`);
        continue;
      }

      const cfg = TV_SYMBOLS[key];
      const price = rawPrice / cfg.divisor;
      const rounded = Math.round(price * 10 ** cfg.decimals) / 10 ** cfg.decimals;

      result[key] = {
        price: rounded,
        unit: cfg.unit,
        label: cfg.label,
        updated_at: now,
      };
    }

    // Log any expected symbols that were missing from the response
    const missing = Object.keys(TV_SYMBOLS).filter((k) => !seen.has(k));
    if (missing.length > 0) {
      console.error(`[tv-scanner] missing symbols in response: ${missing.join(", ")}`);
    }
  } catch (err) {
    console.error("[tv-scanner] fetch error:", err instanceof Error ? err.message : err);
  }

  return result;
}

/** Count how many commodities have a non-null price. */
function countPrices(prices: CommodityPrices): number {
  return Object.values(prices).filter((p) => p != null).length;
}

// ─── /prices/corn-history handler ────────────────────────────────────────

type CornHistoryEntry = { year: number; month: number; price: number };

const CORN_HISTORY_KV_KEY = "corn_price_history";
const CORN_HISTORY_CACHE_TTL = 86400; // 24 hours — monthly data, no need for frequent refresh

export async function handleCornHistory(env: Env): Promise<Response> {
  // Check KV cache first
  const cached = await env.PRICES_CACHE.get(CORN_HISTORY_KV_KEY);
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const key = env.USDA_NASS_KEY?.replace(/^["']|["']$/g, "");
  if (!key) {
    return new Response(JSON.stringify({ error: "USDA key not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const params = new URLSearchParams({
      key,
      commodity_desc: "CORN",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / BU",
      freq_desc: "MONTHLY",
      year__GE: "2014",
      format: "JSON",
    });
    const res = await fetch(
      `https://quickstats.nass.usda.gov/api/api_GET/?${params.toString()}`,
    );
    if (!res.ok) {
      return new Response("USDA API error", { status: 502, headers: CORS_HEADERS });
    }
    const data = (await res.json()) as {
      data: Array<{ year: number; reference_period_desc: string; Value: string }>;
    };
    if (!data.data || data.data.length === 0) {
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const MONTHS: Record<string, number> = {
      JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
    };

    const entries: CornHistoryEntry[] = [];
    for (const row of data.data) {
      const monthKey = row.reference_period_desc?.toUpperCase().slice(0, 3);
      const month = MONTHS[monthKey];
      if (!month) continue;
      const price = parseFloat(row.Value.replace(/,/g, ""));
      if (isNaN(price) || price <= 0) continue;
      entries.push({ year: row.year, month, price });
    }

    // Sort chronologically
    entries.sort((a, b) => a.year - b.year || a.month - b.month);

    const body = JSON.stringify(entries);
    await env.PRICES_CACHE.put(CORN_HISTORY_KV_KEY, body, { expirationTtl: CORN_HISTORY_CACHE_TTL });

    return new Response(body, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("Corn history error:", err instanceof Error ? err.message : err);
    return new Response("Internal error", { status: 500, headers: CORS_HEADERS });
  }
}

// ─── /prices handler ─────────────────────────────────────────────────────

const KV_KEY = "commodity_prices";
// Fallback key persists the last successful response with a longer TTL so that
// if TradingView goes down *after* the 10-min cache expires, we still have
// something to serve instead of all-null data.
const KV_FALLBACK_KEY = "commodity_prices_fallback";
// 10 min — intentionally matched to TradingView's delayed_streaming_600 behavior.
// Shorter would re-fetch identical delayed data. Longer would make the ticker
// feel stale for intraday-moving futures prices.
const PRICES_CACHE_TTL = 600;          // 10 minutes — controls re-fetch cadence
const PRICES_FALLBACK_TTL = 86400;     // 24 hours — safety net for outages

// X-Price-Source header tells callers where the data came from:
//   "live"     — fresh TradingView fetch, cached now
//   "cache"    — served from the 10-min KV cache (normal hot path)
//   "fallback" — TradingView failed, serving last-known-good data (up to 24h old)
//   "none"     — TradingView failed and no cached data exists (all-null response)
//
// The updated_at field inside each commodity object is always the timestamp of
// the original fetch — so stale fallback data will have an old updated_at,
// letting consumers measure data age independently of the source header.

export async function handlePrices(env: Env): Promise<Response> {
  // 1. Serve from KV cache if fresh (< 10 min old)
  const cached = await env.PRICES_CACHE.get(KV_KEY);
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json", "X-Price-Source": "cache", ...CORS_HEADERS },
    });
  }

  // 2. Cache miss or expired — fetch live from TradingView
  const result = await fetchFuturesPrices();
  const freshCount = countPrices(result);

  if (freshCount > 0) {
    // Got at least some data. Always write the 10-min cache (serves partial
    // results for the next 10 min — better to show 3/4 fresh than 4/4 stale).
    const body = JSON.stringify(result);
    await env.PRICES_CACHE.put(KV_KEY, body, { expirationTtl: PRICES_CACHE_TTL });

    // Only update the 24h fallback if the fresh result is at least as complete
    // as what's already stored. This prevents a partial failure (e.g. 1/4)
    // from overwriting a previously full (4/4) fallback.
    const existingFallback = await env.PRICES_CACHE.get(KV_FALLBACK_KEY);
    let fallbackCount = 0;
    if (existingFallback) {
      try {
        fallbackCount = countPrices(JSON.parse(existingFallback) as CommodityPrices);
      } catch { /* corrupt fallback — overwrite it */ }
    }

    if (freshCount >= fallbackCount) {
      await env.PRICES_CACHE.put(KV_FALLBACK_KEY, body, { expirationTtl: PRICES_FALLBACK_TTL });
    }

    return new Response(body, {
      headers: { "Content-Type": "application/json", "X-Price-Source": "live", ...CORS_HEADERS },
    });
  }

  // 3. Total failure — all prices null. Serve the last successful response
  //    from the fallback key (survives up to 24h after the 10-min key expires).
  const fallback = await env.PRICES_CACHE.get(KV_FALLBACK_KEY);
  if (fallback) {
    console.error("[prices] TradingView failed, serving fallback cache");
    return new Response(fallback, {
      headers: { "Content-Type": "application/json", "X-Price-Source": "fallback", ...CORS_HEADERS },
    });
  }

  // 4. No fallback either — first-ever fetch failed, or outage > 24h.
  //    Return all-null so the frontend shows "—" for each ticker.
  console.error("[prices] TradingView failed and no fallback cache available");
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "X-Price-Source": "none", ...CORS_HEADERS },
  });
}
