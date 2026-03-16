/**
 * Member liquidity API route handlers.
 * All endpoints are treasury-only.
 */

import { db } from "../db";
import { estimatePush } from "./liquidityAdvisor";
import { executePush } from "./liquidityExecutor";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RecRow {
  recommendation_id: string;
  cluster_id: string;
  action_type: string;
  trigger_reason: string;
  suggested_amount_sats: number;
  projected_local_pct: number | null;
  status: string;
  rejected_at: number | null;
  created_at: number;
  updated_at: number;
}

interface OutcomeRow {
  outcome_id: string;
  recommendation_id: string;
  cluster_id: string;
  action_type: string;
  status: string;
  actual_amount_sats: number | null;
  actual_fee_sats: number | null;
  payment_hash: string | null;
  execution_method: string | null;
  failure_reason: string | null;
  executed_at: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRec(r: RecRow) {
  return {
    recommendationId: r.recommendation_id,
    clusterId: r.cluster_id,
    actionType: r.action_type,
    triggerReason: r.trigger_reason,
    suggestedAmountSats: r.suggested_amount_sats,
    projectedLocalPct: r.projected_local_pct,
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
    clusterId: o.cluster_id,
    actionType: o.action_type,
    status: o.status,
    actualAmountSats: o.actual_amount_sats,
    actualFeeSats: o.actual_fee_sats,
    paymentHash: o.payment_hash,
    executionMethod: o.execution_method,
    failureReason: o.failure_reason,
    executedAt: o.executed_at,
  };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/** GET /api/member-liquidity/recommendations */
export function getRecommendations() {
  const rows = db
    .prepare(
      `SELECT * FROM member_liquidity_recommendations
       WHERE status IN ('pending', 'executing')
       ORDER BY created_at DESC`
    )
    .all() as RecRow[];
  return { recommendations: rows.map(formatRec) };
}

/** GET /api/member-liquidity/recommendations/:id/estimate */
export async function getEstimateForRecommendation(recId: string) {
  const estimate = await estimatePush(recId);
  return { estimate };
}

/** POST /api/member-liquidity/recommendations/:id/approve */
export async function approveRecommendation(recId: string, body: { estimateId: string }) {
  if (!body.estimateId) throw new Error("estimateId is required");
  const outcome = await executePush(recId, body.estimateId);
  return { outcome };
}

/** POST /api/member-liquidity/recommendations/:id/reject */
export function rejectRecommendation(recId: string) {
  const now = Date.now();
  const rec = db
    .prepare(
      `SELECT recommendation_id, status FROM member_liquidity_recommendations WHERE recommendation_id = ?`
    )
    .get(recId) as { recommendation_id: string; status: string } | undefined;

  if (!rec) throw new Error(`Recommendation not found: ${recId}`);
  if (rec.status !== "pending") throw new Error(`Cannot reject: status is ${rec.status}`);

  db.prepare(
    `UPDATE member_liquidity_recommendations
     SET status = 'rejected', rejected_at = ?, updated_at = ?
     WHERE recommendation_id = ?`
  ).run(now, now, recId);

  return { ok: true };
}

/** GET /api/member-liquidity/outcomes */
export function getOutcomes(query: {
  clusterId?: string;
  status?: string;
  limit?: number;
}) {
  let sql = `SELECT * FROM member_liquidity_outcomes WHERE 1=1`;
  const params: any[] = [];

  if (query.clusterId) {
    sql += ` AND cluster_id = ?`;
    params.push(query.clusterId);
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

/** GET /api/member-liquidity/outcomes/:id */
export function getOutcomeById(outcomeId: string) {
  const row = db
    .prepare("SELECT * FROM member_liquidity_outcomes WHERE outcome_id = ?")
    .get(outcomeId) as OutcomeRow | undefined;

  if (!row) throw new Error(`Outcome not found: ${outcomeId}`);
  return { outcome: formatOutcome(row) };
}
