import { ENV } from "../config/env";
import { getCachedTokenIfFresh } from "../subscription/tokenRefresh";

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 min

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export interface CurrentValuation {
  z_score: number;
  zone: string;
  multiplier: number;
  updated_at: string;
  price_usd: number;
}

export interface HistoryRow {
  date: string;
  z_score: number;
  zone: string;
  price_usd: number;
}

export interface InputSnapshot {
  value: number;
  z: number;
  weight: number;
  updated_at: string;
}

async function fetchAndCache<T>(key: string, url: string): Promise<T | null> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.value;
  }
  // The Worker's /valuation/* endpoints are full-scope JWT gated. Treasury
  // self-mints a full-scope token (subscription/tokenIssuance.ts), so the
  // cached token in subscription_local_token authorizes us. If no fresh
  // token is available the Worker will 401 and we fall back to whatever
  // cached value we have — same shape as transport_error handling.
  // Stage 5a.3 will replace this inline attachment with a workerFetch()
  // wrapper used by every Worker call site.
  const headers: Record<string, string> = {};
  const token = getCachedTokenIfFresh();
  if (token) {
    headers["Authorization"] = `Bearer ${token.jwt}`;
  }
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`[valuationClient] ${url} → HTTP ${res.status}`);
      return hit?.value ?? null; // stale fallback on upstream failure
    }
    const value = (await res.json()) as T;
    cache.set(key, { value, cachedAt: Date.now() });
    return value;
  } catch (err) {
    console.error(`[valuationClient] ${url} fetch error:`, err instanceof Error ? err.message : err);
    return hit?.value ?? null;
  }
}

function workerBase(): string | null {
  return ENV.valuationWorkerUrl || ENV.coinbaseWorkerUrl || null;
}

/**
 * Latest composite valuation. Returns null on upstream failure with no cache.
 * Callers (scheduler) should treat null as "skip this tick".
 */
export async function getCurrent(): Promise<CurrentValuation | null> {
  const base = workerBase();
  if (!base) return null;
  return fetchAndCache<CurrentValuation>("current", `${base}/valuation/current`);
}

/**
 * Composite history series. The optional query params are passed through to
 * the Worker; cache key folds them so different ranges are cached separately.
 */
export async function getHistory(sinceISO?: string, untilISO?: string): Promise<{ series: HistoryRow[] } | null> {
  const base = workerBase();
  if (!base) return null;
  const qs = new URLSearchParams();
  if (sinceISO) qs.set("since", sinceISO);
  if (untilISO) qs.set("until", untilISO);
  const suffix = qs.toString();
  const url = `${base}/valuation/history${suffix ? `?${suffix}` : ""}`;
  return fetchAndCache<{ series: HistoryRow[] }>(`history:${suffix}`, url);
}

/**
 * Per-input snapshot map (12 keys).
 */
export async function getInputs(): Promise<Record<string, InputSnapshot> | null> {
  const base = workerBase();
  if (!base) return null;
  return fetchAndCache<Record<string, InputSnapshot>>("inputs", `${base}/valuation/inputs`);
}

/**
 * For tests and debugging only. Clears the in-memory cache so the next call
 * will refetch.
 */
export function resetCacheForTest(): void {
  cache.clear();
}
