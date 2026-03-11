import { db } from "../db";
import {
  getLndIdentity,
  getLndRouteToDestination,
  createLndInvoice,
  payLndViaRoutes,
} from "../lightning/lnd";
import type { ClusterState } from "./clusterState";
import type { RebalanceCandidate } from "./cycleEnumerator";
import { reprobeIfStale } from "./cycleEnumerator";

// ─── Types ───────────────────────────────────────────────────────────────────

export type OutcomeStatus = "success" | "failure" | "partial";

export interface RebalanceOutcome {
  outcomeId: string;
  candidateId: string;
  runId: string;
  outcomeStatus: OutcomeStatus;
  actualAmountSats: number | null;
  actualFeeSats: number | null;
  durationMs: number;
  failureReason: string | null;
  executedAt: number;
}

// ─── Execute one candidate ──────────────────────────────────────────────────

export async function executeCandidate(
  candidate: RebalanceCandidate,
  clusterMap: Map<string, ClusterState>
): Promise<RebalanceOutcome> {
  const startMs = Date.now();
  const outcomeId = `out_${candidate.candidateId}`;
  const dest = clusterMap.get(candidate.destClusterId);

  // Re-probe if route is stale
  if (dest) {
    candidate = await reprobeIfStale(candidate, dest.peerPubkey);
  }

  // If re-probe failed, candidate is no longer executable
  if (candidate.candidateStatus !== "executable") {
    return recordOutcome({
      outcomeId,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      outcomeStatus: "failure",
      actualAmountSats: null,
      actualFeeSats: null,
      durationMs: Date.now() - startMs,
      failureReason: "reprobe_failed",
      executedAt: Date.now(),
    });
  }

  try {
    const identity = await getLndIdentity();
    const selfPubkey = identity.public_key;
    if (!selfPubkey) {
      return recordOutcome({
        outcomeId,
        candidateId: candidate.candidateId,
        runId: candidate.runId,
        outcomeStatus: "failure",
        actualAmountSats: null,
        actualFeeSats: null,
        durationMs: Date.now() - startMs,
        failureReason: "no_identity",
        executedAt: Date.now(),
      });
    }

    // Create a self-paying invoice for the rebalance amount
    const invoice = await createLndInvoice(
      candidate.amountSats,
      `rebalance:${candidate.candidateId}`
    );

    // Get the exact route (outgoing through source, incoming through dest peer)
    const maxFeeSats = Math.max(1, Math.ceil(candidate.amountSats * 0.01));
    const { route } = await getLndRouteToDestination({
      destination: selfPubkey,
      tokens: candidate.amountSats,
      outgoing_channel: candidate.sourceChannelId,
      incoming_peer: dest!.peerPubkey,
      max_fee: maxFeeSats,
      payment: invoice.payment,
      total_mtokens: invoice.mtokens,
    });

    // Execute the payment along the probed route
    const result = await payLndViaRoutes(invoice.id, [route]);

    const durationMs = Date.now() - startMs;

    // Mark candidate as executed
    db.prepare("UPDATE rebalance_candidates SET candidate_status = 'executed' WHERE candidate_id = ?")
      .run(candidate.candidateId);

    const outcome = recordOutcome({
      outcomeId,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      outcomeStatus: result.is_confirmed ? "success" : "partial",
      actualAmountSats: result.tokens,
      actualFeeSats: result.fee,
      durationMs,
      failureReason: null,
      executedAt: Date.now(),
    });

    // Update pair history with success
    updatePairHistory(
      candidate.sourceClusterId,
      candidate.destClusterId,
      "success",
      result.tokens,
      result.fee,
      null
    );

    // Record rebalance cost in the treasury ledger
    if (result.fee > 0) {
      recordRebalanceCost(candidate, result.fee);
    }

    // Update cluster last_rebalanced_at
    const now = Date.now();
    db.prepare("UPDATE rebalance_clusters SET last_rebalanced_at = ?, updated_at = ? WHERE cluster_id = ?")
      .run(now, now, candidate.sourceClusterId);
    db.prepare("UPDATE rebalance_clusters SET last_rebalanced_at = ?, updated_at = ? WHERE cluster_id = ?")
      .run(now, now, candidate.destClusterId);

    return outcome;
  } catch (err: any) {
    const durationMs = Date.now() - startMs;
    const failureReason = err?.message ?? "unknown_error";

    const outcome = recordOutcome({
      outcomeId,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      outcomeStatus: "failure",
      actualAmountSats: null,
      actualFeeSats: null,
      durationMs,
      failureReason,
      executedAt: Date.now(),
    });

    // Update pair history with failure
    updatePairHistory(
      candidate.sourceClusterId,
      candidate.destClusterId,
      "failure",
      null,
      null,
      failureReason
    );

    return outcome;
  }
}

