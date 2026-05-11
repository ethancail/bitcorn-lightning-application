// One-shot backfill: allocate subscription rows + addresses for every
// peer the treasury already has a channel with at the moment the
// operator acknowledges the first-run gate.
//
// Per spec §10 step 3: existing members are grandfathered as `current`
// to avoid retroactively gating live members at flip-day. New members
// (peers that appear in lnd_channels after the ack) start in `prepay`
// via the sync-loop's per-tick member-discovery pass (see detector.ts).

import { db } from "../db";
import { ENV } from "../config/env";
import { allocateSubscriptionForMember } from "./addressAllocator";

interface BackfillSummary {
  members_seen: number;
  newly_allocated: number;
  already_present: number;
  errors: Array<{ member_pubkey: string; error: string }>;
}

/**
 * Iterates every distinct peer in `lnd_channels` (excluding the
 * treasury's own pubkey) and allocates a grandfathered subscription
 * row for any peer that doesn't already have one. Idempotent — safe
 * to run multiple times; allocator returns early on existing rows.
 *
 * Should be called immediately after `acknowledgeFirstRun()` returns.
 */
export async function backfillExistingMembers(): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    members_seen: 0,
    newly_allocated: 0,
    already_present: 0,
    errors: [],
  };

  const peers = db
    .prepare(
      `SELECT DISTINCT peer_pubkey FROM lnd_channels
       WHERE peer_pubkey != ?`,
    )
    .all(ENV.treasuryPubkey ?? "") as Array<{ peer_pubkey: string }>;

  for (const { peer_pubkey } of peers) {
    summary.members_seen++;
    const existing = db
      .prepare("SELECT 1 FROM subscription WHERE member_pubkey = ?")
      .get(peer_pubkey);
    if (existing) {
      summary.already_present++;
      continue;
    }
    try {
      await allocateSubscriptionForMember(peer_pubkey, "grandfather");
      summary.newly_allocated++;
    } catch (err: any) {
      summary.errors.push({
        member_pubkey: peer_pubkey,
        error: err?.message ?? String(err),
      });
    }
  }

  return summary;
}
