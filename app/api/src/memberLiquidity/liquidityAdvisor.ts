/**
 * Liquidity advisor — computes push amount and projected channel state.
 *
 * No loopd calls. No on-chain fees. Just channel balance math and a
 * small routing fee estimate for the Lightning payment.
 */

import { db } from "../db";
import type { MemberLiquidityActionType } from "./liquidityDetector";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityEstimate {
  estimateId: string;
  recommendationId: string;
  amountSats: number;
  projectedTreasuryLocalPct: number;
  projectedMemberLocalPct: number;
  estimatedRoutingFeeSats: number;
  estimatedAt: number;
  estimateTtlSeconds: number;
}

// ─── DB lookups ──────────────────────────────────────────────────────────────

interface RecRow {
  recommendation_id: string;
  cluster_id: string;
  action_type: string;
  suggested_amount_sats: number;
  status: string;
}

function getRecommendation(recId: string): RecRow | undefined {
  return db
    .prepare(
      `SELECT recommendation_id, cluster_id, action_type, suggested_amount_sats, status
       FROM member_liquidity_recommendations WHERE recommendation_id = ?`
    )
    .get(recId) as RecRow | undefined;
}

interface ChannelTotals {
  totalCapacity: number;
  totalLocal: number;
  totalRemote: number;
}

function getClusterChannelTotals(clusterId: string): ChannelTotals {
  const row = db
    .prepare(
      `SELECT
         SUM(c.capacity_sat) as totalCapacity,
         SUM(c.local_balance_sat) as totalLocal,
         SUM(c.remote_balance_sat) as totalRemote
       FROM rebalance_cluster_channels cc
       JOIN lnd_channels c ON cc.channel_id = c.channel_id
       WHERE cc.cluster_id = ? AND c.active = 1`
    )
    .get(clusterId) as { totalCapacity: number; totalLocal: number; totalRemote: number } | undefined;

  return {
    totalCapacity: row?.totalCapacity ?? 0,
    totalLocal: row?.totalLocal ?? 0,
    totalRemote: row?.totalRemote ?? 0,
  };
}

interface ClusterConfig {
  minPushSats: number;
  maxPushSats: number;
}

function getClusterConfig(clusterId: string): ClusterConfig {
  const row = db
    .prepare("SELECT min_push_sats, max_push_sats FROM member_liquidity_config WHERE cluster_id = ?")
    .get(clusterId) as { min_push_sats: number; max_push_sats: number } | undefined;
  return {
    minPushSats: row?.min_push_sats ?? 5_000,
    maxPushSats: row?.max_push_sats ?? 50_000,
  };
}

function getClusterFloor(clusterId: string): number {
  const row = db
    .prepare("SELECT floor_pct FROM rebalance_clusters WHERE cluster_id = ?")
    .get(clusterId) as { floor_pct: number } | undefined;
  return row?.floor_pct ?? 20;
}

// ─── Estimate ────────────────────────────────────────────────────────────────

const ESTIMATE_TTL_SECONDS = 60;

export async function estimatePush(recId: string): Promise<LiquidityEstimate> {
  const rec = getRecommendation(recId);
  if (!rec) throw new Error(`Recommendation not found: ${recId}`);
  if (rec.status !== "pending") throw new Error(`Recommendation status is ${rec.status}, expected pending`);

  const now = Date.now();
  const estimateId = `est_${recId}_${now}`;
  const cfg = getClusterConfig(rec.cluster_id);
  const totals = getClusterChannelTotals(rec.cluster_id);
  const floorPct = getClusterFloor(rec.cluster_id);

  // Re-validate amount against current channel state
  let amount = rec.suggested_amount_sats;

  // Cap at max_push_sats
  amount = Math.min(amount, cfg.maxPushSats);

  // Cap so treasury-local doesn't go below floor
  const floorSats = Math.round((floorPct / 100) * totals.totalCapacity);
  const availableAboveFloor = totals.totalLocal - floorSats;
  amount = Math.min(amount, Math.max(0, availableAboveFloor));

  // Minimum check
  if (amount < cfg.minPushSats) {
    throw new Error(
      `Push amount too small: ${amount} sats (min ${cfg.minPushSats}). ` +
      `Treasury local ${totals.totalLocal}, floor ${floorSats}`
    );
  }

  // Project post-push balances
  // Treasury push: treasury-local decreases, member-local (remote) increases
  const projectedTreasuryLocal = totals.totalLocal - amount;
  const projectedMemberLocal = totals.totalRemote + amount;
  const projectedTreasuryLocalPct =
    totals.totalCapacity > 0
      ? Math.round((projectedTreasuryLocal / totals.totalCapacity) * 10000) / 100
      : 0;
  const projectedMemberLocalPct =
    totals.totalCapacity > 0
      ? Math.round((projectedMemberLocal / totals.totalCapacity) * 10000) / 100
      : 0;

  // Routing fee estimate: direct peer = 0 or near-0 (base fee only)
  // For a direct channel push, the fee is typically 0 (no hops between treasury and member).
  const estimatedRoutingFeeSats = 0;

  const estimate: LiquidityEstimate = {
    estimateId,
    recommendationId: recId,
    amountSats: amount,
    projectedTreasuryLocalPct,
    projectedMemberLocalPct,
    estimatedRoutingFeeSats,
    estimatedAt: now,
    estimateTtlSeconds: ESTIMATE_TTL_SECONDS,
  };

  // Persist estimate
  db.prepare(
    `INSERT INTO member_liquidity_estimates
       (estimate_id, recommendation_id, amount_sats,
        projected_treasury_local_pct, projected_member_local_pct,
        estimated_routing_fee_sats, estimated_at, estimate_ttl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    estimate.estimateId,
    estimate.recommendationId,
    estimate.amountSats,
    estimate.projectedTreasuryLocalPct,
    estimate.projectedMemberLocalPct,
    estimate.estimatedRoutingFeeSats,
    estimate.estimatedAt,
    estimate.estimateTtlSeconds
  );

  return estimate;
}
