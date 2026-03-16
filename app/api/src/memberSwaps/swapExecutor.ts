/**
 * Swap executor — executes an approved member swap via loopd.
 *
 * Top Up  = Loop Out through member channel (proven, built first)
 * Cash Out = Loop In with last_hop = member (deferred pending Loop In verification)
 *
 * Never auto-executes. Only called after explicit treasury approval.
 */

import { db } from "../db";
import { executeLoopOutSwap, listLoopSwaps } from "../lightning/loop";
import { createLndChainAddress } from "../lightning/lnd";
import { ENV } from "../config/env";
import type { SwapType } from "./swapDetector";
import type { SwapQuote } from "./swapAdvisor";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SwapOutcome {
  outcomeId: string;
  recommendationId: string;
  swapType: SwapType;
  clusterId: string;
  status: "success" | "failure" | "pending_onchain";
  actualAmountSats: number;
  actualFeeSats: number;
  loopSwapId: string;
  onchainTxid: string | null;
  failureReason: string | null;
  executedAt: number;
  settledAt: number | null;
}

// ─── DB lookups ──────────────────────────────────────────────────────────────

interface RecRow {
  recommendation_id: string;
  cluster_id: string;
  swap_type: string;
  suggested_amount_sats: number;
  status: string;
}

interface QuoteRow {
  quote_id: string;
  recommendation_id: string;
  amount_sats: number;
  total_estimated_fee_sats: number;
  estimated_swap_fee_sats: number;
  estimated_miner_fee_sats: number;
  estimated_prepay_fee_sats: number | null;
  quoted_at: number;
  quote_ttl_seconds: number;
}

function getRec(recId: string): RecRow | undefined {
  return db.prepare(
    `SELECT recommendation_id, cluster_id, swap_type, suggested_amount_sats, status
     FROM member_swap_recommendations WHERE recommendation_id = ?`
  ).get(recId) as RecRow | undefined;
}

function getQuote(quoteId: string): QuoteRow | undefined {
  return db.prepare(
    `SELECT * FROM member_swap_quotes WHERE quote_id = ?`
  ).get(quoteId) as QuoteRow | undefined;
}

/** Get the channel IDs (short format) for a cluster's active channels. */
function getClusterChannelIds(clusterId: string): string[] {
  const rows = db.prepare(
    `SELECT c.channel_id
     FROM rebalance_cluster_channels cc
     JOIN lnd_channels c ON cc.channel_id = c.channel_id
     WHERE cc.cluster_id = ? AND c.active = 1`
  ).all(clusterId) as Array<{ channel_id: string }>;
  return rows.map((r) => r.channel_id);
}

// ─── Execute ─────────────────────────────────────────────────────────────────

export async function executeSwap(
  recId: string,
  quoteId: string
): Promise<SwapOutcome> {
  const now = Date.now();
  const rec = getRec(recId);
  if (!rec) throw new Error(`Recommendation not found: ${recId}`);
  if (rec.status !== "pending") throw new Error(`Recommendation status is ${rec.status}, expected pending`);

  const quote = getQuote(quoteId);
  if (!quote) throw new Error(`Quote not found: ${quoteId}`);
  if (quote.recommendation_id !== recId) throw new Error("Quote does not match recommendation");

  // Check quote freshness
  const quoteAge = now - quote.quoted_at;
  if (quoteAge > quote.quote_ttl_seconds * 1000) {
    throw new Error(`Quote expired (${Math.round(quoteAge / 1000)}s old, TTL ${quote.quote_ttl_seconds}s)`);
  }

  const swapType = rec.swap_type as SwapType;
  const outcomeId = `outcome_${recId}_${now}`;

  // Mark recommendation as executing
  db.prepare(
    `UPDATE member_swap_recommendations SET status = 'executing', updated_at = ? WHERE recommendation_id = ?`
  ).run(now, recId);

  try {
    if (swapType === "top_up") {
      return await executeTopUp(rec, quote, outcomeId, now);
    } else {
      // Cash Out = Loop In — not yet verified
      throw new Error("Cash Out (Loop In) execution not yet implemented — pending Loop In verification");
    }
  } catch (err: any) {
    // Mark as failed
    db.prepare(
      `UPDATE member_swap_recommendations SET status = 'failed', updated_at = ? WHERE recommendation_id = ?`
    ).run(Date.now(), recId);

    const outcome: SwapOutcome = {
      outcomeId,
      recommendationId: recId,
      swapType,
      clusterId: rec.cluster_id,
      status: "failure",
      actualAmountSats: quote.amount_sats,
      actualFeeSats: 0,
      loopSwapId: "",
      onchainTxid: null,
      failureReason: err.message,
      executedAt: now,
      settledAt: null,
    };

    persistOutcome(outcome, quote.quote_id);
    return outcome;
  }
}

