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
// in a server-side loop across the roster. At Bitcorn's current scale
// (single-digit to low-tens of members per treasury), the per-pubkey
// loop is the right shape — simpler than a single-query JOIN that would
// have to re-derive the discrimination logic locally.
//
// Roster membership (decisions/2026-09-18-channel-less-subscription-row-
// roster-semantics.md): a channel-less subscription row IS a member, so
// the row source is the UNION of channel peers and subscription rows —
// this endpoint is the enrollment ledger, not a view of open channels.
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

interface RosterRow {
  member_pubkey: string;
}

interface LastPaymentRow {
  amount_sats: number;
}

/**
 * The roster: every distinct member pubkey, canonical lowercase.
 *
 * The ONE source for "who is on the roster" — this handler and the
 * public-alias refresh (publicAlias.ts) both read it, so the refresh's
 * coverage cannot drift from the rows the roster renders (D7 §7).
 *
 * The roster is normalized to lowercase HERE, once, because this is
 * the only place the two sources meet. `subscription` stores
 * lowercase; `lnd_channels` stores whatever LND handed the sync loop
 * (persist-channels.ts binds partner_public_key verbatim) and
 * `contacts` stores as-entered. Both `contacts.pubkey` and
 * `lnd_channels.peer_pubkey` are binary-collated TEXT, so case decides
 * whether a lookup matches at all — and classifyLanePurpose does not
 * lowercase (lanePurpose.ts:40,42) while it GATES subscription scope.
 * Emitting the canonical lowercase form keeps this endpoint's lane
 * classification identical to the one every other subscription-scope
 * consumer computes (statusHandler.ts:97,144).
 *
 * UNION, not UNION ALL: it dedupes, so a member holding both a channel
 * and a subscription row yields exactly one roster row.
 */
export function listRosterPubkeys(): string[] {
  const rosterRows = db
    .prepare(
      `SELECT lower(peer_pubkey) AS member_pubkey FROM lnd_channels
       UNION
       SELECT lower(member_pubkey) AS member_pubkey FROM subscription`,
    )
    .all() as RosterRow[];
  return rosterRows.map((r) => r.member_pubkey);
}

/**
 * Returns the admin members list. One row per distinct member pubkey in
 * the roster — the union of the treasury's channel peers and every
 * subscription row, so a member whose channel is not (or no longer)
 * open still appears. Each row carries the Cases A-E discrimination
 * from computeSubscriptionStatusForPubkey, plus the eleven-state
 * distribution counter pre-aggregated.
 *
 * `totals.total_members` and `totals.by_state` are therefore
 * roster-wide, not channel-wide — a deliberate meaning change that
 * comes with the enrollment-ledger semantics.
 *
 * Pure of HTTP — caller wires to a 200 response.
 */
export function computeMembersListForTreasury(): AdminMembersResponse {
  // Lowercase, deduped roster — see listRosterPubkeys.
  const members: AdminMembersRow[] = listRosterPubkeys().map((member_pubkey) => {
    const status = computeSubscriptionStatusForPubkey(member_pubkey);
    const lane_purpose = classifyLanePurpose(member_pubkey);

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
        .get(member_pubkey) as LastPaymentRow | undefined;
      return {
        member_pubkey,
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
      member_pubkey,
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
