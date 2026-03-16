/**
 * Liquidity detector — detects treasury push top-up opportunities.
 *
 * Runs at the end of each rebalance scheduler tick. Writes recommendations
 * to DB — never executes anything.
 *
 * Treasury Push trigger: treasury-local above band AND member-local depleted
 * AND member has recent outgoing activity AND 2+ consecutive scheduler runs.
 */

import { db } from "../db";
import { ENV } from "../config/env";
import type { ClusterState } from "../rebalance/clusterState";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemberLiquidityActionType = "treasury_push_topup";

export interface LiquidityRecommendation {
  recommendationId: string;
  clusterId: string;
  memberLabel: string;
  actionType: MemberLiquidityActionType;
  triggerReason: string;
  suggestedAmountSats: number;
  projectedLocalPct: number;
  status: string;
  createdAt: number;
}

// ─── Per-cluster config ──────────────────────────────────────────────────────

interface ClusterConfig {
  treasuryPushTriggerPct: number;
  memberDepletedThresholdPct: number;
  minPushSats: number;
  maxPushSats: number;
  consecutiveRunsRequired: number;
  rejectionCooldownSec: number;
  activityWindowDays: number;
}

const DEFAULT_CONFIG: ClusterConfig = {
  treasuryPushTriggerPct: 0.85,
  memberDepletedThresholdPct: 0.25,
  minPushSats: 5_000,
  maxPushSats: 50_000,
  consecutiveRunsRequired: 2,
  rejectionCooldownSec: 86_400,
  activityWindowDays: 7,
};

function getClusterConfig(clusterId: string): ClusterConfig {
  const row = db
    .prepare("SELECT * FROM member_liquidity_config WHERE cluster_id = ?")
    .get(clusterId) as any | undefined;
  if (!row) return DEFAULT_CONFIG;
  return {
    treasuryPushTriggerPct: row.treasury_push_trigger_pct,
    memberDepletedThresholdPct: row.member_depleted_threshold_pct,
    minPushSats: row.min_push_sats,
    maxPushSats: row.max_push_sats,
    consecutiveRunsRequired: row.consecutive_runs_required,
    rejectionCooldownSec: row.rejection_cooldown_sec,
    activityWindowDays: row.activity_window_days,
  };
}

// ─── Consecutive run tracking (in-memory) ────────────────────────────────────

const consecutiveState = new Map<string, { count: number; actionType: MemberLiquidityActionType }>();

// ─── Guards ──────────────────────────────────────────────────────────────────

