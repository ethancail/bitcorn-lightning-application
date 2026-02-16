import { db } from "../db";
import { getLiquidityHealth } from "./treasury-liquidity-health";

// Expansion policy defaults
const MIN_CHANNEL_SATS = 100_000;
const MAX_CHANNEL_SATS = 2_000_000;
const TARGET_LOCAL_RATIO = 0.45;

export type ExpansionRecommendation = {
  peer_pubkey: string;
  channel_id: string | null;
  classification: string;
  velocity_24h_sats: number;
  imbalance_ratio: number;
  suggested_capacity_sats: number;
  reason: string;
  priority_score: number;
};

export type ExpansionExecution = {
  id: number;
  peer_pubkey: string;
  requested_capacity_sats: number;
  status: "requested" | "submitted" | "failed" | "succeeded";
  funding_txid: string | null;
  error: string | null;
  created_at: number;
};

function computeSuggestedCapacity(
  currentCapacity: number,
  currentLocal: number,
  targetRatio: number = TARGET_LOCAL_RATIO
): number {
  const targetLocal = currentCapacity * targetRatio;
  const deficit = Math.max(0, targetLocal - currentLocal);
  
  // Opening a channel adds local on treasury side, so we need ~2x the deficit
  // (because the new channel will be split roughly 50/50)
  const suggested = Math.ceil(deficit * 2);
  
  // Clamp to min/max
  return Math.max(
    MIN_CHANNEL_SATS,
    Math.min(MAX_CHANNEL_SATS, suggested)
  );
}

function computePriorityScore(
  classification: string,
  velocity24h: number,
  imbalanceRatio: number
): number {
  let score = 0;
  
  // Classification weight
  if (classification === "critical") score += 100;
  else if (classification === "outbound_starved") score += 80;
  else if (classification === "weak") score += 40;
  
  // Velocity weight (negative = draining)
  if (velocity24h < -100000) score += 30;
  else if (velocity24h < -50000) score += 20;
  else if (velocity24h < 0) score += 10;
  
  // Imbalance weight (lower = worse)
  if (imbalanceRatio < 0.1) score += 20;
  else if (imbalanceRatio < 0.2) score += 10;
  
  return score;
}

/**
 * Generates expansion recommendations based on liquidity health.
 */
export async function generateExpansionRecommendations(): Promise<ExpansionRecommendation[]> {
  const health = getLiquidityHealth();
  
  const recommendations: ExpansionRecommendation[] = [];
  
  for (const channelHealth of health) {
    // Filter: only outbound_starved or critical with negative velocity
    if (
      (channelHealth.health_classification === "outbound_starved" ||
        channelHealth.health_classification === "critical") &&
      channelHealth.velocity_24h_sats < 0
    ) {
      const suggestedCapacity = computeSuggestedCapacity(
        channelHealth.capacity_sats,
        channelHealth.local_sats
      );
      
      const priorityScore = computePriorityScore(
        channelHealth.health_classification,
        channelHealth.velocity_24h_sats,
        channelHealth.imbalance_ratio
      );
      
      const reason = `${channelHealth.health_classification} channel with ${channelHealth.velocity_24h_sats} sats net outflow in 24h`;
      
      recommendations.push({
        peer_pubkey: channelHealth.peer_pubkey,
        channel_id: channelHealth.channel_id,
        classification: channelHealth.health_classification,
        velocity_24h_sats: channelHealth.velocity_24h_sats,
        imbalance_ratio: channelHealth.imbalance_ratio,
        suggested_capacity_sats: suggestedCapacity,
        reason,
        priority_score: priorityScore,
      });
    }
  }
  
  // Sort by priority (highest first)
  recommendations.sort((a, b) => b.priority_score - a.priority_score);
  
  return recommendations;
}

/**
 * Saves recommendations to DB (optional audit trail).
 */
export function saveExpansionRecommendations(
  recommendations: ExpansionRecommendation[]
): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO treasury_expansion_recommendations
    (peer_pubkey, channel_id, classification, velocity_24h_sats, imbalance_ratio,
     suggested_capacity_sats, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const rec of recommendations) {
    stmt.run(
      rec.peer_pubkey,
      rec.channel_id,
      rec.classification,
      rec.velocity_24h_sats,
      rec.imbalance_ratio,
      rec.suggested_capacity_sats,
      rec.reason,
      now
    );
  }
}

/**
 * Creates a new expansion execution record.
 */
export function createExpansionExecution(
  peerPubkey: string,
  requestedCapacitySats: number
): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO treasury_expansion_executions
       (peer_pubkey, requested_capacity_sats, status, funding_txid, error, created_at)
       VALUES (?, ?, 'requested', NULL, NULL, ?)`
    )
    .run(peerPubkey, requestedCapacitySats, now);
  
  return Number(result.lastInsertRowid);
}

/**
 * Updates expansion execution status.
 */
export function updateExpansionExecution(
  id: number,
  status: "submitted" | "failed" | "succeeded",
  fundingTxid?: string | null,
  error?: string | null
): void {
  db.prepare(
    `UPDATE treasury_expansion_executions
     SET status = ?, funding_txid = ?, error = ?
     WHERE id = ?`
  ).run(status, fundingTxid ?? null, error ?? null, id);
}

/**
 * Gets expansion execution by ID.
 */
export function getExpansionExecution(id: number): ExpansionExecution | null {
  const row = db
    .prepare(
      `SELECT id, peer_pubkey, requested_capacity_sats, status, funding_txid, error, created_at
       FROM treasury_expansion_executions
       WHERE id = ?`
    )
    .get(id) as ExpansionExecution | null;
  
  return row;
}
