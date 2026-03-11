import { db } from "../db";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PolicyRole =
  | "member_primary_outbound"
  | "member_secondary_buffer"
  | "external_ingress"
  | "external_cycle_utility";

export type FlowProfile = "send_heavy" | "receive_heavy" | "mixed" | "unknown";

export type DeviationDirection = "below" | "above" | "inside";

export interface ChannelSummary {
  channelId: string;
  chanIdUint64: string | null;
  channelPoint: string | null;
  capacitySats: number;
  localBalanceSats: number;
  remoteBalanceSats: number;
  active: boolean;
  preferredSource: boolean;
  preferredDest: boolean;
  excludeFromAutoFee: boolean;
  channelFeeWeight: number;
}

export interface ClusterState {
  clusterId: string;
  label: string;
  peerPubkey: string;
  policyRole: PolicyRole;
  observedFlowProfile: FlowProfile;
  totalCapacitySats: number;
  localBalanceSats: number;
  remoteBalanceSats: number;
  localPct: number;
  targetMinPct: number;
  targetMidPct: number;
  targetMaxPct: number;
  floorPct: number;
  ceilingPct: number;
  deviationPct: number;
  deviationDirection: DeviationDirection;
  recentForwardRevenueSats: number;
  failedForwardCount: number;
  memberPriorityTier: number | null;
  rebalanceCooldownSec: number;
  lastRebalancedAt: number | null;
  channels: ChannelSummary[];
}

// ─── DB row types ────────────────────────────────────────────────────────────

interface ClusterRow {
  cluster_id: string;
  label: string;
  peer_pubkey: string;
  policy_role: string;
  observed_flow_profile: string | null;
  target_min_pct: number;
  target_mid_pct: number;
  target_max_pct: number;
  floor_pct: number;
  ceiling_pct: number;
  member_priority_tier: number | null;
  rebalance_cooldown_sec: number;
  last_rebalanced_at: number | null;
}

interface ClusterChannelRow {
  cluster_id: string;
  channel_id: string;
  chan_id_uint64: string | null;
  channel_point: string | null;
  exclude_from_auto_fee: number;
  channel_fee_weight: number;
  preferred_source: number;
  preferred_dest: number;
}

interface LndChannelRow {
  channel_id: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
}

interface ForwardVolumeRow {
  channel_id: string;
  volume: number;
  fee: number;
}

// ─── Forwarding history helpers ──────────────────────────────────────────────

function getChannelForwardVolumes(since: number): {
  incoming: Map<string, { volume: number; fee: number }>;
  outgoing: Map<string, { volume: number; fee: number }>;
} {
  const inRows = db
    .prepare(
      `SELECT incoming_channel AS channel_id,
              COALESCE(SUM(tokens), 0) AS volume,
              COALESCE(SUM(fee), 0) AS fee
       FROM payments_forwarded
       WHERE created_at >= ?
       GROUP BY incoming_channel`
    )
    .all(since) as ForwardVolumeRow[];

  const outRows = db
    .prepare(
      `SELECT outgoing_channel AS channel_id,
              COALESCE(SUM(tokens), 0) AS volume,
              COALESCE(SUM(fee), 0) AS fee
       FROM payments_forwarded
       WHERE created_at >= ?
       GROUP BY outgoing_channel`
    )
    .all(since) as ForwardVolumeRow[];

  const incoming = new Map<string, { volume: number; fee: number }>();
  for (const r of inRows) incoming.set(r.channel_id, { volume: r.volume, fee: r.fee });

  const outgoing = new Map<string, { volume: number; fee: number }>();
  for (const r of outRows) outgoing.set(r.channel_id, { volume: r.volume, fee: r.fee });

  return { incoming, outgoing };
}

// ─── Flow profile classification ─────────────────────────────────────────────

const FLOW_RATIO_THRESHOLD = 2.0;
const MIN_VOLUME_FOR_CLASSIFICATION = 1000; // sats — below this, stay "unknown"

function classifyFlowProfile(
  incomingVolume: number,
  outgoingVolume: number
): FlowProfile {
  const total = incomingVolume + outgoingVolume;
  if (total < MIN_VOLUME_FOR_CLASSIFICATION) return "unknown";

  if (outgoingVolume > 0 && incomingVolume / outgoingVolume >= FLOW_RATIO_THRESHOLD) {
    return "receive_heavy";
  }
  if (incomingVolume > 0 && outgoingVolume / incomingVolume >= FLOW_RATIO_THRESHOLD) {
    return "send_heavy";
  }
  return "mixed";
}

// ─── Deviation computation ───────────────────────────────────────────────────

function computeDeviation(
  localPct: number,
  targetMinPct: number,
  targetMidPct: number,
  targetMaxPct: number
): { deviationPct: number; deviationDirection: DeviationDirection } {
  if (localPct < targetMinPct) {
    return {
      deviationPct: Math.round((targetMidPct - localPct) * 100) / 100,
      deviationDirection: "below",
    };
  }
  if (localPct > targetMaxPct) {
    return {
      deviationPct: Math.round((localPct - targetMidPct) * 100) / 100,
      deviationDirection: "above",
    };
  }
  return { deviationPct: 0, deviationDirection: "inside" };
}