// ─── Persist outcome to DB ──────────────────────────────────────────────────

function recordOutcome(o: RebalanceOutcome): RebalanceOutcome {
  db.prepare(
    `INSERT INTO rebalance_outcomes
       (outcome_id, candidate_id, run_id, status, actual_amount_sats,
        actual_fee_sats, duration_ms, failure_reason, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.outcomeId,
    o.candidateId,
    o.runId,
    o.outcomeStatus,
    o.actualAmountSats,
    o.actualFeeSats,
    o.durationMs,
    o.failureReason,
    o.executedAt
  );
  return o;
}

// ─── Update rolling pair history ────────────────────────────────────────────

function updatePairHistory(
  sourceClusterId: string,
  destClusterId: string,
  result: "success" | "failure",
  amountSats: number | null,
  feeSats: number | null,
  failureReason: string | null
): void {
  const pairId = `${sourceClusterId}:${destClusterId}`;
  const now = Date.now();

  const existing = db
    .prepare("SELECT * FROM rebalance_pair_history WHERE pair_id = ?")
    .get(pairId) as any | undefined;

  if (!existing) {
    // Insert new row
    db.prepare(
      `INSERT INTO rebalance_pair_history
         (pair_id, source_cluster_id, dest_cluster_id, attempt_count,
          success_count, failure_count, probe_failure_count, execution_failure_count,
          success_p50_sats, success_p75_sats, avg_success_fee_sats,
          last_failure_reason, last_probe_at, last_probe_success_at,
          last_attempt_at, last_success_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    ).run(
      pairId,
      sourceClusterId,
      destClusterId,
      result === "success" ? 1 : 0,
      result === "failure" ? 1 : 0,
      result === "failure" ? 1 : 0,
      result === "success" ? amountSats : null,
      result === "success" ? amountSats : null,
      result === "success" ? feeSats : null,
      result === "failure" ? failureReason : null,
      now,
      result === "success" ? now : null,
      now
    );
    return;
  }

  if (result === "success" && amountSats !== null) {
    // Simple rolling update: blend new amount into p50/p75
    // p50 moves slowly toward new value, p75 moves toward the larger of old/new
    const oldP50 = existing.success_p50_sats ?? amountSats;
    const oldP75 = existing.success_p75_sats ?? amountSats;
    const oldAvgFee = existing.avg_success_fee_sats ?? (feeSats ?? 0);

    const newP50 = Math.round(oldP50 * 0.7 + amountSats * 0.3);
    const newP75 = Math.round(oldP75 * 0.7 + Math.max(oldP75, amountSats) * 0.3);
    const newAvgFee = Math.round(oldAvgFee * 0.7 + (feeSats ?? 0) * 0.3);

    db.prepare(
      `UPDATE rebalance_pair_history
       SET attempt_count = attempt_count + 1,
           success_count = success_count + 1,
           success_p50_sats = ?,
           success_p75_sats = ?,
           avg_success_fee_sats = ?,
           last_attempt_at = ?,
           last_success_at = ?,
           updated_at = ?
       WHERE pair_id = ?`
    ).run(newP50, newP75, newAvgFee, now, now, now, pairId);
  } else {
    db.prepare(
      `UPDATE rebalance_pair_history
       SET attempt_count = attempt_count + 1,
           failure_count = failure_count + 1,
           execution_failure_count = execution_failure_count + 1,
           last_failure_reason = ?,
           last_attempt_at = ?,
           updated_at = ?
       WHERE pair_id = ?`
    ).run(failureReason, now, now, pairId);
  }
}

// ─── Record cost in treasury rebalance ledger ───────────────────────────────

function recordRebalanceCost(candidate: RebalanceCandidate, feeSats: number): void {
  db.prepare(
    `INSERT INTO treasury_rebalance_costs
       (type, tokens, fee_paid_sats, related_channel, created_at)
     VALUES ('circular', ?, ?, ?, ?)`
  ).run(candidate.amountSats, feeSats, candidate.sourceChannelId, Date.now());
}
