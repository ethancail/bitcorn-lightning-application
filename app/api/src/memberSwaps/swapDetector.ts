/**
 * Swap detector — runs at the end of each rebalance scheduler tick.
 *
 * Scans member clusters for liquidity imbalances and writes recommendations
 * to the DB. Does NOT execute anything — the treasury operator must approve.
 *
 * Cash Out: member-local too high (treasury-remote heavy) → Loop In
 * Top Up:   member-local too low  (treasury-local heavy)  → Loop Out
 */

import { db } from "../db";
import type { ClusterState } from "../rebalance/clusterState";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SwapType = "cash_out" | "top_up";

export interface SwapRecommendation {
  recommendationId: string;
  clusterId: string;
  memberLabel: string;
  swapType: SwapType;
  triggerReason: string;
  suggestedAmountSats: number;
  estimatedFeeSats: number | null;
  postSwapLocalPct: number;
  status: string;
  createdAt: number;
}

// ─── Config defaults ─────────────────────────────────────────────────────────

interface SwapConfig {
  cashout_trigger_pct: number;
  topup_trigger_pct: number;
  min_swap_sats: number;
  max_swap_sats: number;
  consecutive_runs_required: number;
}

const DEFAULT_CONFIG: SwapConfig = {
  cashout_trigger_pct: 0.60,
  topup_trigger_pct: 0.30,
  min_swap_sats: 50_000,
  max_swap_sats: 500_000,
  consecutive_runs_required: 2,
};

function getConfig(clusterId: string): SwapConfig {
  const row = db.prepare(
    `SELECT cashout_trigger_pct, topup_trigger_pct, min_swap_sats,
            max_swap_sats, consecutive_runs_required
     FROM member_swap_config WHERE cluster_id = ?`
  ).get(clusterId) as SwapConfig | undefined;
  return row ?? DEFAULT_CONFIG;
}

// ─── Consecutive-run tracking ────────────────────────────────────────────────

// In-memory map: clusterId → { type, consecutiveRuns }
const consecutiveState = new Map<string, { type: SwapType; runs: number }>();

function trackConsecutive(clusterId: string, type: SwapType): number {
  const prev = consecutiveState.get(clusterId);
  if (prev && prev.type === type) {
    prev.runs++;
    return prev.runs;
  }
  consecutiveState.set(clusterId, { type, runs: 1 });
  return 1;
}

function resetConsecutive(clusterId: string): void {
  consecutiveState.delete(clusterId);
}

// ─── Guard checks ────────────────────────────────────────────────────────────

