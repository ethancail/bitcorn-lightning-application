// Stage 5b — admin members list batched discrimination.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-20-stage-5b-admin-members-list.md
//     §2 (data model + batched derivation) and §4.2 (response shape)
//   - decisions/2026-05-18-subscription-stage-5a-follow-up-deltas.md §7
//     (member-local proxy is a reusable primitive; this endpoint is a
//     *cross-member* admin endpoint, NOT a proxy — see spec §4.4)
//
// Per spec §10.2: the implementation runs the existing per-pubkey Cases
// A-E discrimination from statusHandler.computeSubscriptionStatusForPubkey
// in a server-side loop across all channel-peer pubkeys. At Bitcorn's
// current scale (single-digit to low-tens of members per treasury), the
// per-pubkey loop is the right shape — simpler than a single-query JOIN
// that would have to re-derive the discrimination logic locally.
//
// Naming convention note (small spec deviation worth flagging):
// the spec §2.1 / §4.2 uses dash-form for lane_purpose values
// ("merchant-lane") but underscore-form for subscription_state values
// ("external_peer"). The application's internal vocabulary uses
// underscores throughout (statusHandler emits "current_tier",
// lanePurpose.ts emits "merchant_lane"). This handler normalizes to
// underscores in the response — keeps the response shape internally
// consistent and avoids the consumer translating between forms. The
// deviation is small and worth recording in the post-ship deltas.

import { db } from "../db";
import { computeSubscriptionStatusForPubkey } from "./statusHandler";
import { classifyLanePurpose, type LanePurpose } from "./lanePurpose";

// Mirror of the eleven panel-state vocabulary from parent spec §6.1
// (5 tier values from SubscriptionStatusApplicable + 5 reasons from
// SubscriptionStatusNotApplicable).
export type SubscriptionStateKey =
  | "current"
  | "prepay"
  | "worker_lapsed"
  | "routing_lapsed"
  | "close_due"
  | "external_peer"
  | "unclassified"
  | "not_yet_allocated"
  | "missing"
  | "no_channel";

const ALL_STATES: readonly SubscriptionStateKey[] = [
  "current",
  "prepay",
  "worker_lapsed",
  "routing_lapsed",
  "close_due",
  "external_peer",
  "unclassified",
  "not_yet_allocated",
  "missing",
  "no_channel",
];

export interface AdminMembersRow {
  member_pubkey: string;
  lane_purpose: LanePurpose;
  subscription_state: SubscriptionStateKey;
  /** Set only when subscription_state is one of the 5 tier values. */
  current_tier: Extract<
    SubscriptionStateKey,
    "current" | "prepay" | "worker_lapsed" | "routing_lapsed" | "close_due"
  > | null;
  paid_through: number | null;
  last_payment_at: number | null;
  last_payment_amount_sats: number | null;
}

export interface AdminMembersResponse {
  fetched_at: number;
  members: AdminMembersRow[];
  totals: {
    total_members: number;
    by_state: Record<SubscriptionStateKey, number>;
  };
}

interface PeerRow {
  peer_pubkey: string;
}

interface LastPaymentRow {
  amount_sats: number;
}

/**
 * Returns the admin members list. One row per distinct channel-peer
 * pubkey on the treasury's lnd_channels, with per-row Cases A-E
 * discrimination via computeSubscriptionStatusForPubkey, plus the
 * eleven-state distribution counter pre-aggregated.
 *
 * Pure of HTTP — caller wires to a 200 response.
 */
export function computeMembersListForTreasury(): AdminMembersResponse {
  const peerRows = db
    .prepare(`SELECT DISTINCT peer_pubkey FROM lnd_channels`)
    .all() as PeerRow[];

  const members: AdminMembersRow[] = peerRows.map(({ peer_pubkey }) => {
    const status = computeSubscriptionStatusForPubkey(peer_pubkey);
    const lane_purpose = classifyLanePurpose(peer_pubkey);

    if (status.applicable) {
      // Case A — subscription row exists. Look up the most recent
      // onchain payment for the amount column. Sentinel admin_override
      // rows are excluded — they have amount_sats=0 and would replace
      // the most recent real payment in the display, which is misleading.
      const lastPayment = db
        .prepare(
          `SELECT amount_sats FROM subscription_payment
           WHERE member_pubkey = ? AND kind = 'onchain'
           ORDER BY received_at DESC LIMIT 1`,
        )
        .get(peer_pubkey.toLowerCase()) as LastPaymentRow | undefined;
      return {
        member_pubkey: peer_pubkey,
        lane_purpose,
        subscription_state: status.current_tier,
        current_tier: status.current_tier,
        paid_through: status.paid_through,
        last_payment_at: status.last_payment_at,
        last_payment_amount_sats: lastPayment?.amount_sats ?? null,
      };
    }
    // Cases B-E — no subscription row, reason discriminates.
    return {
      member_pubkey: peer_pubkey,
      lane_purpose,
      subscription_state: status.reason,
      current_tier: null,
      paid_through: null,
      last_payment_at: null,
      last_payment_amount_sats: null,
    };
  });

  // Distribution counter. Pre-seeded with zeros for all eleven states
  // so the response always carries the full taxonomy (per spec §2.3 —
  // zero counts render alongside non-zero so a state newly entering
  // non-zero stands out against its previous zero state).
  const by_state = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<
    SubscriptionStateKey,
    number
  >;
  for (const row of members) by_state[row.subscription_state]++;

  return {
    fetched_at: Date.now(),
    members,
    totals: {
      total_members: members.length,
      by_state,
    },
  };
}
