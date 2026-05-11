// §5.3 Tier 3 — channel cooperative-close scheduler.
//
// Stage 3 ships this in DRY-RUN mode. The scheduler iterates members
// with `current_tier = 'close_due'` every 5 minutes (configurable),
// re-checks their tier at execute time, and structured-logs what it
// WOULD have closed. No LND CloseChannel call is issued. Promotion
// to live happens at Stage 6 after a ≥60-day observation window
// (spec §10 step 7 + §11 acceptance criteria).
//
// Defense-in-depth lane check: even though the §3.0 scope rule
// prevents external-peer / unclassified channels from ever getting a
// subscription row, the scheduler re-classifies each candidate at
// execute time and refuses to queue any peer whose lane purpose isn't
// `merchant_lane` or `farmer_lane`. Per the user's explicit
// instruction during Stage 3 handoff: "under no circumstance should
// an external routing channel (e.g., the treasury's ACINQ channel)
// be queued for cooperative close by the enforcement scheduler."
//
// Live-mode behaviour (Stage 6) writes an audit-ledger row recording
// the close reason and the recovered balance per spec §11. Dry-run
// only logs to stdout — operator inspection is via the application
// log; no DB writes happen.

import { db } from "../db";
import { ENV } from "../config/env";
import { classifyLanePurpose } from "./lanePurpose";
import { getSubscriptionPolicy } from "./policy";
import { recomputeAllTiers } from "./tierDispatch";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

interface CloseCandidate {
  member_pubkey: string;
  paid_through: number;
  current_tier: string;
}

/** What we'd log per close-due member (or actually do, in live mode). */
interface CloseEvent {
  member_pubkey: string;
  channel_id: string | null;
  capacity_sat: number | null;
  treasury_local_sat: number | null;
  member_local_sat: number | null;
  lane_purpose: string;
  paid_through: number;
  recheck_tier: string;
  action: "would_close" | "skipped_recheck_passed" | "skipped_out_of_scope" | "skipped_no_active_channel";
  is_dry_run: boolean;
  recorded_at: number;
}

export interface Tier3TickSummary {
  candidates: number;
  would_close: number;
  skipped_recheck_passed: number;
  skipped_out_of_scope: number;
  skipped_no_active_channel: number;
  is_dry_run: boolean;
  errors: Array<{ member_pubkey: string; error: string }>;
}

export function startTier3Scheduler(): void {
  if (intervalHandle != null) return;
  const intervalMs = ENV.subscriptionTier3IntervalMs;
  console.log(
    `[subscription-tier3] scheduler starting — ${ENV.subscriptionTier3Live ? "LIVE" : "DRY-RUN"} mode, ${intervalMs}ms interval`,
  );
  // First tick after one interval (let the API finish booting); no
  // immediate kick. Tier 3 actions are slow / consequential / rare,
  // so a small startup delay does not matter.
  intervalHandle = setInterval(() => {
    runTier3Tick().catch((err) => {
      console.warn(
        "[subscription-tier3] tick failed:",
        err?.message ?? String(err),
      );
    });
  }, intervalMs);
}

export function stopTier3Scheduler(): void {
  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Single pass — exposed for testing + on-demand trigger. */
export async function runTier3Tick(): Promise<Tier3TickSummary> {
  const isDryRun = !ENV.subscriptionTier3Live;
  const summary: Tier3TickSummary = {
    candidates: 0,
    would_close: 0,
    skipped_recheck_passed: 0,
    skipped_out_of_scope: 0,
    skipped_no_active_channel: 0,
    is_dry_run: isDryRun,
    errors: [],
  };

  // Pre-tick: recompute tiers so the close_due list is fresh.
  // Cheap; reuses the same logic as the detector.
  const policy = getSubscriptionPolicy();
  recomputeAllTiers(policy);

  const candidates = db
    .prepare(
      `SELECT member_pubkey, paid_through, current_tier
       FROM subscription WHERE current_tier = 'close_due'`,
    )
    .all() as CloseCandidate[];
  summary.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      const event = evaluateCandidate(candidate, isDryRun);
      logEvent(event);
      switch (event.action) {
        case "would_close":
          summary.would_close++;
          break;
        case "skipped_recheck_passed":
          summary.skipped_recheck_passed++;
          break;
        case "skipped_out_of_scope":
          summary.skipped_out_of_scope++;
          break;
        case "skipped_no_active_channel":
          summary.skipped_no_active_channel++;
          break;
      }
    } catch (err: any) {
      summary.errors.push({
        member_pubkey: candidate.member_pubkey,
        error: err?.message ?? String(err),
      });
    }
  }

  return summary;
}

