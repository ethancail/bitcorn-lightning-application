import { db } from "../db";
import type { ClusterState } from "./clusterState";
import type { RebalanceCandidate } from "./cycleEnumerator";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScorerAction = "execute" | "no_action";

export interface ScorerResult {
  action: ScorerAction;
  candidate: RebalanceCandidate | null;
  score: number | null;
  reason: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_SCORE_THRESHOLD = 1.5;

// Weights for benefit components
const FORWARD_FEE_WEIGHT = 1.0;
const DEVIATION_VALUE_WEIGHT = 0.5;
const BLOCKED_DEMAND_WEIGHT = 0.3;

// Failure risk: penalise theoretical candidates that weren't successfully probed
const FAILURE_RISK_MULTIPLIER = 2.0;

// Recency penalty: recently failed pairs get a surcharge (sats)
const RECENCY_PENALTY_SATS = 50;
const RECENCY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── Benefit estimation ─────────────────────────────────────────────────────

/**
 * Estimate the 24h forwarding revenue that would be unlocked by moving sats
 * from a source cluster (excess local) to a destination cluster (starved local).
 *
 * Uses the destination cluster's recent revenue to project what restored
 * capacity could earn. Crude but directional.
 */
function estimateForwardFeeUnlocked(
  dest: ClusterState,
  amountSats: number
): number {
  if (dest.totalCapacitySats === 0) return 0;
  // Revenue per sat of local capacity, extrapolated over the rebalance amount
  const revenuePerSat = dest.recentForwardRevenueSats / Math.max(1, dest.localBalanceSats);
  return Math.max(0, revenuePerSat * amountSats);
}

/**
 * Value of reducing deviation from target band.
 * Higher deviation = more valuable to correct. Scaled by amount relative to capacity.
 */
function computeDeviationValue(
  source: ClusterState,
  dest: ClusterState,
  amountSats: number
): number {
  const sourceCorrection = source.totalCapacitySats > 0
    ? (amountSats / source.totalCapacitySats) * source.deviationPct
    : 0;
  const destCorrection = dest.totalCapacitySats > 0
    ? (amountSats / dest.totalCapacitySats) * dest.deviationPct
    : 0;
  // Return combined correction value in "equivalent sats" (deviation points → sats)
  // 1 deviation point ≈ 10 sats of value (tunable)
  return (sourceCorrection + destCorrection) * 10;
}

/**
 * Proxy for blocked demand: destination's failed forward count suggests
 * unserviced routing requests that this rebalance could unlock.
 */
function computeBlockedDemandProxy(dest: ClusterState, amountSats: number): number {
  // Each failed forward is worth roughly 1 sat of benefit per 10k rebalanced
  return dest.failedForwardCount * (amountSats / 10_000);
}

// ─── Cost estimation ────────────────────────────────────────────────────────

function computeCostSats(
  candidate: RebalanceCandidate,
  pairLastFailedAt: number | null,
  now: number
): number {
  const feeSats = candidate.estimatedFeeSats ?? 0;

  // Theoretical candidates (failed probe) carry a risk multiplier on assumed fee
  const failureRisk =
    candidate.candidateStatus !== "executable"
      ? feeSats * FAILURE_RISK_MULTIPLIER
      : 0;

  // Recency cost: if this pair failed recently, add a penalty
  const recencyCost =
    pairLastFailedAt && now - pairLastFailedAt < RECENCY_WINDOW_MS
      ? RECENCY_PENALTY_SATS
      : 0;

  return feeSats + failureRisk + recencyCost;
}

// ─── Safety checks ──────────────────────────────────────────────────────────

/**
 * Would moving `amountSats` from source drop it below its floor percentage?
 */
function wouldBreachFloor(source: ClusterState, amountSats: number): boolean {
  const newLocal = source.localBalanceSats - amountSats;
  if (source.totalCapacitySats === 0) return true;
  const newLocalPct = (newLocal / source.totalCapacitySats) * 100;
  return newLocalPct < source.floorPct;
}

/**
 * Is the destination already inside its target band?
 * If so, rebalancing toward it has diminished value.
 */
function destAlreadyInsideBand(dest: ClusterState): boolean {
  return dest.deviationDirection === "inside";
}

// ─── Load recent failure data ───────────────────────────────────────────────

function loadRecentFailures(): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT source_cluster_id || ':' || dest_cluster_id AS pair_id,
              MAX(created_at) AS last_failed_at
       FROM rebalance_outcomes
       WHERE status = 'failure'
       GROUP BY pair_id`
    )
    .all() as Array<{ pair_id: string; last_failed_at: number }>;

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.pair_id, r.last_failed_at);
  return map;
}

// ─── Main: score candidates and pick the best ───────────────────────────────

export function scoreCandidates(
  candidates: RebalanceCandidate[],
  clusterMap: Map<string, ClusterState>
): ScorerResult {
  if (candidates.length === 0) {
    return { action: "no_action", candidate: null, score: null, reason: "no_candidates" };
  }

  const executableCandidates = candidates.filter((c) => c.candidateStatus === "executable");
  if (executableCandidates.length === 0) {
    return {
      action: "no_action",
      candidate: null,
      score: null,
      reason: "no_executable_candidates",
    };
  }

  const recentFailures = loadRecentFailures();
  const now = Date.now();

  let bestCandidate: RebalanceCandidate | null = null;
  let bestScore = -Infinity;

  for (const candidate of executableCandidates) {
    const source = clusterMap.get(candidate.sourceClusterId);
    const dest = clusterMap.get(candidate.destClusterId);
    if (!source || !dest) continue;

    // Safety: skip if source would breach floor
    if (wouldBreachFloor(source, candidate.amountSats)) continue;

    // Safety: skip if destination is already balanced
    if (destAlreadyInsideBand(dest)) continue;

    // Benefit
    const forwardFee = estimateForwardFeeUnlocked(dest, candidate.amountSats);
    const deviationValue = computeDeviationValue(source, dest, candidate.amountSats);
    const blockedDemand = computeBlockedDemandProxy(dest, candidate.amountSats);

    const benefitSats =
      FORWARD_FEE_WEIGHT * forwardFee +
      DEVIATION_VALUE_WEIGHT * deviationValue +
      BLOCKED_DEMAND_WEIGHT * blockedDemand;

    // Cost
    const pairId = `${candidate.sourceClusterId}:${candidate.destClusterId}`;
    const pairLastFailed = recentFailures.get(pairId) ?? null;
    const costSats = computeCostSats(candidate, pairLastFailed, now);

    // Score = benefit / cost (avoid division by zero)
    const score = costSats > 0 ? benefitSats / costSats : benefitSats > 0 ? 100 : 0;

    // Persist score on the candidate
    candidate.score = Math.round(score * 100) / 100;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    return {
      action: "no_action",
      candidate: null,
      score: null,
      reason: "all_candidates_filtered_by_safety",
    };
  }

  // Update score in DB for the best candidate
  db.prepare("UPDATE rebalance_candidates SET score = ? WHERE candidate_id = ?").run(
    bestCandidate.score,
    bestCandidate.candidateId
  );

  if (bestScore < DEFAULT_SCORE_THRESHOLD) {
    return {
      action: "no_action",
      candidate: bestCandidate,
      score: bestCandidate.score,
      reason: `best_score_${bestCandidate.score}_below_threshold_${DEFAULT_SCORE_THRESHOLD}`,
    };
  }

  return {
    action: "execute",
    candidate: bestCandidate,
    score: bestCandidate.score,
    reason: "score_above_threshold",
  };
}
