/**
 * Channel classifier — reads the member's treasury channel from lnd_channels
 * and classifies it into one of five states based on member-local percentage.
 *
 * Urgency escalates when a channel stays non-healthy for consecutive runs.
 */

import { db } from "../db";
import { ENV } from "../config/env";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChannelState =
  | "healthy"
  | "send_heavy"
  | "send_saturated"
  | "receive_heavy"
  | "receive_exhausted";

export type Urgency = "none" | "low" | "medium" | "high";

export interface ChannelClassification {
  channelId: string;
  capacitySat: number;
  memberLocalSat: number;
  treasuryLocalSat: number;
  memberLocalPct: number;
  state: ChannelState;
  urgency: Urgency;
  consecutiveNonHealthyRuns: number;
  classifiedAt: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface AdvisorConfig {
  sendHeavyThresholdPct: number;
  sendSaturatedThresholdPct: number;
  receiveHeavyThresholdPct: number;
  receiveExhaustedThresholdPct: number;
}

export function getAdvisorConfig(): AdvisorConfig {
  const row = db
    .prepare("SELECT * FROM member_liquidity_advisor_config WHERE id = 1")
    .get() as any;

  return {
    sendHeavyThresholdPct: row?.send_heavy_threshold_pct ?? 0.70,
    sendSaturatedThresholdPct: row?.send_saturated_threshold_pct ?? 0.85,
    receiveHeavyThresholdPct: row?.receive_heavy_threshold_pct ?? 0.30,
    receiveExhaustedThresholdPct: row?.receive_exhausted_threshold_pct ?? 0.15,
  };
}

// ─── Treasury channel lookup ─────────────────────────────────────────────────

interface ChannelRow {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
}

export function getTreasuryChannel(): ChannelRow | null {
  if (!ENV.treasuryPubkey) return null;

  const row = db
    .prepare(
      "SELECT * FROM lnd_channels WHERE peer_pubkey = ? AND active = 1 LIMIT 1"
    )
    .get(ENV.treasuryPubkey) as ChannelRow | undefined;

  return row ?? null;
}

// ─── Classification ──────────────────────────────────────────────────────────

function classifyState(memberLocalPct: number, cfg: AdvisorConfig): ChannelState {
  if (memberLocalPct >= cfg.sendSaturatedThresholdPct) return "send_saturated";
  if (memberLocalPct >= cfg.sendHeavyThresholdPct) return "send_heavy";
  if (memberLocalPct <= cfg.receiveExhaustedThresholdPct) return "receive_exhausted";
  if (memberLocalPct <= cfg.receiveHeavyThresholdPct) return "receive_heavy";
  return "healthy";
}

function getLastConsecutiveRuns(channelId: string): number {
  const row = db
    .prepare(
      `SELECT consecutive_non_healthy_runs FROM member_channel_classifications
       WHERE channel_id = ? ORDER BY classified_at DESC LIMIT 1`
    )
    .get(channelId) as { consecutive_non_healthy_runs: number } | undefined;

  return row?.consecutive_non_healthy_runs ?? 0;
}

function computeUrgency(state: ChannelState, consecutiveRuns: number): Urgency {
  if (state === "healthy") return "none";

  // High-urgency states start at medium and escalate
  if (state === "send_saturated" || state === "receive_exhausted") {
    return consecutiveRuns >= 2 ? "high" : "medium";
  }

  // Moderate states start at low and escalate
  if (consecutiveRuns >= 4) return "high";
  if (consecutiveRuns >= 2) return "medium";
  return "low";
}

export function classifyTreasuryChannel(): ChannelClassification | null {
  const ch = getTreasuryChannel();
  if (!ch) return null;

  const cfg = getAdvisorConfig();
  const memberLocalPct = ch.capacity_sat > 0
    ? ch.local_balance_sat / ch.capacity_sat
    : 0;

  const state = classifyState(memberLocalPct, cfg);
  const prevRuns = getLastConsecutiveRuns(ch.channel_id);
  const consecutiveNonHealthyRuns = state === "healthy" ? 0 : prevRuns + 1;
  const urgency = computeUrgency(state, consecutiveNonHealthyRuns);

  return {
    channelId: ch.channel_id,
    capacitySat: ch.capacity_sat,
    memberLocalSat: ch.local_balance_sat,
    treasuryLocalSat: ch.remote_balance_sat,
    memberLocalPct,
    state,
    urgency,
    consecutiveNonHealthyRuns,
    classifiedAt: Date.now(),
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function persistClassification(c: ChannelClassification): void {
  const id = `cls_${c.channelId}_${c.classifiedAt}`;
  db.prepare(
    `INSERT INTO member_channel_classifications
       (classification_id, channel_id, capacity_sat, member_local_sat,
        treasury_local_sat, member_local_pct, state, urgency,
        consecutive_non_healthy_runs, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    c.channelId,
    c.capacitySat,
    c.memberLocalSat,
    c.treasuryLocalSat,
    c.memberLocalPct,
    c.state,
    c.urgency,
    c.consecutiveNonHealthyRuns,
    c.classifiedAt
  );
}

export function getClassificationHistory(channelId: string, limit = 20): ChannelClassification[] {
  const rows = db
    .prepare(
      `SELECT * FROM member_channel_classifications
       WHERE channel_id = ? ORDER BY classified_at DESC LIMIT ?`
    )
    .all(channelId, limit) as any[];

  return rows.map((r) => ({
    channelId: r.channel_id,
    capacitySat: r.capacity_sat,
    memberLocalSat: r.member_local_sat,
    treasuryLocalSat: r.treasury_local_sat,
    memberLocalPct: r.member_local_pct,
    state: r.state as ChannelState,
    urgency: r.urgency as Urgency,
    consecutiveNonHealthyRuns: r.consecutive_non_healthy_runs,
    classifiedAt: r.classified_at,
  }));
}
