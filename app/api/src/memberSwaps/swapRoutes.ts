/**
 * Member swap API route handlers.
 * All endpoints are treasury-only.
 */

import { db } from "../db";
import { quoteSwap } from "./swapAdvisor";
import { executeSwap, pollSwapSettlements } from "./swapExecutor";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RecRow {
  recommendation_id: string;
  cluster_id: string;
  swap_type: string;
  trigger_reason: string;
  suggested_amount_sats: number;
  estimated_fee_sats: number | null;
  post_swap_local_pct: number | null;
  status: string;
  rejection_cooldown_sec: number;
  rejected_at: number | null;
  created_at: number;
  updated_at: number;
}

interface OutcomeRow {
  outcome_id: string;
  recommendation_id: string;
  quote_id: string;
  cluster_id: string;
  swap_type: string;
  status: string;
  actual_amount_sats: number | null;
  actual_fee_sats: number | null;
  loop_swap_id: string | null;
  onchain_txid: string | null;
  failure_reason: string | null;
  executed_at: number;
  settled_at: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRec(r: RecRow) {
  return {
    recommendationId: r.recommendation_id,
    clusterId: r.cluster_id,
    swapType: r.swap_type,
    triggerReason: r.trigger_reason,
    suggestedAmountSats: r.suggested_amount_sats,
    estimatedFeeSats: r.estimated_fee_sats,
    postSwapLocalPct: r.post_swap_local_pct,
    status: r.status,
    rejectedAt: r.rejected_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function formatOutcome(o: OutcomeRow) {
  return {
    outcomeId: o.outcome_id,
    recommendationId: o.recommendation_id,
    quoteId: o.quote_id,
    clusterId: o.cluster_id,
    swapType: o.swap_type,
    status: o.status,
    actualAmountSats: o.actual_amount_sats,
    actualFeeSats: o.actual_fee_sats,
    loopSwapId: o.loop_swap_id,
    onchainTxid: o.onchain_txid,
    failureReason: o.failure_reason,
    executedAt: o.executed_at,
    settledAt: o.settled_at,
  };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/** GET /api/member-swaps/recommendations */
export function getRecommendations() {
  const rows = db.prepare(
    `SELECT * FROM member_swap_recommendations
     WHERE status IN ('pending', 'executing')
     ORDER BY created_at DESC`
  ).all() as RecRow[];
  return { recommendations: rows.map(formatRec) };
}

/** GET /api/member-swaps/recommendations/:id/quote */
export async function getQuoteForRecommendation(recId: string) {
  const quote = await quoteSwap(recId);
  return { quote };
}

/** POST /api/member-swaps/recommendations/:id/approve */
export async function approveRecommendation(recId: string, body: { quoteId: string }) {
  if (!body.quoteId) throw new Error("quoteId is required");
  const outcome = await executeSwap(recId, body.quoteId);
  return { outcome };
}

/** POST /api/member-swaps/recommendations/:id/reject */
export function rejectRecommendation(recId: string) {
  const now = Date.now();
  const rec = db.prepare(
    `SELECT recommendation_id, status FROM member_swap_recommendations WHERE recommendation_id = ?`
  ).get(recId) as { recommendation_id: string; status: string } | undefined;

  if (!rec) throw new Error(`Recommendation not found: ${recId}`);
  if (rec.status !== "pending") throw new Error(`Cannot reject: status is ${rec.status}`);

  db.prepare(
    `UPDATE member_swap_recommendations
     SET status = 'rejected', rejected_at = ?, updated_at = ?
     WHERE recommendation_id = ?`
  ).run(now, now, recId);

  return { ok: true };
}

/** GET /api/member-swaps/outcomes */
export function getOutcomes(query: {
  clusterId?: string;
  swapType?: string;
  status?: string;
  limit?: number;
}) {
  let sql = `SELECT * FROM member_swap_outcomes WHERE 1=1`;
  const params: any[] = [];

  if (query.clusterId) {
    sql += ` AND cluster_id = ?`;
    params.push(query.clusterId);
  }
  if (query.swapType) {
    sql += ` AND swap_type = ?`;
    params.push(query.swapType);
  }
  if (query.status) {
    sql += ` AND status = ?`;
    params.push(query.status);
  }

  sql += ` ORDER BY executed_at DESC LIMIT ?`;
  params.push(query.limit ?? 50);

  const rows = db.prepare(sql).all(...params) as OutcomeRow[];
  return { outcomes: rows.map(formatOutcome) };
}

/** GET /api/member-swaps/outcomes/:id */
export function getOutcomeById(outcomeId: string) {
  const row = db.prepare(
    `SELECT * FROM member_swap_outcomes WHERE outcome_id = ?`
  ).get(outcomeId) as OutcomeRow | undefined;

  if (!row) throw new Error(`Outcome not found: ${outcomeId}`);
  return { outcome: formatOutcome(row) };
}

/** Polling for pending swap settlements — call periodically. */
export { pollSwapSettlements };
