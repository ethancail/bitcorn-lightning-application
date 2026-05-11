// Local entitlement-token cache + refresh scheduler.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §6.4
//
// Every node (treasury or member) keeps a single JWT in
// `subscription_local_token`. The refresh loop runs every ~12h —
// overlapping the 24h token validity halfway, so a temporary
// treasury-unreachable window does not immediately invalidate the
// node's cached token.
//
// Treasury nodes refresh their own self-issued full-scope token. The
// refresh logic is identical for treasury and members because the
// /token endpoint internally handles the treasury-self carve-out
// (tokenIssuance.ts).
//
// Refresh is a local HTTP call to `POST /api/subscription/token`,
// authenticated by signing a challenge with the local LND identity
// key. Failures are logged and retried on the next tick — the cached
// token remains valid until its exp.

import { db } from "../db";
import { ENV } from "../config/env";
import { PORTS } from "../config/ports";
import { getLndInfo, lndSignMessage } from "../lightning/lnd";

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 1000;
const CHALLENGE_PREFIX = "bitcorn:token-request:";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export interface CachedToken {
  member_pubkey: string;
  jwt: string;
  scope: "full" | "prepay";
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
  return row ?? null;
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
  scope: "full" | "prepay";
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

  // Treasury nodes hit their own localhost; member nodes need the
  // operator-configured TREASURY_API_URL pointing at the treasury's
  // reachable API. The /token endpoint's self-mint carve-out handles
  // the treasury case when localPubkey === treasuryPubkey.
  const baseUrl =
    ENV.treasuryApiUrl || `http://127.0.0.1:${PORTS.userApi}`;
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
    scope: "full" | "prepay";
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
  if (intervalHandle != null) return;
  console.log(
    `[subscription-token] refresh scheduler starting — initial delay ${INITIAL_DELAY_MS}ms, interval ${REFRESH_INTERVAL_MS}ms`,
  );
  // Delay the first attempt slightly to let LND finish booting +
  // the first sync iteration to populate `lnd_node_info`.
  initialTimer = setTimeout(() => {
    refreshLocalToken()
      .then(logRefreshResult)
      .catch((err) =>
        console.warn("[subscription-token] initial refresh threw:", err?.message ?? err),
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
  }, INITIAL_DELAY_MS);
}

export function stopTokenRefreshScheduler(): void {
  if (initialTimer != null) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
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
