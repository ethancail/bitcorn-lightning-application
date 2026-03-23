// ⚠️ DEPRECATED: Keysend push execution path.
// As of v1.7.0, the active liquidity execution path uses the swap subsystem
// (src/swaps/swapService.ts) instead of direct keysend push.
// This file is retained for reference but is no longer called from liquidityRoutes.ts.
// The approve handler now creates a liquidity_action + swap_request instead.

/**
 * Liquidity executor — executes an approved treasury push via keysend.
 *
 * Invoice path is preferred per spec but requires N2N infrastructure
 * that doesn't exist yet. Keysend is the v1 execution method.
 *
 * No on-chain settlement. No polling loop. Push completes synchronously.
 */

import { db } from "../db";
import { keysendPush } from "../lightning/lnd";
import type { MemberLiquidityActionType } from "./liquidityDetector";
import type { LiquidityEstimate } from "./liquidityAdvisor";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityOutcome {
  outcomeId: string;
  recommendationId: string;
  actionType: MemberLiquidityActionType;
  clusterId: string;
  status: "success" | "failure";
  actualAmountSats: number;
  actualFeeSats: number;
  paymentHash: string | null;
  executionMethod: "invoice" | "keysend";
  failureReason: string | null;
  executedAt: number;
}

// ─── DB lookups ──────────────────────────────────────────────────────────────

interface RecRow {
  recommendation_id: string;
  cluster_id: string;
  action_type: string;
  suggested_amount_sats: number;
  status: string;
}

interface EstimateRow {
  estimate_id: string;
  recommendation_id: string;
  amount_sats: number;
  estimated_at: number;
  estimate_ttl_seconds: number;
}

function getRec(recId: string): RecRow | undefined {
  return db
    .prepare(
      `SELECT recommendation_id, cluster_id, action_type, suggested_amount_sats, status
       FROM member_liquidity_recommendations WHERE recommendation_id = ?`
    )
    .get(recId) as RecRow | undefined;
}

function getEstimate(estimateId: string): EstimateRow | undefined {
  return db
    .prepare("SELECT * FROM member_liquidity_estimates WHERE estimate_id = ?")
    .get(estimateId) as EstimateRow | undefined;
}

function getClusterPeerPubkey(clusterId: string): string | null {
  const row = db
    .prepare("SELECT peer_pubkey FROM rebalance_clusters WHERE cluster_id = ?")
    .get(clusterId) as { peer_pubkey: string } | undefined;
  return row?.peer_pubkey ?? null;
}

/** Get the first active channel ID in the cluster (for outgoing_channel). */
function getClusterChannelId(clusterId: string): string | null {
  const row = db
    .prepare(
      `SELECT cc.channel_id FROM rebalance_cluster_channels cc
       JOIN lnd_channels c ON cc.channel_id = c.channel_id
       WHERE cc.cluster_id = ? AND c.active = 1
       LIMIT 1`
    )
    .get(clusterId) as { channel_id: string } | undefined;
  return row?.channel_id ?? null;
}

/** Check if peer has recent keysend failures (within 24h). */
function isPeerKeysendBlocked(peerPubkey: string): boolean {
  const row = db
    .prepare(
      `SELECT last_failed_at FROM member_keysend_status
       WHERE peer_pubkey = ? AND status = 'disabled'`
    )
    .get(peerPubkey) as { last_failed_at: number } | undefined;
  if (!row?.last_failed_at) return false;
  return Date.now() - row.last_failed_at < 24 * 3_600_000;
}

// ─── Execute ─────────────────────────────────────────────────────────────────

export async function executePush(
  recId: string,
  estimateId: string
): Promise<LiquidityOutcome> {
  const now = Date.now();
  const rec = getRec(recId);
  if (!rec) throw new Error(`Recommendation not found: ${recId}`);
  if (rec.status !== "pending") throw new Error(`Recommendation status is ${rec.status}, expected pending`);

  const estimate = getEstimate(estimateId);
  if (!estimate) throw new Error(`Estimate not found: ${estimateId}`);
  if (estimate.recommendation_id !== recId) throw new Error("Estimate does not match recommendation");

  // Check estimate freshness
  const estimateAge = now - estimate.estimated_at;
  if (estimateAge > estimate.estimate_ttl_seconds * 1000) {
    throw new Error(
      `Estimate expired (${Math.round(estimateAge / 1000)}s old, TTL ${estimate.estimate_ttl_seconds}s)`
    );
  }

  const peerPubkey = getClusterPeerPubkey(rec.cluster_id);
  if (!peerPubkey) throw new Error(`No peer pubkey for cluster ${rec.cluster_id}`);

  const channelId = getClusterChannelId(rec.cluster_id);
  if (!channelId) throw new Error(`No active channel for cluster ${rec.cluster_id}`);

  const outcomeId = `outcome_${recId}_${now}`;

  // Mark recommendation as executing
  db.prepare(
    `UPDATE member_liquidity_recommendations SET status = 'executing', updated_at = ? WHERE recommendation_id = ?`
  ).run(now, recId);

  try {
    // Check keysend capability
    if (isPeerKeysendBlocked(peerPubkey)) {
      throw new Error(`Peer ${peerPubkey.slice(0, 12)}... has recent keysend failures — push blocked`);
    }

    // Execute keysend push through the cluster's channel
    const result = await keysendPush({
      destination: peerPubkey,
      tokens: estimate.amount_sats,
      max_fee: 100, // max 100 sats routing fee for a direct peer push
      outgoing_channel: channelId,
    });

    // Mark recommendation as complete
    db.prepare(
      `UPDATE member_liquidity_recommendations SET status = 'complete', updated_at = ? WHERE recommendation_id = ?`
    ).run(Date.now(), recId);

    const outcome: LiquidityOutcome = {
      outcomeId,
      recommendationId: recId,
      actionType: "treasury_push_topup",
      clusterId: rec.cluster_id,
      status: "success",
      actualAmountSats: result.tokens,
      actualFeeSats: result.fee,
      paymentHash: result.id,
      executionMethod: "keysend",
      failureReason: null,
      executedAt: now,
    };

    persistOutcome(outcome);

    console.log(
      `[member-liquidity] push executed for ${rec.cluster_id}: ` +
      `${result.tokens.toLocaleString()} sats, fee ${result.fee} sats, hash ${result.id.slice(0, 16)}...`
    );

    return outcome;
  } catch (err: any) {
    // Mark as failed
    db.prepare(
      `UPDATE member_liquidity_recommendations SET status = 'failed', updated_at = ? WHERE recommendation_id = ?`
    ).run(Date.now(), recId);

    const outcome: LiquidityOutcome = {
      outcomeId,
      recommendationId: recId,
      actionType: "treasury_push_topup",
      clusterId: rec.cluster_id,
      status: "failure",
      actualAmountSats: estimate.amount_sats,
      actualFeeSats: 0,
      paymentHash: null,
      executionMethod: "keysend",
      failureReason: err.message,
      executedAt: now,
    };

    persistOutcome(outcome);
    return outcome;
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function persistOutcome(outcome: LiquidityOutcome): void {
  db.prepare(
    `INSERT INTO member_liquidity_outcomes
       (outcome_id, recommendation_id, cluster_id, action_type,
        status, actual_amount_sats, actual_fee_sats, payment_hash,
        execution_method, failure_reason, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    outcome.outcomeId,
    outcome.recommendationId,
    outcome.clusterId,
    outcome.actionType,
    outcome.status,
    outcome.actualAmountSats,
    outcome.actualFeeSats,
    outcome.paymentHash,
    outcome.executionMethod,
    outcome.failureReason,
    outcome.executedAt
  );
}
