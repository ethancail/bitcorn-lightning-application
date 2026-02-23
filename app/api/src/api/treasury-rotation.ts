import { db } from "../db";
import { getChannelMetrics } from "./treasury-channel-metrics";
import { ENV } from "../config/env";

export type RotationCandidate = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sats: number;
  local_sats: number;
  roi_ppm: number;
  net_fees_sats: number;
  rebalance_costs_sats: number;
  forwarded_volume_sats: number;
  payback_days: number | null;
  /** Higher = more urgent to rotate out. */
  rotation_score: number;
  reason: string;
};

export type RotationExecution = {
  id: number;
  channel_id: string;
  peer_pubkey: string;
  capacity_sats: number;
  local_sats: number;
  roi_ppm: number;
  reason: string;
  is_force_close: boolean;
  status: "requested" | "submitted" | "failed";
  closing_txid: string | null;
  error: string | null;
  created_at: number;
};

function buildReason(roiPpm: number, volume: number, paybackDays: number | null): string {
  const parts: string[] = [];
  if (roiPpm < 0) parts.push(`negative roi (${roiPpm} ppm)`);
  if (volume === 0) parts.push("no forwarding volume");
  if (paybackDays !== null && paybackDays > 365) parts.push(`payback ${Math.round(paybackDays)}d`);
  return parts.join("; ") || "low roi";
}

/**
 * Returns channels that are candidates for rotation (closure + reallocation).
 *
 * Scoring:
 *   roi_ppm < 0          → +100  (losing money after rebalance costs)
 *   roi_ppm < -500       → +50   (heavily negative, additional penalty)
 *   forwarded_volume = 0 → +50   (idle channel, capital fully wasted)
 *   payback_days > 730   → +50   (>2yr payback)
 *   payback_days > 365   → +30   (>1yr payback)
 *
 * Excludes: inactive channels, the treasury channel, channels with score = 0.
 * Sorted by rotation_score descending.
 */
export function getRotationCandidates(): RotationCandidate[] {
  const metrics = getChannelMetrics();

  const candidates: RotationCandidate[] = [];

  for (const c of metrics) {
    // Skip inactive channels — can't cooperatively close them predictably
    if (!c.is_active) continue;

    // Never rotate the treasury channel
    if (ENV.treasuryPubkey && c.peer_pubkey === ENV.treasuryPubkey) continue;

    let score = 0;

    if (c.roi_ppm < 0) score += 100;
    if (c.roi_ppm < -500) score += 50;
    if (c.forwarded_volume_sats === 0) score += 50;
    if (c.payback_days !== null && c.payback_days > 730) score += 50;
    else if (c.payback_days !== null && c.payback_days > 365) score += 30;

    if (score === 0) continue;

    candidates.push({
      channel_id: c.channel_id,
      peer_pubkey: c.peer_pubkey,
      capacity_sats: c.capacity_sats,
      local_sats: c.local_sats,
      roi_ppm: c.roi_ppm,
      net_fees_sats: c.net_fees_sats,
      rebalance_costs_sats: c.rebalance_costs_sats,
      forwarded_volume_sats: c.forwarded_volume_sats,
      payback_days: c.payback_days,
      rotation_score: score,
      reason: buildReason(c.roi_ppm, c.forwarded_volume_sats, c.payback_days),
    });
  }

  candidates.sort((a, b) => b.rotation_score - a.rotation_score);
  return candidates;
}

export function createRotationExecution(
  channelId: string,
  peerPubkey: string,
  capacitySats: number,
  localSats: number,
  roiPpm: number,
  reason: string,
  isForceClose: boolean
): number {
  const result = db
    .prepare(
      `INSERT INTO treasury_rotation_executions
       (channel_id, peer_pubkey, capacity_sats, local_sats, roi_ppm,
        reason, is_force_close, status, closing_txid, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', NULL, NULL, ?)`
    )
    .run(channelId, peerPubkey, capacitySats, localSats, roiPpm, reason, isForceClose ? 1 : 0, Date.now());
  return Number(result.lastInsertRowid);
}

export function updateRotationExecution(
  id: number,
  status: "submitted" | "failed",
  closingTxid?: string | null,
  error?: string | null
): void {
  db.prepare(
    `UPDATE treasury_rotation_executions
     SET status = ?, closing_txid = ?, error = ?
     WHERE id = ?`
  ).run(status, closingTxid ?? null, error ?? null, id);
}

export function getRotationExecutions(limit: number = 50): RotationExecution[] {
  return db
    .prepare(
      `SELECT id, channel_id, peer_pubkey, capacity_sats, local_sats, roi_ppm,
              reason, is_force_close, status, closing_txid, error, created_at
       FROM treasury_rotation_executions
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as RotationExecution[];
}
