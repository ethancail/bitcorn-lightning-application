import { db } from "../db";
import type { ClusterState, PolicyRole } from "./clusterState";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RecommendationType =
  | "open_external_peer"
  | "add_member_channel"
  | "resize_or_replace_channel"
  | "loop_out"
  | "no_action";

export interface TopologyRecommendation {
  recId: string;
  runId: string;
  recommendationType: RecommendationType;
  clusterId: string | null;
  estimatedAmountSats: number | null;
  peerQualityScore: number | null;
  expectedRoiSats: number | null;
  reason: string;
}

export interface InventorySnapshot {
  snapshotId: string;
  runId: string;
  totalMemberLocalSats: number;
  totalMemberRemoteSats: number;
  totalExternalLocalSats: number;
  totalExternalRemoteSats: number;
  memberLocalPct: number;
  externalLocalPct: number;
}

// ─── Inventory snapshot ─────────────────────────────────────────────────────

export function takeInventorySnapshot(
  states: ClusterState[],
  runId: string
): InventorySnapshot {
  let memberLocal = 0;
  let memberRemote = 0;
  let externalLocal = 0;
  let externalRemote = 0;

  for (const s of states) {
    if (isMemberRole(s.policyRole)) {
      memberLocal += s.localBalanceSats;
      memberRemote += s.remoteBalanceSats;
    } else {
      externalLocal += s.localBalanceSats;
      externalRemote += s.remoteBalanceSats;
    }
  }

  const memberTotal = memberLocal + memberRemote;
  const externalTotal = externalLocal + externalRemote;

  const snapshot: InventorySnapshot = {
    snapshotId: `snap_${runId}`,
    runId,
    totalMemberLocalSats: memberLocal,
    totalMemberRemoteSats: memberRemote,
    totalExternalLocalSats: externalLocal,
    totalExternalRemoteSats: externalRemote,
    memberLocalPct: memberTotal > 0 ? Math.round((memberLocal / memberTotal) * 10000) / 100 : 0,
    externalLocalPct: externalTotal > 0 ? Math.round((externalLocal / externalTotal) * 10000) / 100 : 0,
  };

  db.prepare(
    `INSERT INTO treasury_inventory_snapshots
       (snapshot_id, run_id, total_member_local_sats, total_member_remote_sats,
        total_external_local_sats, total_external_remote_sats,
        member_local_pct, external_local_pct, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.snapshotId,
    snapshot.runId,
    snapshot.totalMemberLocalSats,
    snapshot.totalMemberRemoteSats,
    snapshot.totalExternalLocalSats,
    snapshot.totalExternalRemoteSats,
    snapshot.memberLocalPct,
    snapshot.externalLocalPct,
    Date.now()
  );

  return snapshot;
}

// ─── Topology analysis ──────────────────────────────────────────────────────

export function analyzeTopology(
  states: ClusterState[],
  runId: string,
  rebalanceExecuted: boolean
): TopologyRecommendation[] {
  const recommendations: TopologyRecommendation[] = [];
  let recSeq = 0;

  const memberClusters = states.filter((s) => isMemberRole(s.policyRole));
  const externalClusters = states.filter((s) => !isMemberRole(s.policyRole));

  // Check 1: No external peers at all — circular rebalance is impossible
  if (externalClusters.length === 0 && memberClusters.length > 0) {
    recSeq++;
    recommendations.push({
      recId: `${runId}_rec${recSeq}`,
      runId,
      recommendationType: "open_external_peer",
      clusterId: null,
      estimatedAmountSats: 500_000,
      peerQualityScore: null,
      expectedRoiSats: null,
      reason: "No external peers — circular rebalance requires at least one external channel for routing",
    });
  }

  // Check 2: External peers exist but all are heavily imbalanced toward local
  // (no inbound capacity to route through)
  const externalWithInbound = externalClusters.filter(
    (s) => s.localPct < 80 && s.channels.some((c) => c.active)
  );
  if (externalClusters.length > 0 && externalWithInbound.length === 0) {
    recSeq++;
    recommendations.push({
      recId: `${runId}_rec${recSeq}`,
      runId,
      recommendationType: "loop_out",
      clusterId: null,
      estimatedAmountSats: null,
      peerQualityScore: null,
      expectedRoiSats: null,
      reason: "All external channels are outbound-heavy (>80% local) — consider Loop Out to restore inbound capacity",
    });
  }

  // Check 3: Member clusters critically starved (below floor)
  for (const cluster of memberClusters) {
    if (cluster.localPct < cluster.floorPct && cluster.channels.some((c) => c.active)) {
      recSeq++;
      const deficit = Math.floor(
        ((cluster.targetMidPct - cluster.localPct) / 100) * cluster.totalCapacitySats
      );
      recommendations.push({
        recId: `${runId}_rec${recSeq}`,
        runId,
        recommendationType: "add_member_channel",
        clusterId: cluster.clusterId,
        estimatedAmountSats: deficit,
        peerQualityScore: null,
        expectedRoiSats: null,
        reason: `Cluster "${cluster.label}" at ${cluster.localPct.toFixed(1)}% local, below floor ${cluster.floorPct}% — needs ~${deficit} sats of inbound`,
      });
    }
  }

  // Check 4: Small external channels that can't support Loop Out minimum (250k)
  for (const cluster of externalClusters) {
    const maxCapChannel = Math.max(...cluster.channels.map((c) => c.capacitySats), 0);
    // ACINQ-style 45% max_value_in_flight means we need ~556k capacity for 250k swaps
    if (maxCapChannel > 0 && maxCapChannel < 556_000) {
      recSeq++;
      recommendations.push({
        recId: `${runId}_rec${recSeq}`,
        runId,
        recommendationType: "resize_or_replace_channel",
        clusterId: cluster.clusterId,
        estimatedAmountSats: 700_000,
        peerQualityScore: null,
        expectedRoiSats: null,
        reason: `Cluster "${cluster.label}" largest channel is ${maxCapChannel} sats — too small for Loop Out (need ≥556k for 250k swap minimum)`,
      });
    }
  }

  // If nothing was found and no rebalance happened, emit no_action
  if (recommendations.length === 0 && !rebalanceExecuted) {
    recSeq++;
    recommendations.push({
      recId: `${runId}_rec${recSeq}`,
      runId,
      recommendationType: "no_action",
      clusterId: null,
      estimatedAmountSats: null,
      peerQualityScore: null,
      expectedRoiSats: null,
      reason: "Topology is adequate and no rebalance was needed this cycle",
    });
  }

  // Persist all recommendations
  const stmt = db.prepare(
    `INSERT INTO rebalance_topology_recommendations
       (rec_id, run_id, recommendation_type, cluster_id, estimated_amount_sats,
        peer_quality_score, expected_roi_sats, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const now = Date.now();
  for (const rec of recommendations) {
    stmt.run(
      rec.recId,
      rec.runId,
      rec.recommendationType,
      rec.clusterId,
      rec.estimatedAmountSats,
      rec.peerQualityScore,
      rec.expectedRoiSats,
      rec.reason,
      now
    );
  }

  return recommendations;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMemberRole(role: PolicyRole): boolean {
  return role === "member_primary_outbound" || role === "member_secondary_buffer";
}
