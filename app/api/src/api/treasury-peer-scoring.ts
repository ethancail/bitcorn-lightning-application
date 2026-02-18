import { getChannelMetrics } from "./treasury-channel-metrics";

export type PeerScore = {
  peer_pubkey: string;
  channel_count: number;
  active_channel_count: number;
  total_capacity_sats: number;
  total_local_sats: number;
  total_forwarded_volume_sats: number;
  total_forwarded_fees_sats: number;
  total_rebalance_costs_sats: number;
  total_net_fees_sats: number;
  /** Capital-weighted average ROI across all channels with this peer (net fees / local sats * 1M). */
  weighted_roi_ppm: number;
  /** Fraction of channels that are active (0–1). */
  uptime_ratio: number;
  /** Composite peer score = weighted_roi_ppm × uptime_ratio. Higher is better. */
  peer_score: number;
};

/**
 * Aggregates per-channel metrics by peer and computes a composite score.
 *
 * peer_score = weighted_roi_ppm × uptime_ratio
 *
 * weighted_roi_ppm is capital-weighted: peers with more local liquidity deployed
 * have their channel ROI weighted proportionally. uptime_ratio penalises peers
 * with inactive channels. A negative peer_score means the peer is net unprofitable
 * after rebalance costs.
 */
export function getPeerScores(): PeerScore[] {
  const channelMetrics = getChannelMetrics();

  const peerMap = new Map<string, ReturnType<typeof getChannelMetrics>>();
  for (const metric of channelMetrics) {
    const existing = peerMap.get(metric.peer_pubkey) ?? [];
    existing.push(metric);
    peerMap.set(metric.peer_pubkey, existing);
  }

  const scores: PeerScore[] = [];

  for (const [peer_pubkey, channels] of peerMap) {
    const channel_count = channels.length;
    const active_channel_count = channels.filter(c => c.is_active).length;
    const uptime_ratio = channel_count > 0 ? active_channel_count / channel_count : 0;

    const total_capacity_sats = channels.reduce((sum, c) => sum + c.capacity_sats, 0);
    const total_local_sats = channels.reduce((sum, c) => sum + c.local_sats, 0);
    const total_forwarded_volume_sats = channels.reduce((sum, c) => sum + c.forwarded_volume_sats, 0);
    const total_forwarded_fees_sats = channels.reduce((sum, c) => sum + c.forwarded_fees_sats, 0);
    const total_rebalance_costs_sats = channels.reduce((sum, c) => sum + c.rebalance_costs_sats, 0);
    const total_net_fees_sats = channels.reduce((sum, c) => sum + c.net_fees_sats, 0);

    // Capital-weighted ROI: Σ(roi_ppm × local_sats) / Σ(local_sats)
    const weighted_roi_ppm =
      total_local_sats > 0
        ? channels.reduce((sum, c) => sum + c.roi_ppm * c.local_sats, 0) / total_local_sats
        : 0;

    const peer_score = Math.round(weighted_roi_ppm * uptime_ratio);

    scores.push({
      peer_pubkey,
      channel_count,
      active_channel_count,
      total_capacity_sats,
      total_local_sats,
      total_forwarded_volume_sats,
      total_forwarded_fees_sats,
      total_rebalance_costs_sats,
      total_net_fees_sats,
      weighted_roi_ppm: Math.round(weighted_roi_ppm),
      uptime_ratio: Math.round(uptime_ratio * 10000) / 10000,
      peer_score,
    });
  }

  scores.sort((a, b) => b.peer_score - a.peer_score);

  return scores;
}