function hasPendingSwap(clusterId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM member_swap_recommendations
     WHERE cluster_id = ? AND status IN ('pending', 'approved', 'executing')
     LIMIT 1`
  ).get(clusterId);
  return !!row;
}

function isInRejectionCooldown(clusterId: string, swapType: SwapType): boolean {
  const row = db.prepare(
    `SELECT rejected_at, rejection_cooldown_sec
     FROM member_swap_recommendations
     WHERE cluster_id = ? AND swap_type = ? AND status = 'rejected'
     ORDER BY rejected_at DESC LIMIT 1`
  ).get(clusterId, swapType) as
    | { rejected_at: number; rejection_cooldown_sec: number }
    | undefined;

  if (!row || !row.rejected_at) return false;
  return Date.now() - row.rejected_at < row.rejection_cooldown_sec * 1000;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export function detectSwapOpportunities(
  clusterStates: ClusterState[]
): SwapRecommendation[] {
  const recommendations: SwapRecommendation[] = [];
  const now = Date.now();

  for (const state of clusterStates) {
    // Only detect on member clusters
    if (
      state.policyRole !== "member_primary_outbound" &&
      state.policyRole !== "member_secondary_buffer"
    ) {
      resetConsecutive(state.clusterId);
      continue;
    }

    const config = getConfig(state.clusterId);

    // Member-local = treasury-remote = state.remoteBalanceSats
    // Treasury-local = state.localBalanceSats
    const memberLocalPct = state.totalCapacitySats > 0
      ? state.remoteBalanceSats / state.totalCapacitySats
      : 0;

    let detected: SwapType | null = null;

    // Cash Out: member-local too high (treasury-remote heavy)
    if (memberLocalPct >= config.cashout_trigger_pct) {
      if (state.remoteBalanceSats >= config.min_swap_sats) {
        detected = "cash_out";
      }
    }
    // Top Up: member-local too low (treasury-local heavy)
    else if (memberLocalPct <= config.topup_trigger_pct) {
      detected = "top_up";
    }

    if (!detected) {
      resetConsecutive(state.clusterId);
      continue;
    }

    const runs = trackConsecutive(state.clusterId, detected);
    if (runs < config.consecutive_runs_required) continue;

    // Guard: skip if pending swap already exists
    if (hasPendingSwap(state.clusterId)) continue;

    // Guard: skip if recently rejected
    if (isInRejectionCooldown(state.clusterId, detected)) continue;

    // Compute suggested amount
    let suggestedAmount: number;
    let targetMemberLocalPct: number;

    if (detected === "cash_out") {
      // Move member-local back to 40%
      targetMemberLocalPct = 0.40;
      const targetRemote = Math.round(state.totalCapacitySats * targetMemberLocalPct);
      suggestedAmount = state.remoteBalanceSats - targetRemote;
    } else {
      // Move member-local back to 60%
      targetMemberLocalPct = 0.60;
      const targetRemote = Math.round(state.totalCapacitySats * targetMemberLocalPct);
      suggestedAmount = targetRemote - state.remoteBalanceSats;
    }

    suggestedAmount = Math.max(config.min_swap_sats, Math.min(suggestedAmount, config.max_swap_sats));

    // Check Top Up minimum: suggested amount must meet min_swap_sats
    if (detected === "top_up" && suggestedAmount < config.min_swap_sats) continue;

    const postSwapRemote = detected === "cash_out"
      ? state.remoteBalanceSats - suggestedAmount
      : state.remoteBalanceSats + suggestedAmount;
    const postSwapLocalPct = state.totalCapacitySats > 0
      ? (state.totalCapacitySats - postSwapRemote) / state.totalCapacitySats
      : 0;

    const memberLocalPctDisplay = Math.round(memberLocalPct * 100);
    const thresholdDisplay = detected === "cash_out"
      ? Math.round(config.cashout_trigger_pct * 100)
      : Math.round(config.topup_trigger_pct * 100);
    const triggerReason = detected === "cash_out"
      ? `member-local ${memberLocalPctDisplay}% — above ${thresholdDisplay}% threshold for ${runs} runs`
      : `member-local ${memberLocalPctDisplay}% — below ${thresholdDisplay}% threshold for ${runs} runs`;

    const recId = `swap_${detected}_${state.clusterId}_${now}`;

    const rec: SwapRecommendation = {
      recommendationId: recId,
      clusterId: state.clusterId,
      memberLabel: state.label,
      swapType: detected,
      triggerReason,
      suggestedAmountSats: suggestedAmount,
      estimatedFeeSats: null,
      postSwapLocalPct: Math.round(postSwapLocalPct * 10000) / 100,
      status: "pending",
      createdAt: now,
    };

    // Write to DB
    db.prepare(
      `INSERT INTO member_swap_recommendations
         (recommendation_id, cluster_id, swap_type, trigger_reason,
          suggested_amount_sats, estimated_fee_sats, post_swap_local_pct,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      rec.recommendationId,
      rec.clusterId,
      rec.swapType,
      rec.triggerReason,
      rec.suggestedAmountSats,
      rec.estimatedFeeSats,
      rec.postSwapLocalPct,
      now,
      now
    );

    recommendations.push(rec);

    console.log(
      `[swap-detector] ${detected} recommendation for ${state.label}: ` +
      `${suggestedAmount.toLocaleString()} sats (${triggerReason})`
    );
  }

  return recommendations;
}
