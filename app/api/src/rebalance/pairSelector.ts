import { db } from "../db";
import type { ClusterState } from "./clusterState";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClusterPair {
  source: ClusterState;
  destination: ClusterState;
  combinedDeviation: number;
  cooledDown: boolean;
}

interface PairHistoryRow {
  pair_id: string;
  last_attempt_at: number | null;
}

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Selects (source, destination) cluster pairs for the cycle enumerator.
 *
 * Rules:
 * - Source: deviationDirection === 'above' (has excess local balance)
 * - Destination: deviationDirection === 'below' (is starved of local balance)
 * - Pairs ranked by combined deviationPct (highest first)
 * - Pairs where the source has not cooled down from recent rebalance are excluded
 * - Returns empty array if no valid pair exists (scheduler emits no_action)
 */
export function selectCandidatePairs(states: ClusterState[]): ClusterPair[] {
  const sources = states.filter((s) => s.deviationDirection === "above");
  const destinations = states.filter((s) => s.deviationDirection === "below");

  if (sources.length === 0 || destinations.length === 0) return [];

  // Batch-load pair history for cooldown checks
  const pairHistory = loadPairHistory();
  const now = Date.now();

  const pairs: ClusterPair[] = [];

  for (const source of sources) {
    // Check source rebalance cooldown
    if (!isClusterCooledDown(source, now)) continue;

    for (const dest of destinations) {
      // Skip same-peer pairs (can't circular rebalance within one peer)
      if (source.peerPubkey === dest.peerPubkey) continue;

      // Check destination rebalance cooldown
      if (!isClusterCooledDown(dest, now)) continue;

      // Check pair-level cooldown from recent attempt
      const pairId = makePairId(source.clusterId, dest.clusterId);
      const history = pairHistory.get(pairId);
      const pairCooledDown = isPairCooledDown(history, source, now);

      pairs.push({
        source,
        destination: dest,
        combinedDeviation: source.deviationPct + dest.deviationPct,
        cooledDown: pairCooledDown,
      });
    }
  }

  // Filter out pairs that haven't cooled down
  const eligible = pairs.filter((p) => p.cooledDown);

  // Sort by combined deviation descending (highest imbalance pairs first)
  eligible.sort((a, b) => b.combinedDeviation - a.combinedDeviation);

  return eligible;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function makePairId(sourceClusterId: string, destClusterId: string): string {
  return `${sourceClusterId}:${destClusterId}`;
}

function isClusterCooledDown(cluster: ClusterState, now: number): boolean {
  if (!cluster.lastRebalancedAt) return true;
  const cooldownMs = cluster.rebalanceCooldownSec * 1000;
  return now - cluster.lastRebalancedAt >= cooldownMs;
}

/**
 * Pair-level cooldown: if the last attempt on this pair was within the
 * shorter of the two cluster cooldowns, skip it. This prevents hammering
 * the same pair when the previous attempt just failed.
 */
function isPairCooledDown(
  history: PairHistoryRow | undefined,
  source: ClusterState,
  now: number
): boolean {
  if (!history?.last_attempt_at) return true;
  const cooldownMs = source.rebalanceCooldownSec * 1000;
  return now - history.last_attempt_at >= cooldownMs;
}

function loadPairHistory(): Map<string, PairHistoryRow> {
  const rows = db
    .prepare("SELECT pair_id, last_attempt_at FROM rebalance_pair_history")
    .all() as PairHistoryRow[];

  const map = new Map<string, PairHistoryRow>();
  for (const r of rows) map.set(r.pair_id, r);
  return map;
}
