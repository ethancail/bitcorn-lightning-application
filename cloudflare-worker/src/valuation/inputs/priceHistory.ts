import type { Env } from "../../lib/types";
import type { InputReading } from "./types";

// BTC daily close price history. Source: Yahoo Finance chart endpoint
// (no auth, no API key, single request returns up to 10 years of data).
//
// Past attempts and why they were dropped:
//   - CoinGecko free tier: started rejecting `days=max` with HTTP 401
//     ("limited to past 365 days"). 365 days isn't enough for the
//     200-week MA (1400 days) or the Pi Cycle 350-day SMA.
//   - Binance public Klines: returns HTTP 451 "restricted location" to
//     Cloudflare Worker datacenters (US-blocked). Looked promising in
//     local curl from a non-US IP, geo-failed once deployed.
//
// Yahoo's chart endpoint is unauthenticated, returns the full series in
// one round-trip, and works from US/EU/Worker datacenters. The only
// gotcha is a required browser-like User-Agent; without one, Yahoo
// returns HTTP 429 even on otherwise-valid requests.

export const BTC_PRICE_HISTORY_KV_KEY = "btc_price_history_v1";
const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12h
const YAHOO_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=10y&interval=1d";
// Yahoo blocks requests without a UA; this matches the format their
// own consumer apps use and is enough to pass their bot filter.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface CachedBlob {
  fetched_at: number;
  series: InputReading[];
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
  };
}

export async function fetchBtcPriceHistory(env: Env): Promise<InputReading[]> {
  const cached = await readCache(env.PRICES_CACHE);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.fetched_at < CACHE_TTL_SECONDS) {
    return cached.series;
  }

  try {
    const res = await fetch(YAHOO_URL, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      console.error(`[priceHistory] Yahoo HTTP ${res.status}`);
      return cached?.series ?? [];
    }
    const body = (await res.json()) as YahooChartResponse;
    const result = body.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    if (timestamps.length === 0 || timestamps.length !== closes.length) {
      console.error(`[priceHistory] Yahoo returned ${timestamps.length} ts vs ${closes.length} closes`);
      return cached?.series ?? [];
    }
    const series: InputReading[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close)) continue;
      series.push({ timestamp: timestamps[i], value: close });
    }
    series.sort((a, b) => a.timestamp - b.timestamp);
    if (series.length === 0) return cached?.series ?? [];
    const blob: CachedBlob = { fetched_at: now, series };
    await env.PRICES_CACHE.put(BTC_PRICE_HISTORY_KV_KEY, JSON.stringify(blob));
    return series;
  } catch (err) {
    console.error("[priceHistory] fetch error:", err instanceof Error ? err.message : err);
    return cached?.series ?? [];
  }
}

async function readCache(kv: KVNamespace): Promise<CachedBlob | null> {
  const raw = await kv.get(BTC_PRICE_HISTORY_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedBlob;
  } catch {
    return null;
  }
}
