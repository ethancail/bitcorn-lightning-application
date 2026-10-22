import { db } from "../db";

export type ChannelMetric = {
  channel_id: string;
  peer_pubkey: string;
  local_sats: number;
  remote_sats: number;
  capacity_sats: number;
  is_active: boolean;
  /**
   * This channel's 50/50 share of forwarded tokens: half of each forward is
   * attributed to its incoming channel and half to its outgoing channel, so
   * the sum across channels equals SUM(tokens). Decision A, bitcorn-research
   * decisions/2026-10-22-forwarding-fee-attribution-split-50-50.md.
   */
  forwarded_volume_sats: number;
  /**
   * This channel's 50/50 attribution of forwarding revenue: half of each
   * forward's fee to its incoming channel, half to its outgoing channel, so the
   * sum across channels equals SUM(fee) — each fee earned is counted once.
   * Decision A, as above.
   */
  forwarded_fees_sats: number;
  /** Fee per 1,000 sats routed (fee / tokens * 1000). */
  fee_per_1k_sats: number;
  /** Gross revenue as % of local liquidity (forwarded_fees / local_sats * 100). */
  roi_percent: number;
  /** Revenue per 1 sat of local liquidity (forwarded_fees / local_sats). */
  liquidity_efficiency_score: number;
  /** Days until channel pays for itself at current daily forward fee rate; null if no recent fees. */
  payback_days: number | null;
  /** Rebalance fees attributed to this channel (as the incoming/receiver side of each rebalance). */
  rebalance_costs_sats: number;
  /** Net fees after rebalance costs: forwarded_fees − rebalance_costs. */
  net_fees_sats: number;
  /** True net yield per million sats of local liquidity: net_fees / local_sats * 1_000_000. */
  roi_ppm: number;
};

type ForwardAgg = { channel_id: string; volume: number; fees: number };

/**
 * Returns rebalance costs attributed per channel.
 * Costs are attributed to the incoming (receiver) channel — the channel that
 * received local liquidity and therefore benefited from the rebalance.
 */
