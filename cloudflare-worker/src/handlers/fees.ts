// ─── /fees handler ───────────────────────────────────────────────────────
//
// Projected mempool blocks from mempool.space, served on the /prices pattern
// (a short cache key, a last-good key, and a source header). Public: members
// read fee estimates before they hold any entitlement token (fee-estimates
// spec §3, O10). Every fetch of mempool.space is by this Worker; no node
// calls it directly, and the Worker fetches at most once per cache window.
//
// The upstream is the fixed, versioned path below — no code is adopted, so the
// adoption rule's pin does not apply; the path is what gets recorded (spec §3).

import type { Env } from "../lib/types";
import { CORS_HEADERS } from "../lib/cors";

export const MEMPOOL_BLOCKS_URL = "https://mempool.space/api/v1/fees/mempool-blocks";

export const FEES_KV_KEY = "fees_mempool_blocks";
export const FEES_LAST_GOOD_KV_KEY = "fees_mempool_blocks_last_good";
// Set for one cache window after a failed or invalid upstream fetch, so the
// Worker still fetches at most once per window when mempool.space is down
// (spec §3), instead of once per request.
export const FEES_BACKOFF_KV_KEY = "fees_mempool_blocks_backoff";
// P2: 5 min — about 288 upstream fetches a day.
export const FEES_CACHE_TTL = 300;
// P3 = P10: 30 min. The API treats Worker data older than 30 min as stale, so
// a last-good value kept longer could only ever trigger the API's fallback.
export const FEES_LAST_GOOD_TTL = 1800;

// The blocks the API reads: Priority projected block 1, Normal 3, Economy 6
// (indexes 0, 2, 5). A missing block takes the last present one (P9 (a)).
const USED_INDEXES = [0, 2, 5];

// X-Fee-Source:
//   "live"     — fresh mempool.space fetch, cached now
//   "cache"    — served from the 5-min KV cache
//   "fallback" — the upstream failed or was invalid; last-good data (≤ 30 min)
//   "none"     — the upstream failed and no last-good data exists
//
// fetched_at in the body is always the time of the original upstream fetch, so
// the API measures the data's age independently of this header.

/**
 * D5: valid if it is an array (possibly empty — no backlog, F7) in which every
 * block the API uses has a finite positive medianFee. feeRange may be any
 * length; nothing here reads it (Q3: lengths vary, 7 and 11 in the fixture).
 */
export function isValidMempoolBlocks(data: unknown): data is Array<{ medianFee: number }> {
  if (!Array.isArray(data)) return false;
  if (data.length === 0) return true;
  for (const want of USED_INDEXES) {
    const block = data[Math.min(want, data.length - 1)];
    if (typeof block !== "object" || block === null) return false;
    const median = (block as { medianFee?: unknown }).medianFee;
    if (typeof median !== "number" || !Number.isFinite(median) || median <= 0) return false;
  }
  return true;
}

function respond(body: string, source: "live" | "cache" | "fallback" | "none"): Response {
  return new Response(body, {
    headers: { "Content-Type": "application/json", "X-Fee-Source": source, ...CORS_HEADERS },
  });
}

async function fetchMempoolBlocks(): Promise<unknown> {
  try {
    const res = await fetch(MEMPOOL_BLOCKS_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`[fees] mempool.space returned HTTP ${res.status}`);
      return undefined;
    }
    return await res.json();
  } catch (err) {
    console.error("[fees] mempool.space fetch failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

export async function handleFees(env: Env): Promise<Response> {
  // 1. Fresh cache (< 5 min).
  const cached = await env.PRICES_CACHE.get(FEES_KV_KEY);
  if (cached) return respond(cached, "cache");

  // 2. Fetch live, unless a fetch already failed inside this window. Only a
  //    valid response is cached — an invalid one never overwrites last-good.
  const backingOff = await env.PRICES_CACHE.get(FEES_BACKOFF_KV_KEY);
  if (!backingOff) {
    const data = await fetchMempoolBlocks();
    if (isValidMempoolBlocks(data)) {
      const body = JSON.stringify({ fetched_at: new Date().toISOString(), blocks: data });
      await env.PRICES_CACHE.put(FEES_KV_KEY, body, { expirationTtl: FEES_CACHE_TTL });
      await env.PRICES_CACHE.put(FEES_LAST_GOOD_KV_KEY, body, { expirationTtl: FEES_LAST_GOOD_TTL });
      return respond(body, "live");
    }
    if (data !== undefined) console.error("[fees] mempool.space response failed validation");
    await env.PRICES_CACHE.put(FEES_BACKOFF_KV_KEY, "1", { expirationTtl: FEES_CACHE_TTL });
  }

  // 3. Upstream failed or invalid: last-good, if any.
  const lastGood = await env.PRICES_CACHE.get(FEES_LAST_GOOD_KV_KEY);
  if (lastGood) return respond(lastGood, "fallback");

  // 4. Nothing to serve.
  return respond(JSON.stringify({ fetched_at: null, blocks: null }), "none");
}
