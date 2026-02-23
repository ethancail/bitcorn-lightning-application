import { db } from "../db";

export type HealthClassification =
  | "outbound_starved"
  | "weak"
  | "healthy"
  | "inbound_heavy"
  | "critical";

export type RecommendedAction = "none" | "monitor" | "expand" | "rebalance";

export type ChannelLiquidityHealth = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sats: number;
  local_sats: number;
  remote_sats: number;
  imbalance_ratio: number; // local_sats / capacity_sats (0-1)
  health_classification: HealthClassification;
  /** Net forward flow through channel in last 24h (incoming - outgoing sats). */
  velocity_24h_sats: number;
  recommended_action: RecommendedAction;
  is_active: boolean;
};

function classifyHealth(imbalanceRatio: number): HealthClassification {
  if (imbalanceRatio < 0.15) return "outbound_starved";
  if (imbalanceRatio < 0.35) return "weak";
  if (imbalanceRatio < 0.65) return "healthy";
  if (imbalanceRatio < 0.85) return "inbound_heavy";
  return "critical";
}

function recommendAction(
  classification: HealthClassification,
  velocity24h: number,
  isActive: boolean
): RecommendedAction {
  if (!isActive) return "none";

  // Critical or outbound_starved with negative velocity → expand
  if (
    (classification === "critical" || classification === "outbound_starved") &&
    velocity24h < 0
  ) {
    return "expand";
  }

  // Weak with sustained negative velocity → monitor or expand
  if (classification === "weak" && velocity24h < -10000) {
    return "monitor";
  }

  // Inbound heavy with positive velocity → monitor (might need rebalance later)
  if (classification === "inbound_heavy" && velocity24h > 10000) {
    return "monitor";
  }

  // Outbound starved → expand
  if (classification === "outbound_starved") {
    return "expand";
  }

  // Critical → expand
  if (classification === "critical") {
    return "expand";
  }

  // Healthy → none
  if (classification === "healthy") {
    return "none";
  }

  // Default → monitor
  return "monitor";
}

type ForwardFlow = {
  channel_id: string;
  incoming_volume: number;
  outgoing_volume: number;
};

function getChannelForwardFlow24h(since24h: number): Map<string, ForwardFlow> {
  const incoming = db
    .prepare(
      `SELECT
         incoming_channel AS channel_id,
         COALESCE(SUM(tokens), 0) AS volume
       FROM payments_forwarded
       WHERE created_at >= ?
       GROUP BY incoming_channel`
    )
    .all(since24h) as Array<{ channel_id: string; volume: number }>;

  const outgoing = db
    .prepare(
      `SELECT
         outgoing_channel AS channel_id,
         COALESCE(SUM(tokens), 0) AS volume
       FROM payments_forwarded
       WHERE created_at >= ?
       GROUP BY outgoing_channel`
    )
    .all(since24h) as Array<{ channel_id: string; volume: number }>;

  const flowMap = new Map<string, ForwardFlow>();

  for (const row of incoming) {
    flowMap.set(row.channel_id, {
      channel_id: row.channel_id,
      incoming_volume: row.volume ?? 0,
      outgoing_volume: 0,
    });
  }

  for (const row of outgoing) {
    const existing = flowMap.get(row.channel_id);
    if (existing) {
      existing.outgoing_volume = row.volume ?? 0;
    } else {
      flowMap.set(row.channel_id, {
        channel_id: row.channel_id,
        incoming_volume: 0,
        outgoing_volume: row.volume ?? 0,
      });
    }
  }

  return flowMap;
}

export function getLiquidityHealth(): ChannelLiquidityHealth[] {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const forwardFlow = getChannelForwardFlow24h(since24h);

  const channels = db
    .prepare(
      `SELECT
         channel_id,
         peer_pubkey,
         capacity_sat AS capacity_sats,
         local_balance_sat AS local_sats,
         remote_balance_sat AS remote_sats,
         active AS is_active
       FROM lnd_channels
       ORDER BY channel_id`
    )
    .all() as Array<{
    channel_id: string;
    peer_pubkey: string;
    capacity_sats: number;
    local_sats: number;
    remote_sats: number;
    is_active: number;
  }>;

  return channels.map((c) => {
    const capacity = c.capacity_sats ?? 0;
    const local = c.local_sats ?? 0;
    const imbalanceRatio = capacity > 0 ? local / capacity : 0;
    const classification = classifyHealth(imbalanceRatio);

    const flow = forwardFlow.get(c.channel_id) ?? {
      channel_id: c.channel_id,
      incoming_volume: 0,
      outgoing_volume: 0,
    };
    const velocity24h = flow.incoming_volume - flow.outgoing_volume;

    const recommendedAction = recommendAction(
      classification,
      velocity24h,
      !!c.is_active
    );

    return {
      channel_id: c.channel_id,
      peer_pubkey: c.peer_pubkey,
      capacity_sats: capacity,
      local_sats: local,
      remote_sats: c.remote_sats ?? 0,
      imbalance_ratio: Math.round(imbalanceRatio * 10000) / 10000, // 4 decimal places
      health_classification: classification,
      velocity_24h_sats: velocity24h,
      recommended_action: recommendedAction,
      is_active: !!c.is_active,
    };
  });
}
