// Is the treasury's cached channel data old enough to be worth saying so?
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// assertCanExpand() decides whether a channel open is permitted using two
// numbers read from lnd_channels with NO age predicate: SUM(capacity_sat) over
// all channels, and the same per peer. Both are compared in the direction where
// a SMALLER number is MORE permissive:
//
//   deploy ratio:  refuse if  deployed + pending + new  >  (balance + deployed) · r
//                  rearranged, PASS requires  deployed ≤ (r·balance − pending − new)/(1−r)
//                  — an UPPER bound on `deployed`, so under-counting loosens it.
//   peer cap:      refuse if  peerDeployed + new > max_peer_capacity_sats
//                  — `peerDeployed` appears only on the refusing side.
//
// So stale or missing channel rows make the guardrail EASIER to pass, never
// harder. There is no direction in which staleness tightens it. Worse, the same
// function reads chain balance and pending channels LIVE from LND — those fail
// CLOSED by throwing — so a node whose LND answers but whose sync loop is behind
// gets a live numerator against a stale denominator, which is the combination
// that maximises the error.
//
// ⚠ REPORT-ONLY, BY DECISION — NOT AN OVERSIGHT. Nothing here refuses anything.
// A refusal would have to fire on `never_synced`, which is the NORMAL state of a
// node that has not completed its first sync, and on a member node the farmer is
// the only operator — so a strict gate would brick first-run provisioning with
// nobody to escalate to. The precedent is ONCHAIN_RESERVE_CHECK_SKIPPED in
// treasury-alerts.ts, which exists because a capital guardrail that "read
// healthy because it was silent, not because it passed" is the dangerous case.
// This makes the silence audible without making it fatal.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE CASE THAT HAD TO BE ANSWERED: never-synced vs genuinely-zero-channels
//
// lightning/persist-channels.ts DELETEs every row when LND legitimately reports
// zero channels. So an empty lnd_channels table carries no updated_at at all,
// and MAX(updated_at) is NULL for BOTH:
//
//   (a) a node that has never completed a sync — data age unknown, and the
//       guardrail is reading zeros it should not trust; and
//   (b) a treasury that genuinely has no channels open — zeros are CORRECT,
//       nothing is stale, and an alert here would be a false positive on every
//       freshly provisioned node.
//
// They are distinguished by a SECOND timestamp: lnd_node_info.updated_at.
// lightning/sync.ts runs persistChannels() and THEN persistNodeInfo() in the
// same tick, so a fresh lnd_node_info row is evidence that a tick got PAST the
// channel write and completed. Empty table + fresh node info = case (b), and no
// alert. Empty table + stale or absent node info = case (a), and we say so.
//
// ⚠ THIS DISCRIMINATOR DEPENDS ON THAT ORDERING AND WOULD BREAK SILENTLY IF IT
// CHANGED. If persistNodeInfo() ever moves BEFORE persistChannels(), a fresh
// node-info row would no longer imply the channel write happened, and case (a)
// would start reporting as case (b) — a stale guardrail reading as healthy,
// which is precisely the failure this module exists to make loud.
// channelDataStaleness.test.ts pins the ordering directly against sync.ts's
// source so the dependency fails loudly instead.
// ═══════════════════════════════════════════════════════════════════════════

import { channelDataFreshness } from "./memberStatsFreshness";
import type { AlertSeverity } from "./treasury-alerts";

/**
 * How old channel rows may be before it is worth saying so.
 *
 * ⚠ SHIPS AS A CONSTANT, NOT AN ENV VAR. This module's file is deployed to every
 * node in the fleet, and nobody edits a farmer's .env — a per-node knob would be
 * unreachable for the people running most of the nodes. The thresholds come from
 * base/staleness.ts (5 min -> stale, 30 min -> very_stale) via
 * channelDataFreshness, which against a 15s sync loop is 20 missed ticks before
 * anything is said. That is the same don't-alarm-on-one-tick discipline as the
 * web freshness tracker's 3-strike threshold, and it is reused rather than
 * re-chosen so there is one answer to "how old is too old" in this codebase.
 */
export type ChannelStalenessInput = {
  /** MAX(updated_at) over lnd_channels, or null when the table is empty. */
  latestChannelUpdatedAt: number | null;
  /** COUNT(*) over lnd_channels. Zero and null-max are the same table state. */
  channelRowCount: number;
  /** lnd_node_info.updated_at, or null when no row exists (never synced). */
  nodeInfoUpdatedAt: number | null;
  nowMs: number;
};

export type ChannelStalenessAlert = {
  type: "CHANNEL_DATA_STALE";
  severity: AlertSeverity;
  message: string;
  data: Record<string, any>;
  at: number;
};

/**
 * Pure. Returns the alert, or null when the cached channel data is trustworthy.
 * `nowMs` is injected; this reads no clock and touches no database.
 */
export function channelDataStalenessAlert(
  input: ChannelStalenessInput,
): ChannelStalenessAlert | null {
  const { latestChannelUpdatedAt, channelRowCount, nodeInfoUpdatedAt, nowMs } = input;

  // ── Empty table. Which of the two cases is it?
  if (channelRowCount === 0 || latestChannelUpdatedAt == null) {
    const nodeInfo = channelDataFreshness(nodeInfoUpdatedAt, nowMs);

    // (b) The sync loop completed recently and found nothing. Zeros are correct.
    if (nodeInfo.staleness === "fresh") return null;

    // (a) No corroboration that a tick ever got past the channel write. The
    //     guardrail is reading zeros of unknown provenance, and zero is its most
    //     permissive input.
    return {
      type: "CHANNEL_DATA_STALE",
      severity: nodeInfo.staleness === "never_synced" ? "warning" : "critical",
      message:
        nodeInfo.staleness === "never_synced"
          ? "Channel data has never been synced — capital guardrails are reading zero deployed capacity, " +
            "which is their most permissive input. Expansion is NOT blocked."
          : `Channel data is empty and the sync loop last completed ${nodeInfo.age_seconds}s ago — ` +
            `cannot distinguish "no channels" from "never synced". Capital guardrails are reading ` +
            `zero deployed capacity. Expansion is NOT blocked.`,
      data: {
        channel_row_count: 0,
        channel_data_age_seconds: null,
        node_info_age_seconds: nodeInfo.age_seconds,
        node_info_staleness: nodeInfo.staleness,
        // Named so a reader of the alert payload does not have to know the
        // module's internals to see WHY it could not tell the cases apart.
        indistinguishable_cases: ["never_synced", "genuinely_zero_channels"],
        guardrail_effect: "permissive",
        blocks_expansion: false,
      },
      at: nowMs,
    };
  }

  // ── Rows exist. Age them directly.
  const channels = channelDataFreshness(latestChannelUpdatedAt, nowMs);
  if (channels.staleness === "fresh") return null;

  return {
    type: "CHANNEL_DATA_STALE",
    severity: channels.staleness === "very_stale" ? "critical" : "warning",
    message:
      `Channel data is ${channels.staleness} (${channels.age_seconds}s old) — capital guardrails ` +
      `are computing deployed capacity from rows this age, which under-counts and makes the ` +
      `deploy-ratio and per-peer checks EASIER to pass. Expansion is NOT blocked.`,
    data: {
      channel_row_count: channelRowCount,
      channel_data_age_seconds: channels.age_seconds,
      channel_data_staleness: channels.staleness,
      updated_at_ms: channels.updated_at_ms,
      guardrail_effect: "permissive",
      blocks_expansion: false,
    },
    at: nowMs,
  };
}