function hasPendingRecommendation(clusterId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM member_liquidity_recommendations
       WHERE cluster_id = ? AND status IN ('pending', 'executing')
       LIMIT 1`
    )
    .get(clusterId);
  return !!row;
}

function isInRejectionCooldown(clusterId: string, cooldownSec: number): boolean {
  const row = db
    .prepare(
      `SELECT rejected_at FROM member_liquidity_recommendations
       WHERE cluster_id = ? AND status = 'rejected'
       ORDER BY rejected_at DESC LIMIT 1`
    )
    .get(clusterId) as { rejected_at: number } | undefined;
  if (!row?.rejected_at) return false;
  return Date.now() - row.rejected_at < cooldownSec * 1000;
}

/** Check if there's been forwarding activity on the cluster's channels in the activity window. */
function hasRecentActivity(clusterId: string, windowDays: number): boolean {
  const channelIds = db
    .prepare(
      `SELECT cc.channel_id FROM rebalance_cluster_channels cc
       JOIN lnd_channels c ON cc.channel_id = c.channel_id
       WHERE cc.cluster_id = ? AND c.active = 1`
    )
    .all(clusterId) as Array<{ channel_id: string }>;

  if (channelIds.length === 0) return false;

  const since = Date.now() - windowDays * 86_400_000;
  const placeholders = channelIds.map(() => "?").join(",");
  const ids = channelIds.map((r) => r.channel_id);

  // Member's outgoing payments appear as forwards with incoming_channel = member channel
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM payments_forwarded
       WHERE incoming_channel IN (${placeholders}) AND created_at >= ?`
    )
    .get(...ids, since) as { cnt: number };

  return row.cnt > 0;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export function detectLiquidityOpportunities(
  clusterStates: ClusterState[]
): LiquidityRecommendation[] {
  const results: LiquidityRecommendation[] = [];
  const now = Date.now();

  // Only consider member clusters
  const memberClusters = clusterStates.filter(
    (s) =>
      s.policyRole === "member_primary_outbound" ||
      s.policyRole === "member_secondary_buffer"
  );

  for (const cs of memberClusters) {
    const cfg = getClusterConfig(cs.clusterId);
    const treasuryLocalPct = cs.localPct / 100; // ClusterState.localPct is 0-100
    const memberLocalPct = 1 - treasuryLocalPct; // member-local = 1 - treasury-local

    // Treasury Push trigger: treasury-local above trigger, member-local depleted
    if (
      treasuryLocalPct >= cfg.treasuryPushTriggerPct &&
      memberLocalPct <= cfg.memberDepletedThresholdPct
    ) {
      // Update consecutive count
      const prev = consecutiveState.get(cs.clusterId);
      if (prev?.actionType === "treasury_push_topup") {
        consecutiveState.set(cs.clusterId, {
          count: prev.count + 1,
          actionType: "treasury_push_topup",
        });
      } else {
        consecutiveState.set(cs.clusterId, { count: 1, actionType: "treasury_push_topup" });
      }

      const state = consecutiveState.get(cs.clusterId)!;

      if (state.count < cfg.consecutiveRunsRequired) {
        if (ENV.debug) {
          console.log(
            `[member-liquidity] ${cs.clusterId}: push candidate run ${state.count}/${cfg.consecutiveRunsRequired}`
          );
        }
        continue;
      }

      // Guards
      if (hasPendingRecommendation(cs.clusterId)) continue;
      if (isInRejectionCooldown(cs.clusterId, cfg.rejectionCooldownSec)) continue;
      if (!hasRecentActivity(cs.clusterId, cfg.activityWindowDays)) {
        if (ENV.debug) {
          console.log(
            `[member-liquidity] ${cs.clusterId}: suppressed — no activity in ${cfg.activityWindowDays} days`
          );
        }
        continue;
      }

      // Compute suggested amount: bring treasury-local back to target mid
      const targetMidFrac = cs.targetMidPct / 100;
      const excessSats = Math.round(
        (treasuryLocalPct - targetMidFrac) * cs.totalCapacitySats
      );
      const floorSats = Math.round((cs.floorPct / 100) * cs.totalCapacitySats);
      const availableAboveFloor = cs.localBalanceSats - floorSats;

      let suggestedAmount = Math.min(excessSats, cfg.maxPushSats, availableAboveFloor);
      if (suggestedAmount < cfg.minPushSats) {
        if (ENV.debug) {
          console.log(
            `[member-liquidity] ${cs.clusterId}: push too small (${suggestedAmount} < ${cfg.minPushSats})`
          );
        }
        continue;
      }

      // Project post-push treasury-local %
      const projectedLocal = cs.localBalanceSats - suggestedAmount;
      const projectedLocalPct =
        cs.totalCapacitySats > 0
          ? Math.round((projectedLocal / cs.totalCapacitySats) * 10000) / 100
          : 0;

      const recId = `rec_${cs.clusterId}_${now}`;
      const rec: LiquidityRecommendation = {
        recommendationId: recId,
        clusterId: cs.clusterId,
        memberLabel: cs.label,
        actionType: "treasury_push_topup",
        triggerReason: `treasury-local ${(treasuryLocalPct * 100).toFixed(1)}% >= ${(cfg.treasuryPushTriggerPct * 100).toFixed(0)}%, member-local ${(memberLocalPct * 100).toFixed(1)}% <= ${(cfg.memberDepletedThresholdPct * 100).toFixed(0)}%`,
        suggestedAmountSats: suggestedAmount,
        projectedLocalPct,
        status: "pending",
        createdAt: now,
      };

      // Persist
      db.prepare(
        `INSERT INTO member_liquidity_recommendations
           (recommendation_id, cluster_id, action_type, trigger_reason,
            suggested_amount_sats, projected_local_pct, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(recId, cs.clusterId, "treasury_push_topup", rec.triggerReason,
        suggestedAmount, projectedLocalPct, now, now);

      results.push(rec);

      // Reset consecutive counter after recommendation
      consecutiveState.delete(cs.clusterId);

      console.log(
        `[member-liquidity] recommended treasury push for ${cs.label}: ` +
        `${suggestedAmount.toLocaleString()} sats (treasury ${(treasuryLocalPct * 100).toFixed(1)}% → ${projectedLocalPct.toFixed(1)}%)`
      );
    } else {
      // Not triggered — reset consecutive state
      consecutiveState.delete(cs.clusterId);
    }
  }

  return results;
}