function getRebalanceCostsByChannel(): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT
         incoming_channel AS channel_id,
         COALESCE(SUM(fee_paid_sats), 0) AS costs
       FROM treasury_rebalance_executions
       WHERE status = 'succeeded'
       GROUP BY incoming_channel`
    )
    .all() as Array<{ channel_id: string; costs: number }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.channel_id, row.costs ?? 0);
  }
  return map;
}

/**
 * The incoming channel's half of each forward: floor(x/2), per row. tokens and
 * fee are INTEGER columns, so `/ 2` is SQLite integer division (a floor for
 * these non-negative values). Splitting per row, not per sum, is what makes
 * each forward's two shares add back to that forward exactly.
 */
function getIncomingAggregates(since?: number): ForwardAgg[] {
  if (since != null) {
    return db
      .prepare(
        `SELECT
           incoming_channel AS channel_id,
           COALESCE(SUM(tokens / 2), 0) AS volume,
           COALESCE(SUM(fee / 2), 0) AS fees
         FROM payments_forwarded
         WHERE created_at >= ?
         GROUP BY incoming_channel`
      )
      .all(since) as ForwardAgg[];
  }
  return db
    .prepare(
      `SELECT
         incoming_channel AS channel_id,
         COALESCE(SUM(tokens / 2), 0) AS volume,
         COALESCE(SUM(fee / 2), 0) AS fees
       FROM payments_forwarded
       GROUP BY incoming_channel`
    )
    .all() as ForwardAgg[];
}

/**
 * The outgoing channel's half of each forward: the remainder, x − floor(x/2),
 * per row — so incoming + outgoing shares sum to the forward exactly.
 */
function getOutgoingAggregates(since?: number): ForwardAgg[] {
  if (since != null) {
    return db
      .prepare(
        `SELECT
           outgoing_channel AS channel_id,
           COALESCE(SUM(tokens - tokens / 2), 0) AS volume,
           COALESCE(SUM(fee - fee / 2), 0) AS fees
         FROM payments_forwarded
         WHERE created_at >= ?
         GROUP BY outgoing_channel`
      )
      .all(since) as ForwardAgg[];
  }
  return db
    .prepare(
      `SELECT
         outgoing_channel AS channel_id,
         COALESCE(SUM(tokens - tokens / 2), 0) AS volume,
         COALESCE(SUM(fee - fee / 2), 0) AS fees
       FROM payments_forwarded
       GROUP BY outgoing_channel`
    )
    .all() as ForwardAgg[];
}

/**
 * Adds each channel's incoming-leg and outgoing-leg shares. The two shares
 * are disjoint halves of each forward (see the aggregates above), so a forward
 * is counted once across channels, not once per leg — decision A,
 * bitcorn-research
 * decisions/2026-10-22-forwarding-fee-attribution-split-50-50.md. The hub's
 * lanes are one-directional, so neither leg alone may carry the whole forward:
 * it would zero every merchant lane (outgoing only) or every farmer lane
 * (incoming only).
 */
function mergeForwardAggregates(
  incoming: ForwardAgg[],
  outgoing: ForwardAgg[]
): Map<string, { volume: number; fees: number }> {
  const map = new Map<string, { volume: number; fees: number }>();

  for (const row of incoming) {
    const cur = map.get(row.channel_id) ?? { volume: 0, fees: 0 };
    cur.volume += row.volume ?? 0;
    cur.fees += row.fees ?? 0;
    map.set(row.channel_id, cur);
  }
  for (const row of outgoing) {
    const cur = map.get(row.channel_id) ?? { volume: 0, fees: 0 };
    cur.volume += row.volume ?? 0;
    cur.fees += row.fees ?? 0;
    map.set(row.channel_id, cur);
  }

  return map;
}

/**
 * Per-channel profitability: forward volume, fees, fee per 1k sats,
 * ROI, liquidity efficiency, and payback period at current daily fee rate.
 */
export function getChannelMetrics(): ChannelMetric[] {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;

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

  const incoming = getIncomingAggregates();
  const outgoing = getOutgoingAggregates();
  const forwardByChannel = mergeForwardAggregates(incoming, outgoing);

  const incoming24 = getIncomingAggregates(since24h);
  const outgoing24 = getOutgoingAggregates(since24h);
  const forwardByChannel24h = mergeForwardAggregates(incoming24, outgoing24);

  const rebalanceCostsByChannel = getRebalanceCostsByChannel();

  return channels.map(c => {
    const fwd = forwardByChannel.get(c.channel_id) ?? {
      volume: 0,
      fees: 0,
    };
    const fwd24 = forwardByChannel24h.get(c.channel_id) ?? {
      volume: 0,
      fees: 0,
    };
    const volume = fwd.volume;
    const fees = fwd.fees;
    const fees24h = fwd24.fees;
    const local = c.local_sats ?? 0;

    const fee_per_1k_sats =
      volume > 0 ? (fees / volume) * 1000 : 0;
    const roi_percent = local > 0 ? (fees / local) * 100 : 0;
    const liquidity_efficiency_score = local > 0 ? fees / local : 0;

    // Layer 3 — Payback: days until channel pays for itself at current daily fee rate
    const payback_days: number | null =
      fees24h > 0 && local > 0 ? local / fees24h : null;

    // Layer 4 — True net ROI: forwarded fees minus rebalance costs attributed to this channel
    const rebalance_costs_sats = rebalanceCostsByChannel.get(c.channel_id) ?? 0;
    const net_fees_sats = fees - rebalance_costs_sats;
    const roi_ppm = local > 0 ? (net_fees_sats / local) * 1_000_000 : 0;

    return {
      channel_id: c.channel_id,
      peer_pubkey: c.peer_pubkey,
      local_sats: local,
      remote_sats: c.remote_sats ?? 0,
      capacity_sats: c.capacity_sats ?? 0,
      is_active: !!c.is_active,
      forwarded_volume_sats: volume,
      forwarded_fees_sats: fees,
      fee_per_1k_sats: Math.round(fee_per_1k_sats * 100) / 100,
      roi_percent: Math.round(roi_percent * 100) / 100,
      liquidity_efficiency_score: Math.round(liquidity_efficiency_score * 1e6) / 1e6,
      payback_days:
        payback_days != null ? Math.round(payback_days * 10) / 10 : null,
      rebalance_costs_sats,
      net_fees_sats,
      roi_ppm: Math.round(roi_ppm),
    };
  });
}