// ─── Top Up (Loop Out) ──────────────────────────────────────────────────────

async function executeTopUp(
  rec: RecRow,
  quote: QuoteRow,
  outcomeId: string,
  now: number
): Promise<SwapOutcome> {
  // Get member channel IDs for outgoing_chan_set
  const channelIds = getClusterChannelIds(rec.cluster_id);
  if (channelIds.length === 0) {
    throw new Error(`No active channels for cluster ${rec.cluster_id}`);
  }

  // Get fresh on-chain address for the sweep
  const { address } = await createLndChainAddress();

  // Execute Loop Out
  const result = await executeLoopOutSwap({
    amt: quote.amount_sats,
    dest: address,
    outgoing_chan_set: channelIds,
    max_swap_fee: quote.estimated_swap_fee_sats,
    max_miner_fee: quote.estimated_miner_fee_sats,
    max_prepay_amt: quote.estimated_prepay_fee_sats ?? 30_000,
    sweep_conf_target: ENV.loopConfTarget,
  });

  // Mark recommendation as complete (will settle async on-chain)
  db.prepare(
    `UPDATE member_swap_recommendations SET status = 'complete', updated_at = ? WHERE recommendation_id = ?`
  ).run(Date.now(), rec.recommendation_id);

  const outcome: SwapOutcome = {
    outcomeId,
    recommendationId: rec.recommendation_id,
    swapType: "top_up",
    clusterId: rec.cluster_id,
    status: "pending_onchain",
    actualAmountSats: quote.amount_sats,
    actualFeeSats: quote.total_estimated_fee_sats,
    loopSwapId: result.id,
    onchainTxid: null,
    failureReason: null,
    executedAt: now,
    settledAt: null,
  };

  persistOutcome(outcome, quote.quote_id);

  console.log(
    `[swap-executor] Top Up executed for cluster ${rec.cluster_id}: ` +
    `${quote.amount_sats.toLocaleString()} sats via Loop Out, swap ID ${result.id}`
  );

  return outcome;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function persistOutcome(outcome: SwapOutcome, quoteId: string): void {
  db.prepare(
    `INSERT INTO member_swap_outcomes
       (outcome_id, recommendation_id, quote_id, cluster_id, swap_type,
        status, actual_amount_sats, actual_fee_sats, loop_swap_id,
        onchain_txid, failure_reason, executed_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    outcome.outcomeId,
    outcome.recommendationId,
    quoteId,
    outcome.clusterId,
    outcome.swapType,
    outcome.status,
    outcome.actualAmountSats,
    outcome.actualFeeSats,
    outcome.loopSwapId,
    outcome.onchainTxid,
    outcome.failureReason,
    outcome.executedAt,
    outcome.settledAt
  );
}

// ─── Settlement poller ───────────────────────────────────────────────────────

/**
 * Check loopd for settled swaps and update outcomes.
 * Called periodically (e.g. every 60s) from the scheduler.
 */
export async function pollSwapSettlements(): Promise<void> {
  const pending = db.prepare(
    `SELECT outcome_id, loop_swap_id FROM member_swap_outcomes WHERE status = 'pending_onchain'`
  ).all() as Array<{ outcome_id: string; loop_swap_id: string }>;

  if (pending.length === 0) return;

  let swaps;
  try {
    swaps = await listLoopSwaps();
  } catch {
    return; // loopd unavailable, try next tick
  }

  const swapMap = new Map(swaps.map((s) => [s.id, s]));

  for (const p of pending) {
    const swap = swapMap.get(p.loop_swap_id);
    if (!swap) continue;

    if (swap.state === "SUCCESS") {
      const totalCost = swap.cost_server + swap.cost_onchain + swap.cost_offchain;
      db.prepare(
        `UPDATE member_swap_outcomes
         SET status = 'success', actual_fee_sats = ?, settled_at = ?
         WHERE outcome_id = ?`
      ).run(totalCost, Date.now(), p.outcome_id);

      console.log(`[swap-executor] swap ${p.loop_swap_id} settled, total cost ${totalCost} sats`);
    } else if (swap.state === "FAILED") {
      db.prepare(
        `UPDATE member_swap_outcomes
         SET status = 'failure', failure_reason = 'Loop swap failed', settled_at = ?
         WHERE outcome_id = ?`
      ).run(Date.now(), p.outcome_id);

      // Also update recommendation
      db.prepare(
        `UPDATE member_swap_recommendations SET status = 'failed', updated_at = ?
         WHERE recommendation_id = (
           SELECT recommendation_id FROM member_swap_outcomes WHERE outcome_id = ?
         )`
      ).run(Date.now(), p.outcome_id);
    }
  }
}