function evaluateCandidate(
  candidate: CloseCandidate,
  isDryRun: boolean,
): CloseEvent {
  const recordedAt = Date.now();

  // Defense-in-depth: lane-purpose check at execute time. Should
  // NEVER fire under §3.0 scope rules; if it does, log loudly.
  const lanePurpose = classifyLanePurpose(candidate.member_pubkey);
  const channelInfo = lookupChannelInfo(candidate.member_pubkey);

  if (lanePurpose !== "merchant_lane" && lanePurpose !== "farmer_lane") {
    console.warn(
      `[subscription-tier3] CRITICAL: close_due row for out-of-scope ` +
        `peer ${candidate.member_pubkey.slice(0, 16)}… (lane=${lanePurpose}). ` +
        `This row should not exist; refusing close.`,
    );
    return {
      member_pubkey: candidate.member_pubkey,
      channel_id: channelInfo?.channel_id ?? null,
      capacity_sat: channelInfo?.capacity_sat ?? null,
      treasury_local_sat: channelInfo?.local_balance_sat ?? null,
      member_local_sat: channelInfo?.remote_balance_sat ?? null,
      lane_purpose: lanePurpose,
      paid_through: candidate.paid_through,
      recheck_tier: candidate.current_tier,
      action: "skipped_out_of_scope",
      is_dry_run: isDryRun,
      recorded_at: recordedAt,
    };
  }

  // Re-check tier immediately before close per spec §5.3 — a payment
  // may have arrived between recompute and execute.
  const fresh = db
    .prepare("SELECT current_tier FROM subscription WHERE member_pubkey = ?")
    .get(candidate.member_pubkey) as { current_tier: string } | undefined;
  if (!fresh || fresh.current_tier !== "close_due") {
    return {
      member_pubkey: candidate.member_pubkey,
      channel_id: channelInfo?.channel_id ?? null,
      capacity_sat: channelInfo?.capacity_sat ?? null,
      treasury_local_sat: channelInfo?.local_balance_sat ?? null,
      member_local_sat: channelInfo?.remote_balance_sat ?? null,
      lane_purpose: lanePurpose,
      paid_through: candidate.paid_through,
      recheck_tier: fresh?.current_tier ?? "missing",
      action: "skipped_recheck_passed",
      is_dry_run: isDryRun,
      recorded_at: recordedAt,
    };
  }

  // Need an active channel to close. If the channel isn't active any
  // more (already closed, or not yet established), we can't act.
  if (!channelInfo) {
    return {
      member_pubkey: candidate.member_pubkey,
      channel_id: null,
      capacity_sat: null,
      treasury_local_sat: null,
      member_local_sat: null,
      lane_purpose: lanePurpose,
      paid_through: candidate.paid_through,
      recheck_tier: fresh.current_tier,
      action: "skipped_no_active_channel",
      is_dry_run: isDryRun,
      recorded_at: recordedAt,
    };
  }

  // Stage 3: dry-run only. Stage 6 will issue the actual
  // closeChannel({ lnd, transaction_id, transaction_vout }) call here
  // and write an audit-ledger row capturing the close reason +
  // recovered_balance.
  return {
    member_pubkey: candidate.member_pubkey,
    channel_id: channelInfo.channel_id,
    capacity_sat: channelInfo.capacity_sat,
    treasury_local_sat: channelInfo.local_balance_sat,
    member_local_sat: channelInfo.remote_balance_sat,
    lane_purpose: lanePurpose,
    paid_through: candidate.paid_through,
    recheck_tier: fresh.current_tier,
    action: "would_close",
    is_dry_run: isDryRun,
    recorded_at: recordedAt,
  };
}

function lookupChannelInfo(memberPubkey: string): {
  channel_id: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
} | null {
  const row = db
    .prepare(
      `SELECT channel_id, capacity_sat, local_balance_sat, remote_balance_sat
       FROM lnd_channels
       WHERE peer_pubkey = ? AND active = 1
       ORDER BY capacity_sat DESC
       LIMIT 1`,
    )
    .get(memberPubkey) as
      | {
          channel_id: string;
          capacity_sat: number;
          local_balance_sat: number;
          remote_balance_sat: number;
        }
      | undefined;
  return row ?? null;
}

function logEvent(event: CloseEvent): void {
  // Single-line structured log so an operator (or a future log-shipper)
  // can grep for "[subscription-tier3]" and parse JSON. Differentiates
  // would-close from each skip reason so the dry-run observation
  // window can distinguish "system thinks it would have acted" from
  // "system correctly declined to act."
  console.log(`[subscription-tier3] ${JSON.stringify(event)}`);
}
