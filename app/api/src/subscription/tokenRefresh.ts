// Local entitlement-token cache + refresh scheduler.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-08-member-subscription.md §6.4
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §4.2, §8 (cache the treasury public key, boot
//     exp-backoff retry)
//
// Every node (treasury or member) keeps a single JWT in
// `subscription_local_token`. The refresh loop runs every ~12h —
// overlapping the 24h token validity halfway, so a temporary
// treasury-unreachable window does not immediately invalidate the
// node's cached token.
//
// On member nodes, every successful /treasury-info fetch also caches
// the treasury's Ed25519 public-key JWK alongside the token. The cache
// is the source of truth for member-side JWT validation (jwtVerify.ts
// reads it). Treasury nodes never write the JWK columns — they have
// the local keypair file and don't need a cache.
//
// Boot-time retry (spec §8): if the first refresh attempt fails, we
// retry on an exponential schedule (10s → +30s → +2min → +10min) before
// settling into the steady 12h cadence. Self-heal-driven refreshes
// (jwtVerify.ts on bad_signature) and operator-driven force-refreshes
// route through the same forceTreasuryInfoFetch() entry point, which
// is rate-limited to ≤1/30s.

import { db } from "../db";
import { ENV } from "../config/env";
import { PORTS } from "../config/ports";
import { getLndInfo, lndSignMessage } from "../lightning/lnd";

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 1000;
const CHALLENGE_PREFIX = "bitcorn:token-request:";
const WORKER_DISCOVERY_TIMEOUT_MS = 3000;

// Exponential-backoff schedule for the first refresh attempt only.
// On success the chain breaks and the 12h interval kicks in. On
// exhaustion we settle to the 12h interval — a failure to refresh
// during cold-boot doesn't bound the steady-state cadence.
const BOOT_RETRY_DELAYS_MS = [
  30 * 1000,         // +30s
  2 * 60 * 1000,     // +2min
  10 * 60 * 1000,    // +10min
];

// Rate-limit window for forceTreasuryInfoFetch() (spec §4.4: ≤1
// self-heal-driven fetch per 30 seconds, to prevent stampede if many
// requests with the same stale token hit member-side validation in
// close succession).
const TREASURY_INFO_FETCH_MIN_INTERVAL_MS = 30 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let bootRetryIdx = 0;
let lastTreasuryInfoFetchAt = 0;
let inFlightTreasuryInfoFetch: Promise<TreasuryInfo | null> | null = null;

interface TreasuryInfo {
  api_url: string | null;
  subscription_public_key: object | null;
}

/**
 * Fetches the Worker's /treasury-info endpoint and returns both
 * publishable fields. Returns null on any failure (Worker unreachable,
 * malformed response, etc.). The caller decides what to do with the
 * absence — typically use cached values if any, error otherwise.
 *
 * The Worker URL is the existing COINBASE_WORKER_URL — same Worker the
 * rest of the app already targets. If COINBASE_WORKER_URL is unset the
 * member can't discover anything; in practice every deployed install
 * has it set (it's required for the Coinbase Onramp feature).
 */
async function fetchTreasuryInfoFromWorker(): Promise<TreasuryInfo | null> {
  if (!ENV.coinbaseWorkerUrl) return null;
  const url = `${ENV.coinbaseWorkerUrl.replace(/\/+$/, "")}/treasury-info`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      api_url?: string | null;
      subscription_public_key?: object | null;
    };
    const apiUrlCandidate = body?.api_url;
    const apiUrl =
      typeof apiUrlCandidate === "string" && /^https?:\/\//i.test(apiUrlCandidate)
        ? apiUrlCandidate
        : null;
    const subKey =
      body?.subscription_public_key && typeof body.subscription_public_key === "object"
        ? body.subscription_public_key
        : null;
    return { api_url: apiUrl, subscription_public_key: subKey };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forces a /treasury-info re-fetch and updates the cache columns on
 * the `subscription_local_token` singleton row. Used by jwtVerify.ts
 * on bad_signature (self-heal) and could be called from operator-
 * driven "refresh now" flows in Stage 5a.2.
 *
 * Rate-limited to ≤1 fetch per 30s. Coalesces concurrent callers onto
 * a single in-flight Promise so a burst of bad_signature errors does
 * not produce a burst of Worker requests.
 *
 * Returns the fetched info on success, or null if rate-limited /
 * Worker unreachable. Members fall back to cached values; never
 * throws.
 */
export async function forceTreasuryInfoFetch(): Promise<TreasuryInfo | null> {
  if (inFlightTreasuryInfoFetch) return inFlightTreasuryInfoFetch;
  const now = Date.now();
  if (now - lastTreasuryInfoFetchAt < TREASURY_INFO_FETCH_MIN_INTERVAL_MS) {
    return null;
  }
  lastTreasuryInfoFetchAt = now;
  const promise = (async () => {
    try {
      const info = await fetchTreasuryInfoFromWorker();
      if (info?.subscription_public_key) {
        persistTreasuryPublicKey(JSON.stringify(info.subscription_public_key));
      }
      return info;
    } finally {
      inFlightTreasuryInfoFetch = null;
    }
  })();
  inFlightTreasuryInfoFetch = promise;
  return promise;
}

/**
 * Writes the treasury public-key JWK string to the cache columns. The
 * row may not exist yet on a member node that hasn't completed its
 * first /token refresh; in that case we lazily insert a placeholder
 * with the JWK only. tokenRefresh's mint path will replace this row's
 * jwt/scope/etc. fields when it next succeeds.
 *
 * subscription_local_token has NOT NULL constraints on jwt/scope/etc.
 * For the JWK-only placeholder we use sentinel values that the cache-
 * fresh check (getCachedTokenIfFresh) rejects — `expires_at: 0` makes
 * the placeholder appear expired so no caller treats it as a usable
 * token.
 */
function persistTreasuryPublicKey(jwkString: string): void {
  const now = Date.now();
  const existing = db
    .prepare(`SELECT id FROM subscription_local_token WHERE id = 1`)
    .get();
  if (existing) {
    db.prepare(
      `UPDATE subscription_local_token
       SET treasury_public_key_jwk = ?,
           treasury_info_fetched_at = ?,
           updated_at = ?
       WHERE id = 1`,
    ).run(jwkString, now, now);
  } else {
    db.prepare(
      `INSERT INTO subscription_local_token
         (id, member_pubkey, jwt, scope, issued_at, expires_at,
          fetched_at, updated_at, treasury_public_key_jwk,
          treasury_info_fetched_at)
       VALUES (1, '', '', 'payment', 0, 0, 0, ?, ?, ?)`,
    ).run(now, jwkString, now);
  }
}

export interface CachedToken {
  member_pubkey: string;
  jwt: string;
  scope: "full" | "payment";
  issued_at: number;
  expires_at: number;
  fetched_at: number;
}

export function getCachedToken(): CachedToken | null {
  const row = db
    .prepare(
      `SELECT member_pubkey, jwt, scope, issued_at, expires_at, fetched_at
       FROM subscription_local_token WHERE id = 1`,
    )
    .get() as CachedToken | undefined;
  if (!row) return null;
  // Placeholder rows (JWK-only) have empty jwt — skip them.
  if (!row.jwt) return null;
  return row;
}

/**
 * Returns the cached JWT if it's present and not yet expired. The
 * `validity_buffer_sec` gives the caller room to detect imminent
 * expiry and refuse to send a stale token mid-flight; default 60s.
 */
export function getCachedTokenIfFresh(
  validityBufferSec = 60,
): CachedToken | null {
  const tok = getCachedToken();
  if (!tok) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (tok.expires_at - nowSec <= validityBufferSec) return null;
  return tok;
}

interface RefreshOk {
  ok: true;
  cached: CachedToken;
  scope: "full" | "payment";
}

interface RefreshDenied {
  ok: false;
  reason: "denied" | "transport_error" | "lnd_unavailable";
  status?: number;
  body?: unknown;
  error?: string;
}

export type RefreshResult = RefreshOk | RefreshDenied;

/**
 * Runs a single refresh attempt: builds a signed challenge, posts to
 * the local /api/subscription/token, persists the JWT on success.
 * Never throws — failures return a structured `RefreshDenied`.
 *
 * Also caches the treasury public-key JWK when /treasury-info is
 * fetched as part of resolving the base URL (member-node path).
 */
export async function refreshLocalToken(): Promise<RefreshResult> {
  let info: Awaited<ReturnType<typeof getLndInfo>>;
  try {
    info = await getLndInfo();
  } catch (err: any) {
    return { ok: false, reason: "lnd_unavailable", error: err?.message ?? String(err) };
  }
  const localPubkey = (info.public_key ?? "").toLowerCase();
  if (!localPubkey || !/^[0-9a-f]{66}$/.test(localPubkey)) {
    return { ok: false, reason: "lnd_unavailable", error: "local pubkey unavailable" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const challenge = `${CHALLENGE_PREFIX}${localPubkey}:${nowSec}`;

  let signature: string;
  try {
    signature = await lndSignMessage(challenge);
  } catch (err: any) {
    return { ok: false, reason: "lnd_unavailable", error: err?.message ?? String(err) };
  }

  // Resolve the base URL for the /token endpoint. Precedence:
  //  1. Operator-set TREASURY_API_URL env on this node (operator
  //     override always wins; useful for non-standard topologies).
  //  2. If this IS the treasury node (localPubkey === treasuryPubkey),
  //     hit localhost — the /token endpoint's self-mint carve-out
  //     issues a full-scope token without a network roundtrip.
  //  3. Otherwise (member node, env unset), discover via the Worker's
  //     /treasury-info endpoint. This is the production distribution
  //     path: the treasury operator sets the URL once via `wrangler
  //     secret put TREASURY_API_URL`, all members discover it without
  //     per-node SSH. The same fetch also returns the treasury Ed25519
  //     public-key JWK, which we cache for member-side JWT validation.
  //  4. If all three fail, return a transport_error and let the next
  //     refresh tick retry.
  let baseUrl: string | null = null;
  const onTreasury =
    !!ENV.treasuryPubkey && localPubkey === ENV.treasuryPubkey.toLowerCase();
  if (ENV.treasuryApiUrl) {
    baseUrl = ENV.treasuryApiUrl;
  } else if (onTreasury) {
    baseUrl = `http://127.0.0.1:${PORTS.userApi}`;
  } else {
    const treasuryInfo = await fetchTreasuryInfoFromWorker();
    if (treasuryInfo) {
      lastTreasuryInfoFetchAt = Date.now();
      if (treasuryInfo.subscription_public_key) {
        persistTreasuryPublicKey(JSON.stringify(treasuryInfo.subscription_public_key));
      }
      if (treasuryInfo.api_url) {
        baseUrl = treasuryInfo.api_url;
      }
    }
  }
  if (!baseUrl) {
    return {
      ok: false,
      reason: "transport_error",
      error:
        "treasury API URL not configured. Set TREASURY_API_URL on this node, " +
        "or have the treasury operator publish it via `wrangler secret put " +
        "TREASURY_API_URL` so members can discover it via /treasury-info.",
    };
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/api/subscription/token`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, signature }),
    });
  } catch (err: any) {
    return { ok: false, reason: "transport_error", error: err?.message ?? String(err) };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, reason: "denied", status: res.status, body };
  }
  const payload = body as {
    jwt: string;
    scope: "full" | "payment";
    issued_at_sec: number;
    expires_at_sec: number;
  };

  const fetchedAt = Date.now();
  const upsert = db.prepare(
    `INSERT INTO subscription_local_token
       (id, member_pubkey, jwt, scope, issued_at, expires_at, fetched_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       member_pubkey = excluded.member_pubkey,
       jwt = excluded.jwt,
       scope = excluded.scope,
       issued_at = excluded.issued_at,
       expires_at = excluded.expires_at,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
  );
  upsert.run(
    localPubkey,
    payload.jwt,
    payload.scope,
    payload.issued_at_sec * 1000,
    payload.expires_at_sec * 1000,
    fetchedAt,
    fetchedAt,
  );

  return {
    ok: true,
    scope: payload.scope,
    cached: {
      member_pubkey: localPubkey,
      jwt: payload.jwt,
      scope: payload.scope,
      issued_at: payload.issued_at_sec * 1000,
      expires_at: payload.expires_at_sec * 1000,
      fetched_at: fetchedAt,
    },
  };
}

export function startTokenRefreshScheduler(): void {
  if (intervalHandle != null || pendingTimer != null) return;
  console.log(
    `[subscription-token] refresh scheduler starting — initial delay ${INITIAL_DELAY_MS}ms, interval ${REFRESH_INTERVAL_MS}ms`,
  );
  bootRetryIdx = 0;
  // Schedule the first attempt; the chain manages itself from there.
  pendingTimer = setTimeout(runScheduledAttempt, INITIAL_DELAY_MS);
}

function runScheduledAttempt(): void {
  pendingTimer = null;
  refreshLocalToken()
    .then((result) => {
      logRefreshResult(result);
      if (result.ok) {
        // Success: break the retry chain and enter steady-state 12h
        // cadence (idempotent — startTokenRefreshScheduler is a no-op
        // if the interval is already armed).
        if (intervalHandle == null) {
          intervalHandle = setInterval(() => {
            refreshLocalToken()
              .then(logRefreshResult)
              .catch((err) =>
                console.warn(
                  "[subscription-token] periodic refresh threw:",
                  err?.message ?? err,
                ),
              );
          }, REFRESH_INTERVAL_MS);
        }
        return;
      }
      // Failure: walk the boot-retry schedule. If we've exhausted it,
      // settle into the 12h cadence anyway — a perma-failed boot
      // doesn't deserve a tighter loop than steady state.
      const nextDelay = BOOT_RETRY_DELAYS_MS[bootRetryIdx];
      if (nextDelay != null) {
        bootRetryIdx++;
        console.log(
          `[subscription-token] boot retry ${bootRetryIdx}/${BOOT_RETRY_DELAYS_MS.length} in ${nextDelay}ms`,
        );
        pendingTimer = setTimeout(runScheduledAttempt, nextDelay);
      } else if (intervalHandle == null) {
        console.warn(
          "[subscription-token] boot retries exhausted; settling to 12h interval",
        );
        intervalHandle = setInterval(() => {
          refreshLocalToken()
            .then(logRefreshResult)
            .catch((err) =>
              console.warn(
                "[subscription-token] periodic refresh threw:",
                err?.message ?? err,
              ),
            );
        }, REFRESH_INTERVAL_MS);
      }
    })
    .catch((err) => {
      console.warn("[subscription-token] refresh threw:", err?.message ?? err);
      // Same retry-walk on unexpected throws.
      const nextDelay = BOOT_RETRY_DELAYS_MS[bootRetryIdx];
      if (nextDelay != null) {
        bootRetryIdx++;
        pendingTimer = setTimeout(runScheduledAttempt, nextDelay);
      }
    });
}

export function stopTokenRefreshScheduler(): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  bootRetryIdx = 0;
}

function logRefreshResult(r: RefreshResult): void {
  if (r.ok) {
    console.log(
      `[subscription-token] refresh ok — scope=${r.scope}, expires_in=${Math.floor(
        (r.cached.expires_at - Date.now()) / 1000,
      )}s`,
    );
  } else {
    console.warn(
      `[subscription-token] refresh failed — reason=${r.reason}${
        r.status ? ` status=${r.status}` : ""
      }${r.error ? ` error=${r.error}` : ""}`,
    );
  }
}
