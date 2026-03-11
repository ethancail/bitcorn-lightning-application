import { updateRoutingFees, getChannels } from "ln-service";
import { getLndClient } from "../lightning/lnd";
import { db } from "../db";
import type { ClusterState } from "./clusterState";

// ─── Types ───────────────────────────────────────────────────────────────────

export type FeeAdjustmentReason = "below_band" | "above_band" | "return_to_baseline";

export interface FeeAdjustment {
  clusterId: string;
  oldFeePpm: number;
  newFeePpm: number;
  reason: FeeAdjustmentReason;
  appliedAt: number;
}

interface FeePolicyRow {
  cluster_id: string;
  base_fee_msat: number;
  base_fee_rate_ppm: number;
  current_fee_rate_ppm: number;
  min_fee_rate_ppm: number;
  max_fee_rate_ppm: number;
  step_ppm: number;
  last_adjusted_at: number | null;
  adjustment_cooldown_sec: number;
  admin_override: number;
}

// Default scheduler interval (15 min) — used for hysteresis calculation
const DEFAULT_INTERVAL_SEC = 900;
const HYSTERESIS_RUNS = 3;

// ─── Core: evaluate and apply fee steering for one cluster ───────────────────

export async function applyFeeSteeringIfDue(
  state: ClusterState
): Promise<FeeAdjustment | null> {
  const policy = db
    .prepare("SELECT * FROM rebalance_fee_policy WHERE cluster_id = ?")
    .get(state.clusterId) as FeePolicyRow | undefined;

  if (!policy) return null;

  // Admin override suppresses all auto-steering
  if (policy.admin_override) return null;

  // Cooldown check — no more than one adjustment per cooldown period per cluster
  const now = Date.now();
  if (policy.last_adjusted_at) {
    const cooldownMs = policy.adjustment_cooldown_sec * 1000;
    if (now - policy.last_adjusted_at < cooldownMs) return null;
  }

  const oldPpm = policy.current_fee_rate_ppm;
  let newPpm = oldPpm;
  let reason: FeeAdjustmentReason | null = null;

  if (state.deviationDirection === "below") {
    // Cluster is starved of local balance — raise fee to discourage outflow
    newPpm = oldPpm + policy.step_ppm;
    reason = "below_band";
  } else if (state.deviationDirection === "above") {
    // Cluster has excess local balance — lower fee to encourage outflow
    newPpm = oldPpm - policy.step_ppm;
    reason = "above_band";
  } else {
    // Inside band — check if we should return toward baseline (hysteresis).
    // Uses time-based proxy: "3 runs × 15 min = 45 min since last adjustment"
    // rather than a counter. This survives process restarts because last_adjusted_at
    // is persisted in the DB. Only diverges if CLUSTER_REBALANCE_INTERVAL_MS changes
    // mid-operation, which is harmless (slightly longer/shorter hysteresis window).
    if (oldPpm !== policy.base_fee_rate_ppm) {
      const hysteresisMs = HYSTERESIS_RUNS * DEFAULT_INTERVAL_SEC * 1000;
      const lastAdjust = policy.last_adjusted_at ?? 0;
      if (now - lastAdjust >= hysteresisMs) {
        // Move one step toward baseline
        if (oldPpm > policy.base_fee_rate_ppm) {
          newPpm = oldPpm - policy.step_ppm;
          // Don't overshoot baseline
          if (newPpm < policy.base_fee_rate_ppm) newPpm = policy.base_fee_rate_ppm;
        } else {
          newPpm = oldPpm + policy.step_ppm;
          if (newPpm > policy.base_fee_rate_ppm) newPpm = policy.base_fee_rate_ppm;
        }
        reason = "return_to_baseline";
      }
    }
  }

  // No change needed
  if (reason === null || newPpm === oldPpm) return null;

  // Clamp to floor/ceiling
  newPpm = Math.max(policy.min_fee_rate_ppm, Math.min(policy.max_fee_rate_ppm, newPpm));

  // If clamping eliminated the change, bail
  if (newPpm === oldPpm) return null;

  // Apply to LND channels in this cluster
  await applyFeeToClusterChannels(state, policy.base_fee_msat, newPpm);

  // Record the adjustment
  const appliedAt = Date.now();
  const eventId = `fee_${state.clusterId}_${appliedAt}`;

  db.prepare(
    `INSERT INTO rebalance_fee_events (event_id, cluster_id, old_fee_rate_ppm, new_fee_rate_ppm, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(eventId, state.clusterId, oldPpm, newPpm, reason, appliedAt);

  db.prepare(
    `UPDATE rebalance_fee_policy
     SET current_fee_rate_ppm = ?, last_adjusted_at = ?, updated_at = ?
     WHERE cluster_id = ?`
  ).run(newPpm, appliedAt, appliedAt, state.clusterId);

  return {
    clusterId: state.clusterId,
    oldFeePpm: oldPpm,
    newFeePpm: newPpm,
    reason,
    appliedAt,
  };
}

// ─── Apply fee rate to all non-excluded channels in a cluster ────────────────

async function applyFeeToClusterChannels(
  state: ClusterState,
  baseFeesMsat: number,
  feeRatePpm: number
): Promise<void> {
  const { lnd } = getLndClient();
  const { channels: lndChannels } = await getChannels({ lnd });

  // Map ln-service channel id → funding outpoint
  const outpointMap = new Map(
    lndChannels.map((c) => [
      c.id,
      { transaction_id: c.transaction_id, transaction_vout: c.transaction_vout },
    ])
  );

  const baseFeeTokens = String(baseFeesMsat);

  for (const ch of state.channels) {
    if (ch.excludeFromAutoFee) continue;

    const outpoint = outpointMap.get(ch.channelId);
    if (!outpoint) continue;

    try {
      await updateRoutingFees({
        lnd,
        transaction_id: outpoint.transaction_id,
        transaction_vout: outpoint.transaction_vout,
        base_fee_mtokens: baseFeeTokens,
        fee_rate: feeRatePpm,
      });
    } catch (err: any) {
      console.error(
        `[feeSteering] failed to set fee on channel ${ch.channelId}: ${err?.message}`
      );
    }
  }
}

// ─── Batch: run fee steering for all clusters ────────────────────────────────

export async function applyAllFeeSteeringIfDue(
  states: ClusterState[]
): Promise<FeeAdjustment[]> {
  const adjustments: FeeAdjustment[] = [];
  for (const state of states) {
    const adj = await applyFeeSteeringIfDue(state);
    if (adj) adjustments.push(adj);
  }
  return adjustments;
}
