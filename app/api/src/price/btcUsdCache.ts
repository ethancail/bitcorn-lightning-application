// One cached, timestamped BTC/USD rate (drive-mode spec P1 item 3, §3.2;
// R15(6), R18(9)).
//
// In memory, R18(9): a restart starts with no rate ("none") until the first
// refresh lands, seconds later. Refreshed in the background every 60 s, each
// read bounded by a 2 s timeout (as subscription/btcUsdSpot.ts already does);
// a read that finds a refresh due also starts one, without waiting on it, so a
// cold cache fills on first use. Nothing ever awaits Coinbase on a request
// path — the rate is read, never fetched, by the routes and the payment.
//
// States, R15(6): fresh up to 10 minutes old (dollars); stale after 10 minutes
// (dollars with "price as of <time>"); none after 6 hours or with no rate
// (sats, with one sentence) — and in "none" the value itself is withheld.
//
// subscription/btcUsdSpot.ts, the second server-side fetcher, is left alone
// (R18(9)).

const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
export const RATE_REFRESH_MS = 60_000;
export const RATE_TIMEOUT_MS = 2_000;
export const RATE_FRESH_MS = 10 * 60_000;
export const RATE_NONE_AFTER_MS = 6 * 3_600_000;

export type RateState = "fresh" | "stale" | "none";

export type BtcUsdRate = {
  /** null when state is "none". */
  usd: number | null;
  source: "coinbase";
  fetched_at: number | null;
  age_ms: number | null;
  state: RateState;
  last_attempt_at: number | null;
  last_error: string | null;
};

const cache = {
  usd: null as number | null,
  fetchedAt: null as number | null,
  lastAttemptAt: null as number | null,
  lastError: null as string | null,
  inFlight: null as Promise<void> | null,
};

export function stateFor(ageMs: number | null): RateState {
  if (ageMs == null || ageMs > RATE_NONE_AFTER_MS) return "none";
  return ageMs > RATE_FRESH_MS ? "stale" : "fresh";
}

/** One Coinbase read into the cache. Never throws; a failure is recorded. */
export function refreshBtcUsd(): Promise<void> {
  if (cache.inFlight) return cache.inFlight;
  cache.lastAttemptAt = Date.now();
  cache.inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RATE_TIMEOUT_MS);
    try {
      const res = await fetch(COINBASE_SPOT_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`Coinbase API error: ${res.status}`);
      const body = (await res.json()) as { data?: { amount?: string } };
      const usd = parseFloat(String(body?.data?.amount));
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("Coinbase returned no usable price");
      cache.usd = usd;
      cache.fetchedAt = Date.now();
      cache.lastError = null;
    } catch (err: any) {
      cache.lastError = err?.name === "AbortError" ? "timeout" : String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

/** The cached rate with its age and state. Starts a refresh, unawaited, when
 *  one is due. */
export function getBtcUsd(now: number = Date.now()): BtcUsdRate {
  if (!cache.inFlight && (cache.lastAttemptAt == null || now - cache.lastAttemptAt >= RATE_REFRESH_MS)) {
    void refreshBtcUsd();
  }
  const ageMs = cache.fetchedAt == null ? null : Math.max(0, now - cache.fetchedAt);
  const state = stateFor(ageMs);
  return {
    usd: state === "none" ? null : cache.usd,
    source: "coinbase",
    fetched_at: cache.fetchedAt,
    age_ms: ageMs,
    state,
    last_attempt_at: cache.lastAttemptAt,
    last_error: cache.lastError,
  };
}

/** Background refresh, started once at API startup. */
export function startBtcUsdRefresh(): void {
  void refreshBtcUsd();
  setInterval(() => { void refreshBtcUsd(); }, RATE_REFRESH_MS).unref();
}
