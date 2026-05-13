// Client for the Worker's /valuation/* endpoints, used by the auto-buy
// scheduler + valuation UI surfaces.
//
// Worker-side: tier-gated scope=full per the Stage 5a deltas. Only
// treasury (self-mints scope=full) + `current`-tier members have
// access. Members in prepay/lapsed tiers get 403 from the Worker.
//
// Routes through workerFetch() per spec §7.3 — wrapper handles Bearer
// attachment + 401 retry. Previously had inline Bearer attachment (5a.1
// hotfix); this migration brings the site into compliance with "the
// only path Worker calls take is through this wrapper."
//
// Historical note: this module previously supported a VALUATION_WORKER_
// URL override to point /valuation/* at a different Worker than the
// Coinbase Onramp one. The override was never used in practice (both
// always pointed at the same Worker). The workerFetch wrapper uses
// ENV.coinbaseWorkerUrl; if a real split-Worker need arises, the
// wrapper can be parameterized with a baseUrlOverride option.

import { workerFetch, WorkerFetchError } from "../lib/workerFetch";

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

async function fetchAndCache<T>(key: string, path: string): Promise<T | null> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.value;
  }
  try {
    const res = await workerFetch(path);
    if (!res.ok) {
      console.error(`[valuationClient] ${path} → HTTP ${res.status}`);
      return hit?.value ?? null; // stale fallback on upstream failure
    }
    const value = (await res.json()) as T;
    cache.set(key, { value, cachedAt: Date.now() });
    return value;
  } catch (err) {
    if (err instanceof WorkerFetchError && err.reason === "not_configured") {
      return null; // Worker URL unset; same as previous workerBase() === null behavior
    }
    console.error(`[valuationClient] ${path} fetch error:`, err instanceof Error ? err.message : err);
    return hit?.value ?? null;
  }
}

/**
 * Latest composite valuation. Returns null on upstream failure with no cache.
 * Callers (scheduler) should treat null as "skip this tick".
 */
export async function getCurrent(): Promise<CurrentValuation | null> {
  return fetchAndCache<CurrentValuation>("current", "/valuation/current");
}

/**
 * Composite history series. The optional query params are passed through to
 * the Worker; cache key folds them so different ranges are cached separately.
 */
export async function getHistory(sinceISO?: string, untilISO?: string): Promise<{ series: HistoryRow[] } | null> {
  const qs = new URLSearchParams();
  if (sinceISO) qs.set("since", sinceISO);
  if (untilISO) qs.set("until", untilISO);
  const suffix = qs.toString();
  const path = `/valuation/history${suffix ? `?${suffix}` : ""}`;
  return fetchAndCache<{ series: HistoryRow[] }>(`history:${suffix}`, path);
}

/**
 * Per-input snapshot map (12 keys).
 */
export async function getInputs(): Promise<Record<string, InputSnapshot> | null> {
  return fetchAndCache<Record<string, InputSnapshot>>("inputs", "/valuation/inputs");
}

/**
 * For tests and debugging only. Clears the in-memory cache so the next call
 * will refetch.
 */
export function resetCacheForTest(): void {
  cache.clear();
}
