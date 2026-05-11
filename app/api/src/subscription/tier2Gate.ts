// Tier 2 routing-gate (spec §5.2).
//
// The forced-routing chokepoint at app/api/src/lightning/pay.ts pins
// outgoing_channel to the treasury channel. Tier 2 attaches there:
// before pinning, check the calling member's tier. If
// `routing_lapsed` / `close_due` / `prepay`, refuse with HTTP 402.
//
// `prepay` is explicitly routing-denied even though chronologically
// it sits before `current` — routing is the core paid feature and
// must not be granted before the first payment confirms (spec §5.2).
// `worker_lapsed` is allowed: that's the Tier 1 penalty alone.
//
// Stage 3 effective enforcement is treasury-only: the lookup keys on
// the LOCAL node's pubkey, and the subscription table is populated
// only on the treasury (members get their tier via Stage 4's
// entitlement-token refresh). On a member node today, the local DB
// has no subscription rows, so the gate is a structural no-op until
// Stage 4 wires the cache. This matches the spec's "feature-flag-able"
// rollout posture for Tier 2 (§10 step 6).

import { db } from "../db";
import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";

/** HTTP 402 payload shape per spec §5.2. */
export interface Tier2DenialBody {
  error: "subscription_routing_denied";
  tier: string;
  paid_through: number | null;
  deposit_address: string | null;
  price_sats: number;
}

/** Thrown by the gate. Caller turns this into a 402 response. */
export class Tier2Denied extends Error {
  constructor(public readonly body: Tier2DenialBody) {
    super(`subscription_routing_denied (${body.tier})`);
    this.name = "Tier2Denied";
  }
}

const DENIED_TIERS = new Set(["prepay", "routing_lapsed", "close_due"]);

/**
 * Asserts the LOCAL node may originate a routing-through-treasury
 * payment. No-op when the gate is disabled, when there's no local
 * subscription row (Stage 3 reality on member nodes), or when the
 * member's tier is `current` / `worker_lapsed`.
 *
 * Throws `Tier2Denied` when the tier is one of the denied values.
 * Caller is responsible for mapping that to a 402 response.
 */
export function assertTier2RoutingAllowed(): void {
  if (!ENV.subscriptionTier2Enabled) return;

  const node = getNodeInfo();
  const localPubkey = node?.pubkey;
  if (!localPubkey) return; // No local pubkey known yet → defer

  const row = db
    .prepare(
      `SELECT current_tier, paid_through, deposit_address
       FROM subscription WHERE member_pubkey = ?`,
    )
    .get(localPubkey) as
      | {
          current_tier: string;
          paid_through: number;
          deposit_address: string;
        }
      | undefined;

  // Stage 3: members don't have local subscription rows yet.
  // No row → no enforcement. Stage 4 will populate this.
  if (!row) return;

  if (DENIED_TIERS.has(row.current_tier)) {
    const policy = db
      .prepare("SELECT price_sats FROM subscription_policy WHERE id = 1")
      .get() as { price_sats: number } | undefined;
    throw new Tier2Denied({
      error: "subscription_routing_denied",
      tier: row.current_tier,
      paid_through: row.paid_through,
      deposit_address: row.deposit_address,
      price_sats: policy?.price_sats ?? 50000,
    });
  }
}