// ─── Main: read all cluster states ───────────────────────────────────────────

export function getAllClusterStates(): ClusterState[] {
  const clusters = db
    .prepare("SELECT * FROM rebalance_clusters ORDER BY cluster_id")
    .all() as ClusterRow[];

  if (clusters.length === 0) return [];

  const clusterChannels = db
    .prepare("SELECT * FROM rebalance_cluster_channels ORDER BY cluster_id, channel_id")
    .all() as ClusterChannelRow[];

  // Index cluster channels by cluster_id
  const channelsByCluster = new Map<string, ClusterChannelRow[]>();
  for (const cc of clusterChannels) {
    const list = channelsByCluster.get(cc.cluster_id) ?? [];
    list.push(cc);
    channelsByCluster.set(cc.cluster_id, list);
  }

  // Fetch all live channel data in one query, indexed by channel_id
  const lndChannels = db
    .prepare(
      `SELECT channel_id, capacity_sat, local_balance_sat, remote_balance_sat, active
       FROM lnd_channels`
    )
    .all() as LndChannelRow[];

  const lndMap = new Map<string, LndChannelRow>();
  for (const ch of lndChannels) lndMap.set(ch.channel_id, ch);

  // Forwarding volumes for last 24h
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const { incoming, outgoing } = getChannelForwardVolumes(since24h);

  // Update flow profile for each cluster
  const updateFlowProfile = db.prepare(
    `UPDATE rebalance_clusters
     SET observed_flow_profile = ?, updated_at = ?
     WHERE cluster_id = ?`
  );

  const results: ClusterState[] = [];

  for (const cluster of clusters) {
    const ccRows = channelsByCluster.get(cluster.cluster_id) ?? [];

    // Build channel summaries and aggregate cluster-level balances
    let totalCapacity = 0;
    let totalLocal = 0;
    let totalRemote = 0;
    let clusterIncoming = 0;
    let clusterOutgoing = 0;
    let clusterFeeRevenue = 0;

    const channels: ChannelSummary[] = [];

    for (const cc of ccRows) {
      const lnd = lndMap.get(cc.channel_id);
      const cap = lnd?.capacity_sat ?? 0;
      const local = lnd?.local_balance_sat ?? 0;
      const remote = lnd?.remote_balance_sat ?? 0;
      const active = lnd ? !!lnd.active : false;

      totalCapacity += cap;
      totalLocal += local;
      totalRemote += remote;

      // Aggregate forwarding volumes across cluster channels
      const inVol = incoming.get(cc.channel_id);
      const outVol = outgoing.get(cc.channel_id);
      if (inVol) {
        clusterIncoming += inVol.volume;
        clusterFeeRevenue += inVol.fee;
      }
      if (outVol) {
        clusterOutgoing += outVol.volume;
        // Fees are earned on incoming side, avoid double-counting
      }

      channels.push({
        channelId: cc.channel_id,
        chanIdUint64: cc.chan_id_uint64,
        channelPoint: cc.channel_point,
        capacitySats: cap,
        localBalanceSats: local,
        remoteBalanceSats: remote,
        active,
        preferredSource: !!cc.preferred_source,
        preferredDest: !!cc.preferred_dest,
        excludeFromAutoFee: !!cc.exclude_from_auto_fee,
        channelFeeWeight: cc.channel_fee_weight,
      });
    }

    // Compute local percentage (0–100 scale to match target band pcts)
    const localPct =
      totalCapacity > 0
        ? Math.round((totalLocal / totalCapacity) * 10000) / 100
        : 0;

    // Compute deviation from target band
    const { deviationPct, deviationDirection } = computeDeviation(
      localPct,
      cluster.target_min_pct,
      cluster.target_mid_pct,
      cluster.target_max_pct
    );

    // Classify flow profile from 24h forwarding data
    const flowProfile = classifyFlowProfile(clusterIncoming, clusterOutgoing);

    // Persist updated flow profile if it changed
    const currentProfile = (cluster.observed_flow_profile as FlowProfile) ?? "unknown";
    if (flowProfile !== currentProfile) {
      updateFlowProfile.run(flowProfile, Date.now(), cluster.cluster_id);
    }

    results.push({
      clusterId: cluster.cluster_id,
      label: cluster.label,
      peerPubkey: cluster.peer_pubkey,
      policyRole: cluster.policy_role as PolicyRole,
      observedFlowProfile: flowProfile,
      totalCapacitySats: totalCapacity,
      localBalanceSats: totalLocal,
      remoteBalanceSats: totalRemote,
      localPct,
      targetMinPct: cluster.target_min_pct,
      targetMidPct: cluster.target_mid_pct,
      targetMaxPct: cluster.target_max_pct,
      floorPct: cluster.floor_pct,
      ceilingPct: cluster.ceiling_pct,
      deviationPct,
      deviationDirection,
      recentForwardRevenueSats: clusterFeeRevenue,
      failedForwardCount: 0, // v1: HTLC failure tracking not yet wired to LND
      memberPriorityTier: cluster.member_priority_tier,
      rebalanceCooldownSec: cluster.rebalance_cooldown_sec,
      lastRebalancedAt: cluster.last_rebalanced_at,
      channels,
    });
  }

  return results;
}
