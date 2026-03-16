/**
 * Swap advisor — prices a recommendation using loopd quotes.
 *
 * Top Up  = Loop Out (proven) → uses getLoopOutQuote
 * Cash Out = Loop In (pending verification) → stub until verified
 */

import { db } from "../db";
import { getLoopOutQuote } from "../lightning/loop";
import type { SwapType } from "./swapDetector";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SwapQuote {
  quoteId: string;
  recommendationId: string;
  swapType: SwapType;
  amountSats: number;
  estimatedSwapFeeSats: number;
  estimatedMinerFeeSats: number;
  estimatedPrepayFeeSats: number | null;
  totalEstimatedFeeSats: number;
  feeAsPct: number;
  projectedLocalPct: number;
  projectedRemotePct: number;
  withinFeeTolerance: boolean;
  quotedAt: number;
  quoteTtlSeconds: number;
}

// ─── Config lookup ───────────────────────────────────────────────────────────

function getMaxFeeTolerance(clusterId: string): number {
  const row = db.prepare(
    `SELECT max_fee_tolerance_pct FROM member_swap_config WHERE cluster_id = ?`
  ).get(clusterId) as { max_fee_tolerance_pct: number } | undefined;
  return row?.max_fee_tolerance_pct ?? 0.02;
}

// ─── Recommendation lookup ───────────────────────────────────────────────────

interface RecRow {
  recommendation_id: string;
  cluster_id: string;
  swap_type: string;
  suggested_amount_sats: number;
  status: string;
}

function getRecommendation(recId: string): RecRow | undefined {
  return db.prepare(
    `SELECT recommendation_id, cluster_id, swap_type, suggested_amount_sats, status
     FROM member_swap_recommendations WHERE recommendation_id = ?`
  ).get(recId) as RecRow | undefined;
}

// ─── Channel state for projection ───────────────────────────────────────────

interface ChannelTotals {
  totalCapacity: number;
  totalLocal: number;
  totalRemote: number;
}

function getClusterChannelTotals(clusterId: string): ChannelTotals {
  const row = db.prepare(
    `SELECT
       SUM(c.capacity_sat) as totalCapacity,
       SUM(c.local_balance_sat) as totalLocal,
       SUM(c.remote_balance_sat) as totalRemote
     FROM rebalance_cluster_channels cc
     JOIN lnd_channels c ON cc.channel_id = c.channel_id
     WHERE cc.cluster_id = ? AND c.active = 1`
  ).get(clusterId) as { totalCapacity: number; totalLocal: number; totalRemote: number } | undefined;

  return {
    totalCapacity: row?.totalCapacity ?? 0,
    totalLocal: row?.totalLocal ?? 0,
    totalRemote: row?.totalRemote ?? 0,
  };
}

// ─── Quote ───────────────────────────────────────────────────────────────────

const QUOTE_TTL_SECONDS = 30;

export async function quoteSwap(recId: string): Promise<SwapQuote> {
  const rec = getRecommendation(recId);
  if (!rec) throw new Error(`Recommendation not found: ${recId}`);
  if (rec.status !== "pending") throw new Error(`Recommendation status is ${rec.status}, expected pending`);

  const swapType = rec.swap_type as SwapType;
  const amount = rec.suggested_amount_sats;
  const now = Date.now();
  const quoteId = `quote_${recId}_${now}`;

  let estimatedSwapFee: number;
  let estimatedMinerFee: number;
  let estimatedPrepayFee: number | null;

  if (swapType === "top_up") {
    // Top Up = Loop Out (proven)
    const quote = await getLoopOutQuote(amount);
    estimatedSwapFee = quote.swap_fee_sat;
    estimatedMinerFee = quote.miner_fee;
    estimatedPrepayFee = quote.prepay_amt_sat;
  } else {
    // Cash Out = Loop In (not yet verified)
    // Stub: estimate based on Loop Out fees as rough proxy
    throw new Error("Cash Out (Loop In) not yet verified — quote unavailable");
  }

  const totalFee = estimatedSwapFee + estimatedMinerFee + (estimatedPrepayFee ?? 0);
  const feeAsPct = amount > 0 ? totalFee / amount : 0;

  // Project post-swap balances
  const totals = getClusterChannelTotals(rec.cluster_id);
  let projectedLocal: number;
  let projectedRemote: number;

  if (swapType === "top_up") {
    // Loop Out: treasury-local decreases, member-local (remote) increases
    projectedLocal = totals.totalLocal - amount;
    projectedRemote = totals.totalRemote + amount;
  } else {
    // Loop In: treasury-local increases, member-local (remote) decreases
    projectedLocal = totals.totalLocal + amount;
    projectedRemote = totals.totalRemote - amount;
  }

  const projectedLocalPct = totals.totalCapacity > 0
    ? Math.round((projectedLocal / totals.totalCapacity) * 10000) / 100
    : 0;
  const projectedRemotePct = totals.totalCapacity > 0
    ? Math.round((projectedRemote / totals.totalCapacity) * 10000) / 100
    : 0;

  const maxFeeTolerance = getMaxFeeTolerance(rec.cluster_id);
  const withinFeeTolerance = feeAsPct <= maxFeeTolerance;

  const quote: SwapQuote = {
    quoteId,
    recommendationId: recId,
    swapType,
    amountSats: amount,
    estimatedSwapFeeSats: estimatedSwapFee,
    estimatedMinerFeeSats: estimatedMinerFee,
    estimatedPrepayFeeSats: estimatedPrepayFee,
    totalEstimatedFeeSats: totalFee,
    feeAsPct: Math.round(feeAsPct * 10000) / 10000,
    projectedLocalPct,
    projectedRemotePct,
    withinFeeTolerance,
    quotedAt: now,
    quoteTtlSeconds: QUOTE_TTL_SECONDS,
  };

  // Persist quote
  db.prepare(
    `INSERT INTO member_swap_quotes
       (quote_id, recommendation_id, amount_sats, estimated_swap_fee_sats,
        estimated_miner_fee_sats, estimated_prepay_fee_sats,
        total_estimated_fee_sats, fee_as_pct, projected_local_pct,
        projected_remote_pct, within_fee_tolerance, quoted_at, quote_ttl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    quote.quoteId,
    quote.recommendationId,
    quote.amountSats,
    quote.estimatedSwapFeeSats,
    quote.estimatedMinerFeeSats,
    quote.estimatedPrepayFeeSats,
    quote.totalEstimatedFeeSats,
    quote.feeAsPct,
    quote.projectedLocalPct,
    quote.projectedRemotePct,
    quote.withinFeeTolerance ? 1 : 0,
    quote.quotedAt,
    quote.quoteTtlSeconds
  );

  // Update recommendation with fee estimate
  db.prepare(
    `UPDATE member_swap_recommendations
     SET estimated_fee_sats = ?, updated_at = ?
     WHERE recommendation_id = ?`
  ).run(quote.totalEstimatedFeeSats, now, recId);

  return quote;
}
