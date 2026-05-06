import type { Env } from "../../lib/types";
import type { InputReading } from "./types";

// BTC daily close price history. Source: Binance public Klines endpoint
// (no auth, no rate-limit key, returns up to 1000 candles per call).
// We previously used CoinGecko's market_chart with `days=max`, but their
// free tier began rejecting that with HTTP 401 / error 10012 ("limited to
// past 365 days"). 365 days isn't enough for the 200-week MA (1400 days)
// or the Pi Cycle 350-day SMA, so the dependent adapters returned [].
//
// Binance's BTCUSDT pair lists from 2017-08-17, which gives ~3000 days —
// enough for both downstream consumers with margin. We paginate backward
// from "now" until either the target window is filled or the symbol's
// listing date is reached.

export const BTC_PRICE_HISTORY_KV_KEY = "btc_price_history_v1";
const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12h
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1d";
const PAGE_LIMIT = 1000;

// 200W MA needs 1400 days; Pi Cycle needs 350. Pulling ~2000 days gives
// 600+ days of MA200W output, plenty of distribution to compute Z-scores.
const TARGET_DAYS = 2000;

interface CachedBlob {
  fetched_at: number;
  series: InputReading[];
}

export async function fetchBtcPriceHistory(env: Env): Promise<InputReading[]> {
  const cached = await readCache(env.PRICES_CACHE);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.fetched_at < CACHE_TTL_SECONDS) {
    return cached.series;
  }

  try {
    const series = await fetchAllPages();
    if (series.length === 0) return cached?.series ?? [];
    const blob: CachedBlob = { fetched_at: now, series };
    await env.PRICES_CACHE.put(BTC_PRICE_HISTORY_KV_KEY, JSON.stringify(blob));
    return series;
  } catch (err) {
    console.error("[priceHistory] fetch error:", err instanceof Error ? err.message : err);
    return cached?.series ?? [];
  }
}

// Page backward from "now" until TARGET_DAYS reached or response empty
// (symbol not listed that far back). Each candle is
// [openTimeMs, openStr, highStr, lowStr, closeStr, ...] — we only need
// openTime + close.
async function fetchAllPages(): Promise<InputReading[]> {
  const all: InputReading[] = [];
  let endTime: number | undefined;
  // Defensive page cap — TARGET_DAYS at PAGE_LIMIT/page is 2 pages,
  // but Binance occasionally returns short pages; allow a few extras.
  for (let page = 0; page < 6; page++) {
    const url = new URL(BINANCE_KLINES_URL);
    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("interval", INTERVAL);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));

    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`[priceHistory] Binance HTTP ${res.status}`);
      break;
    }
    const body = (await res.json()) as Array<[number, string, string, string, string, ...unknown[]]>;
    if (!Array.isArray(body) || body.length === 0) break;

    for (const candle of body) {
      const [openTimeMs, , , , closeStr] = candle;
      const close = Number(closeStr);
      if (!Number.isFinite(close)) continue;
      all.push({ timestamp: Math.floor(openTimeMs / 1000), value: close });
    }

    if (all.length >= TARGET_DAYS) break;

    // Next page ends just before this page's earliest candle.
    const earliestOpenMs = body[0][0];
    endTime = earliestOpenMs - 1;
  }

  // Pages arrived newest→oldest with overlap possible; dedupe + sort ascending.
  const seen = new Set<number>();
  const dedup = all.filter((r) => {
    if (seen.has(r.timestamp)) return false;
    seen.add(r.timestamp);
    return true;
  });
  dedup.sort((a, b) => a.timestamp - b.timestamp);
  return dedup;
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
