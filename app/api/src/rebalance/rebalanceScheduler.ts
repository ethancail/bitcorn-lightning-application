/**
 * Cluster-based rebalance engine scheduler (v1).
 *
 * Runs every 15 minutes (configurable) on the treasury node.
 * Each tick:
 *   1. Read all cluster states (live balances, flow profiles, deviation)
 *   2. Apply fee steering adjustments (passive lever)
 *   3. Select candidate source→dest pairs
 *   4. Enumerate and probe circular rebalance candidates
 *   5. Score candidates and pick the best (or no_action)
 *   6. Execute the winning candidate (active lever)
 *   7. Analyze topology for structural recommendations
 *   8. Take inventory snapshot
 *   9. Record the run
 */

import { ENV } from "../config/env";
import { db } from "../db";
import { getNodeInfo } from "../api/read";
import { getAllClusterStates } from "./clusterState";
import { applyAllFeeSteeringIfDue } from "./feeSteering";
import { selectCandidatePairs } from "./pairSelector";
import { enumerateCandidates } from "./cycleEnumerator";
import { scoreCandidates } from "./cycleScorer";
import { executeCandidate } from "./rebalanceExecutor";
import { analyzeTopology, takeInventorySnapshot } from "./topologyMonitor";
import type { ClusterState } from "./clusterState";

// ─── State ──────────────────────────────────────────────────────────────────

let running = false;
let runSeq = 0;

// ─── Single run ─────────────────────────────────────────────────────────────

async function runOnce(): Promise<void> {
  if (running) return;

  try {
    running = true;
    runSeq++;

    // Only run on treasury node
    const node = getNodeInfo();
    if (node?.node_role !== "treasury") return;

    const runId = `run_${Date.now()}_${runSeq}`;
    const startedAt = Date.now();

    // Insert run record as "running"
    db.prepare(
      `INSERT INTO rebalance_runs
         (run_id, started_at, clusters_evaluated, fee_adjustments_made,
          candidates_evaluated, rebalance_executed, status)
       VALUES (?, ?, 0, 0, 0, 0, 'running')`
    ).run(runId, startedAt);

    try {
      // Step 1: Read all cluster states
      const states = getAllClusterStates();
      const clusterMap = new Map<string, ClusterState>();
      for (const s of states) clusterMap.set(s.clusterId, s);

      if (states.length === 0) {
        completeRun(runId, 0, 0, 0, false, null);
        return;
      }

      // Step 2: Fee steering (passive lever)
      const feeAdjustments = await applyAllFeeSteeringIfDue(states);

      if (ENV.debug && feeAdjustments.length > 0) {
        console.log(
          `[cluster-rebalance] fee adjustments:`,
          feeAdjustments.map((a) => ({
            cluster: a.clusterId,
            old: a.oldFeePpm,
            new: a.newFeePpm,
            reason: a.reason,
          }))
        );
      }

      // Step 3: Select candidate pairs
      const pairs = selectCandidatePairs(states);

      // Step 4: Enumerate and probe candidates
      const candidates = await enumerateCandidates(pairs, runId);

      if (ENV.debug) {
        const executable = candidates.filter((c) => c.candidateStatus === "executable");
        console.log(
          `[cluster-rebalance] ${candidates.length} candidates (${executable.length} executable) from ${pairs.length} pairs`
        );
      }

      // Step 5: Score and pick best candidate
      const scorerResult = scoreCandidates(candidates, clusterMap);
      let rebalanceExecuted = false;
      let topoRec: string | null = null;

      if (scorerResult.action === "execute" && scorerResult.candidate) {
        // Step 6: Execute
        if (ENV.debug) {
          console.log(`[cluster-rebalance] executing candidate:`, {
            id: scorerResult.candidate.candidateId,
            source: scorerResult.candidate.sourceClusterId,
            dest: scorerResult.candidate.destClusterId,
            amount: scorerResult.candidate.amountSats,
            fee: scorerResult.candidate.estimatedFeeSats,
            score: scorerResult.score,
          });
        }

        const outcome = await executeCandidate(scorerResult.candidate, clusterMap);
        rebalanceExecuted = outcome.outcomeStatus === "success";

        if (ENV.debug) {
          console.log(`[cluster-rebalance] outcome: ${outcome.outcomeStatus}`, {
            amount: outcome.actualAmountSats,
            fee: outcome.actualFeeSats,
            duration: outcome.durationMs,
            reason: outcome.failureReason,
          });
        }
      } else if (ENV.debug) {
        console.log(`[cluster-rebalance] no_action: ${scorerResult.reason}`);
      }

      // Step 7: Topology analysis
      const recommendations = analyzeTopology(states, runId, rebalanceExecuted);
      if (recommendations.length > 0) {
        topoRec = recommendations.map((r) => r.recommendationType).join(",");
      }

      if (ENV.debug && recommendations.length > 0) {
        for (const rec of recommendations) {
          if (rec.recommendationType !== "no_action") {
            console.log(`[cluster-rebalance] topology: ${rec.reason}`);
          }
        }
      }

      // Step 8: Inventory snapshot
      takeInventorySnapshot(states, runId);

      // Step 9: Complete run record
      completeRun(
        runId,
        states.length,
        feeAdjustments.length,
        candidates.length,
        rebalanceExecuted,
        topoRec
      );
    } catch (err: any) {
      // Mark run as error
      db.prepare(
        `UPDATE rebalance_runs
         SET status = 'error', completed_at = ?
         WHERE run_id = ?`
      ).run(Date.now(), runId);

      console.error(`[cluster-rebalance] run ${runId} failed:`, err?.message);
    }
  } finally {
    running = false;
  }
}

// ─── Complete run record ────────────────────────────────────────────────────

function completeRun(
  runId: string,
  clustersEvaluated: number,
  feeAdjustmentsMade: number,
  candidatesEvaluated: number,
  rebalanceExecuted: boolean,
  topologyRecommendation: string | null
): void {
  db.prepare(
    `UPDATE rebalance_runs
     SET completed_at = ?, clusters_evaluated = ?, fee_adjustments_made = ?,
         candidates_evaluated = ?, rebalance_executed = ?,
         topology_recommendation = ?, status = 'complete'
     WHERE run_id = ?`
  ).run(
    Date.now(),
    clustersEvaluated,
    feeAdjustmentsMade,
    candidatesEvaluated,
    rebalanceExecuted ? 1 : 0,
    topologyRecommendation,
    runId
  );
}

// ─── Start / stop ───────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startClusterRebalanceScheduler(): void {
  if (!ENV.clusterRebalanceEnabled) {
    if (ENV.debug) console.log("[cluster-rebalance] disabled (CLUSTER_REBALANCE_ENABLED != true)");
    return;
  }

  console.log(
    `[cluster-rebalance] starting scheduler, interval ${ENV.clusterRebalanceIntervalMs}ms`
  );

  // Run once immediately on startup
  runOnce().catch((err) => {
    console.error("[cluster-rebalance] initial run failed:", err);
  });

  intervalHandle = setInterval(() => {
    runOnce().catch((err) => {
      console.error("[cluster-rebalance] tick failed:", err);
    });
  }, ENV.clusterRebalanceIntervalMs);
}

export function stopClusterRebalanceScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
