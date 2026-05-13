// Subscription status response shaping + member-side proxy.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §5.1 (member-local proxy) + §5.2 (treasury
//     response shape Cases A-E)
//
// The /api/subscription/status route runs on every node. Treasury
// computes the actual payload by reading subscription state. Members
// validate the caller's JWT locally for fast-path 401/503, then
// forward to treasury and return the unmodified response.
//
// Case A (applicable: true) returns the full subscription payload. The
// four other cases (B-E) return discriminated `applicable: false`
// shapes that the member UI branches on to render the right panel
// state (per spec §6.1).
//
// Tier-transition observation: on every successful Case A response,
// the member-side proxy fires observeTierForTransition() so any
// scope mismatch between the cached token and the new tier triggers
// an out-of-band token re-issuance (spec §6.5).

import { db } from "../db";
import { getSubscriptionPolicy } from "./policy";
import { classifyLanePurpose } from "./lanePurpose";
import { JwtVerificationError } from "./jwtVerify";

const MS_PER_DAY = 86_400_000;
const NOT_YET_ALLOCATED_WINDOW_MS = 60 * 1000; // spec §5.2 Case C threshold

// ─── Response shape (matches Stage 5a spec §5.2) ──────────────────

export interface SubscriptionStatusApplicable {
  applicable: true;
  member_pubkey: string;
  current_tier: "prepay" | "current" | "worker_lapsed" | "routing_lapsed" | "close_due";
  paid_through: number;
  price_sats: number;
  period_days: number;
  deposit_address: string;
  last_payment_at: number | null;
  last_payment_txid: string | null;
  grace: {
    worker_until: number;
    routing_until: number;
    close_at: number;
  };
}

export interface SubscriptionStatusNotApplicable {
  applicable: false;
  reason: "external_peer" | "unclassified" | "not_yet_allocated" | "missing" | "no_channel";
  /** Set only when reason === "not_yet_allocated" (Case C). */
  channel_age_seconds?: number;
}

export type SubscriptionStatusResponse =
  | SubscriptionStatusApplicable
  | SubscriptionStatusNotApplicable;

// ─── Treasury-side computation (Cases A-E) ────────────────────────

interface SubscriptionRow {
  member_pubkey: string;
  deposit_address: string;
  paid_through: number;
  created_at: number;
  last_payment_txid: string | null;
  last_payment_at: number | null;
  current_tier: string;
}

interface ChannelRow {
  channel_id: string;
  first_seen_at: number | null;
  updated_at: number;
}

/**
 * Computes the §5.2 discriminated response shape for a given member
 * pubkey. Pure of HTTP — caller wires the result to a 200 response.
 * Logs CRITICAL on Case D (operational anomaly) so operators see the
 * "row should exist but doesn't" signal in stdout.
 */
export function computeSubscriptionStatusForPubkey(
  memberPubkey: string,
): SubscriptionStatusResponse {
  const pubkey = memberPubkey.toLowerCase();

  // Case A — subscription row exists.
  const row = db
    .prepare(
      `SELECT member_pubkey, deposit_address, paid_through, created_at,
              last_payment_txid, last_payment_at, current_tier
       FROM subscription WHERE member_pubkey = ?`,
    )
    .get(pubkey) as SubscriptionRow | undefined;
  if (row) {
    const policy = getSubscriptionPolicy();
    return {
      applicable: true,
      member_pubkey: row.member_pubkey,
      current_tier: row.current_tier as SubscriptionStatusApplicable["current_tier"],
      paid_through: row.paid_through,
      price_sats: policy.price_sats,
      period_days: policy.period_days,
      deposit_address: row.deposit_address,
      last_payment_at: row.last_payment_at,
      last_payment_txid: row.last_payment_txid,
      grace: {
        worker_until: row.paid_through + policy.grace_days_worker * MS_PER_DAY,
        routing_until: row.paid_through + policy.grace_days_routing * MS_PER_DAY,
        close_at: row.paid_through + policy.grace_days_close * MS_PER_DAY,
      },
    };
  }

  // No row — discriminate Cases B/C/D/E by channel + lane state.
  const channel = db
    .prepare(
      `SELECT channel_id, first_seen_at, updated_at
       FROM lnd_channels WHERE peer_pubkey = ?
       ORDER BY first_seen_at ASC NULLS LAST
       LIMIT 1`,
    )
    .get(pubkey) as ChannelRow | undefined;

  // Case E — no channel at all.
  if (!channel) {
    return { applicable: false, reason: "no_channel" };
  }

  // Case B — channel exists but lane purpose excludes this peer.
  const lane = classifyLanePurpose(pubkey);
  if (lane === "external_peer") {
    return { applicable: false, reason: "external_peer" };
  }
  if (lane === "unclassified") {
    return { applicable: false, reason: "unclassified" };
  }

  // Lane is merchant_lane or farmer_lane → in scope. No row means
  // either transient (sync loop hasn't allocated yet) or anomaly.
  const firstSeen = channel.first_seen_at ?? channel.updated_at;
  const ageMs = Date.now() - firstSeen;

  if (ageMs < NOT_YET_ALLOCATED_WINDOW_MS) {
    return {
      applicable: false,
      reason: "not_yet_allocated",
      channel_age_seconds: Math.max(0, Math.floor(ageMs / 1000)),
    };
  }

  // Case D — operational anomaly. Logged at CRITICAL severity per
  // spec §5.2 so operators see it without polling the admin debug
  // route.
  console.error(
    `[CRITICAL][subscription-status] Case D — channel exists for ` +
      `${pubkey} (channel_id=${channel.channel_id}, lane=${lane}, ` +
      `age_seconds=${Math.floor(ageMs / 1000)}) but no subscription ` +
      `row. Allocation should have run; investigate detector.ts + ` +
      `addressAllocator.ts.`,
  );
  return { applicable: false, reason: "missing" };
}

// ─── Auth-error → HTTP status mapping (member-side fast-path) ────

export interface FastPathRejection {
  status: number;
  body: { error: string; detail?: string };
}

/**
 * Maps a JwtVerificationError to its fast-path HTTP response per the
 * 5a.1 mapping table. The 503 path is reserved for `no_treasury_key`
 * — infrastructure failure semantically distinct from 401 auth
 * failure. All other validation errors are 401 (re-authenticate).
 */
export function mapJwtErrorToFastPath(err: JwtVerificationError): FastPathRejection {
  if (err.reason === "no_treasury_key") {
    return {
      status: 503,
      body: { error: "no_treasury_key", detail: err.message },
    };
  }
  return {
    status: 401,
    body: { error: err.reason, detail: err.message },
  };
}
