// Client for the Worker's /valuation/* endpoints, used by the auto-buy
// scheduler + valuation UI surfaces.
//
// Worker-side: tier-gated scope=full per the Stage 5a deltas. Only
// treasury (self-mints scope=full) + members in `current` tier (which
// covers paid-up members AND fresh-onboarding-grace members per
// migration 042) have access. Members in prepay / lapsed tiers get a
// payment-scope token and the Worker returns 403 scope_insufficient.
//
// Routes through workerFetch() per spec §7.3 — wrapper handles Bearer
// attachment + 401 retry. Previously had inline Bearer attachment (5a.1
// hotfix); this migration brings the site into compliance with "the
// only path Worker calls take is through this wrapper."
//
// Return shape: discriminated union — { ok: true, value } on success,
// { ok: false, kind, ... } on failure. Callers (API routes, scheduler)
// branch on `kind` to map to user-facing status codes / log + skip
// behavior. The previous null-on-failure shape collapsed 401 / 403 /
// transport / unconfigured into one indistinguishable case, which
// surfaced as a generic 503 valuation_unavailable regardless of cause
// — the symptom that prompted this rewrite.
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

/**
 * Discriminated failure shape returned by getCurrent/getHistory/getInputs.
 *
 *  scope_insufficient    — Worker returned 403; member's subscription tier
 *                          doesn't grant full-scope (prepay past fresh
 *                          grace, lapsed tiers). UI: "subscription tier
 *                          insufficient — pay to restore access".
 *  auth_missing          — Worker returned 401 missing; the node has no
 *                          cached Bearer at all. Usually means no
 *                          subscription row OR refresh has never
 *                          succeeded (cold boot before first refresh tick).
 *                          UI: "not subscribed" / "subscription not set up".
 *  auth_invalid          — Worker returned 401 expired/bad_signature/
 *                          bad_subject/bad_scope/malformed. Transient
 *                          (expired/bad_signature self-heal via
 *                          workerFetch's retry); persistent forms are a
 *                          config issue. UI: "subscription token issue
 *                          — try again shortly".
 *  upstream_error        — Worker returned a non-401/403 non-OK (5xx, 502
 *                          from upstream APIs, etc.). UI: "Worker
 *                          upstream error".
 *  worker_unreachable    — Network error reaching the Worker (DNS,
 *                          connection refused, timeout). UI: "Worker
 *                          unreachable — check Worker is deployed".
 *  worker_not_configured — COINBASE_WORKER_URL env var unset on this
 *                          node. UI: "Worker URL not configured".
 */
export type ValuationFetchError =
  | { kind: "scope_insufficient" }
  | { kind: "auth_missing" }
  | { kind: "auth_invalid"; detail: string }
  | { kind: "upstream_error"; status: number }
  | { kind: "worker_unreachable"; detail: string }
  | { kind: "worker_not_configured" };

export type ValuationFetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValuationFetchError };

/**
 * Maps a Worker non-OK Response to a structured ValuationFetchError.
 * Reads the JSON body once to extract the reason claim attached by
 * cloudflare-worker/src/lib/jwt.ts withJwtGate (shape:
 * `{ error: <reason>, detail: <message> }`).
 */
async function classifyWorkerFailure(res: Response): Promise<ValuationFetchError> {
  const body = (await res
    .json()
    .catch(() => null)) as { error?: string; detail?: string } | null;
  const reason = body?.error ?? "";
  if (res.status === 403 && reason === "scope_insufficient") {
    return { kind: "scope_insufficient" };
  }
  if (res.status === 401) {
    if (reason === "missing") return { kind: "auth_missing" };
    return {
      kind: "auth_invalid",
      detail: body?.detail ?? reason ?? "JWT validation failed",
    };
  }
  return { kind: "upstream_error", status: res.status };
}

async function fetchAndCache<T>(
  key: string,
  path: string,
): Promise<ValuationFetchResult<T>> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return { ok: true, value: hit.value };
  }
  let res: Response;
  try {
    res = await workerFetch(path);
  } catch (err) {
    if (err instanceof WorkerFetchError) {
      if (err.reason === "not_configured") {
        return { ok: false, error: { kind: "worker_not_configured" } };
      }
      // transport_error
      console.error(`[valuationClient] ${path} transport error:`, err.message);
      return {
        ok: false,
        error: { kind: "worker_unreachable", detail: err.message },
      };
    }
    // Unexpected throw — surface as transport-style failure rather than
    // letting the caller crash. Logged for investigation.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[valuationClient] ${path} unexpected error:`, msg);
    return {
      ok: false,
      error: { kind: "worker_unreachable", detail: msg },
    };
  }

  if (!res.ok) {
    const error = await classifyWorkerFailure(res);
    console.error(
      `[valuationClient] ${path} → HTTP ${res.status} (${error.kind})`,
    );
    return { ok: false, error };
  }

  const value = (await res.json()) as T;
  cache.set(key, { value, cachedAt: Date.now() });
  return { ok: true, value };
}

/**
 * Latest composite valuation. Callers branch on the discriminated
 * result — scheduler logs + skips on any !ok; API routes map each
 * failure kind to an appropriate HTTP status.
 */
export async function getCurrent(): Promise<ValuationFetchResult<CurrentValuation>> {
  return fetchAndCache<CurrentValuation>("current", "/valuation/current");
}

/**
 * Composite history series. The optional query params are passed through
 * to the Worker; cache key folds them so different ranges are cached
 * separately.
 */
export async function getHistory(
  sinceISO?: string,
  untilISO?: string,
): Promise<ValuationFetchResult<{ series: HistoryRow[] }>> {
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
export async function getInputs(): Promise<
  ValuationFetchResult<Record<string, InputSnapshot>>
> {
  return fetchAndCache<Record<string, InputSnapshot>>("inputs", "/valuation/inputs");
}

/**
 * For tests and debugging only. Clears the in-memory cache so the next call
 * will refetch.
 */
export function resetCacheForTest(): void {
  cache.clear();
}
