import type { Env } from "../../lib/types";
import type { InputReading } from "./types";

export const BTC_PRICE_HISTORY_KV_KEY = "btc_price_history_v1";
const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12h
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily";

interface CachedBlob {
  fetched_at: number;
  series: InputReading[];
}

// Returns BTC daily close price series (unix seconds / USD). Uses a 12h KV cache
// to stay under CoinGecko's free-tier rate limit. Returns [] on total failure.
export async function fetchBtcPriceHistory(env: Env): Promise<InputReading[]> {
  const cached = await readCache(env.PRICES_CACHE);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.fetched_at < CACHE_TTL_SECONDS) {
    return cached.series;
  }

  try {
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) {
      console.error(`[priceHistory] CoinGecko HTTP ${res.status}`);
      return cached?.series ?? [];
    }
    const body = (await res.json()) as { prices?: Array<[number, number]> };
    if (!body.prices || !Array.isArray(body.prices)) return cached?.series ?? [];
    const series: InputReading[] = body.prices
      .filter(([ms, value]) => typeof ms === "number" && typeof value === "number" && Number.isFinite(value))
      .map(([ms, value]) => ({ timestamp: Math.floor(ms / 1000), value }));
    series.sort((a, b) => a.timestamp - b.timestamp);
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
