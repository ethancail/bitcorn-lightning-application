import { db } from "../db";
import { getLndIdentity, getLndRouteToDestination } from "../lightning/lnd";
import type { ClusterState } from "./clusterState";
import type { ClusterPair } from "./pairSelector";
import { makePairId } from "./pairSelector";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CandidateStatus = "theoretical" | "probed" | "executable" | "executed";

export interface RebalanceCandidate {
  candidateId: string;
  runId: string;
  sourceClusterId: string;
  destClusterId: string;
  sourceChannelId: string;
  destChannelId: string;
  amountSats: number;
  routeFingerprint: string | null;
  estimatedFeeSats: number | null;
  routeProbedAt: number | null;
  routeTtlSeconds: number;
  candidateStatus: CandidateStatus;
  probeResult: "success" | "failure" | "not_attempted";
  score: number | null;
}

interface PairHistoryRow {
  success_p50_sats: number | null;
  success_p75_sats: number | null;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_ROUTE_TTL_SECONDS = 20;
const DEFAULT_MAX_REBALANCE_SATS = 500_000;
const MIN_REBALANCE_SATS = 10_000;
const AMOUNT_BUCKET_PCTS = [0.25, 0.5, 0.75];

// ─── Surplus / deficit calculation ───────────────────────────────────────────

function computeSurplusSats(cluster: ClusterState): number {
  const targetLocal = Math.floor((cluster.targetMidPct / 100) * cluster.totalCapacitySats);
  return Math.max(0, cluster.localBalanceSats - targetLocal);
}

function computeDeficitSats(cluster: ClusterState): number {
  const targetLocal = Math.floor((cluster.targetMidPct / 100) * cluster.totalCapacitySats);
  return Math.max(0, targetLocal - cluster.localBalanceSats);
}

// ─── Amount bucketing ────────────────────────────────────────────────────────

function computeAmountBuckets(
  pair: ClusterPair,
  pairHistory: PairHistoryRow | undefined
): number[] {
  const surplus = computeSurplusSats(pair.source);
  const deficit = computeDeficitSats(pair.destination);
  const maxAmount = Math.min(surplus, deficit, DEFAULT_MAX_REBALANCE_SATS);

  if (maxAmount < MIN_REBALANCE_SATS) return [];

  const amounts: number[] = [];

  // Prefer historical success amounts if available
  if (pairHistory?.success_p50_sats && pairHistory.success_p50_sats >= MIN_REBALANCE_SATS) {
    const p50 = Math.min(pairHistory.success_p50_sats, maxAmount);
    if (p50 >= MIN_REBALANCE_SATS) amounts.push(p50);
  }
  if (pairHistory?.success_p75_sats && pairHistory.success_p75_sats >= MIN_REBALANCE_SATS) {
    const p75 = Math.min(pairHistory.success_p75_sats, maxAmount);
    if (p75 >= MIN_REBALANCE_SATS && !amounts.includes(p75)) amounts.push(p75);
  }

  // If no history, use percentage buckets
  if (amounts.length === 0) {
    for (const pct of AMOUNT_BUCKET_PCTS) {
      const amt = Math.floor(maxAmount * pct);
      if (amt >= MIN_REBALANCE_SATS && !amounts.includes(amt)) {
        amounts.push(amt);
      }
    }
  }

  return amounts;
}

// ─── Channel selection within a cluster ──────────────────────────────────────

function pickSourceChannel(cluster: ClusterState): string | null {
  // Prefer channels marked as preferred_source, else pick the one with most local balance
  const preferred = cluster.channels.find((c) => c.preferredSource && c.active);
  if (preferred) return preferred.channelId;

  const active = cluster.channels
    .filter((c) => c.active)
    .sort((a, b) => b.localBalanceSats - a.localBalanceSats);
  return active[0]?.channelId ?? null;
}

function pickDestChannel(cluster: ClusterState): string | null {
  // Prefer channels marked as preferred_dest, else pick the one with most remote balance (least local)
  const preferred = cluster.channels.find((c) => c.preferredDest && c.active);
  if (preferred) return preferred.channelId;

  const active = cluster.channels
    .filter((c) => c.active)
    .sort((a, b) => a.localBalanceSats - b.localBalanceSats);
  return active[0]?.channelId ?? null;
}

// ─── Route probing ───────────────────────────────────────────────────────────

interface ProbeResult {
  success: boolean;
  feeSats: number | null;
  routeFingerprint: string | null;
}

async function probeRoute(
  selfPubkey: string,
  sourceChannelId: string,
  destPeerPubkey: string,
  amountSats: number,
  maxFeeSats: number
): Promise<ProbeResult> {
  try {
    const { route } = await getLndRouteToDestination({
      destination: selfPubkey,
      tokens: amountSats,
      outgoing_channel: sourceChannelId,
      incoming_peer: destPeerPubkey,
      max_fee: maxFeeSats,
    });

    const fingerprint = route.hops
      .map((h: { channel: string }) => h.channel)
      .join("→");

    return {
      success: true,
      feeSats: route.fee ?? 0,
      routeFingerprint: fingerprint,
    };
  } catch {
    return { success: false, feeSats: null, routeFingerprint: null };
  }
}

// ─── Persist candidate to DB ─────────────────────────────────────────────────

const insertCandidateStmt = `
  INSERT INTO rebalance_candidates
    (candidate_id, run_id, source_cluster_id, dest_cluster_id,
     source_channel_id, dest_channel_id, amount_sats, route_fingerprint,
     estimated_fee_sats, candidate_status, probe_result, route_probed_at,
     route_ttl_seconds, score, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function persistCandidate(c: RebalanceCandidate): void {
  db.prepare(insertCandidateStmt).run(
    c.candidateId,
    c.runId,
    c.sourceClusterId,
    c.destClusterId,
    c.sourceChannelId,
    c.destChannelId,
    c.amountSats,
    c.routeFingerprint,
    c.estimatedFeeSats,
    c.candidateStatus,
    c.probeResult,
    c.routeProbedAt,
    c.routeTtlSeconds,
    c.score,
    Date.now()
  );
}

// ─── Main: enumerate candidates for all pairs ────────────────────────────────

export async function enumerateCandidates(
  pairs: ClusterPair[],
  runId: string
): Promise<RebalanceCandidate[]> {
  if (pairs.length === 0) return [];

  const identity = await getLndIdentity();
  const selfPubkey = identity.public_key;
  if (!selfPubkey) return [];

  // Load pair history for amount bucketing
  const pairHistoryRows = db
    .prepare("SELECT pair_id, success_p50_sats, success_p75_sats FROM rebalance_pair_history")
    .all() as Array<{ pair_id: string; success_p50_sats: number | null; success_p75_sats: number | null }>;

  const pairHistoryMap = new Map<string, PairHistoryRow>();
  for (const r of pairHistoryRows) pairHistoryMap.set(r.pair_id, r);

  const allCandidates: RebalanceCandidate[] = [];
  let candidateSeq = 0;

  for (const pair of pairs) {
    const sourceChannelId = pickSourceChannel(pair.source);
    const destChannelId = pickDestChannel(pair.destination);
    if (!sourceChannelId || !destChannelId) continue;

    const pairId = makePairId(pair.source.clusterId, pair.destination.clusterId);
    const history = pairHistoryMap.get(pairId);
    const amounts = computeAmountBuckets(pair, history);

    for (const amount of amounts) {
      candidateSeq++;
      const candidateId = `${runId}_c${candidateSeq}`;

      // Max fee: 1% of amount as default probe ceiling
      const maxFeeSats = Math.max(1, Math.ceil(amount * 0.01));

      const probe = await probeRoute(
        selfPubkey,
        sourceChannelId,
        pair.destination.peerPubkey,
        amount,
        maxFeeSats
      );

      const now = Date.now();
      const status: CandidateStatus = probe.success ? "executable" : "theoretical";

      const candidate: RebalanceCandidate = {
        candidateId,
        runId,
        sourceClusterId: pair.source.clusterId,
        destClusterId: pair.destination.clusterId,
        sourceChannelId,
        destChannelId,
        amountSats: amount,
        routeFingerprint: probe.routeFingerprint,
        estimatedFeeSats: probe.feeSats,
        routeProbedAt: probe.success ? now : null,
        routeTtlSeconds: DEFAULT_ROUTE_TTL_SECONDS,
        candidateStatus: status,
        probeResult: probe.success ? "success" : "failure",
        score: null, // scored in cycleScorer
      };

      persistCandidate(candidate);
      allCandidates.push(candidate);
    }
  }

  return allCandidates;
}

// ─── Re-probe a candidate if its route is stale ──────────────────────────────

export async function reprobeIfStale(
  candidate: RebalanceCandidate,
  destPeerPubkey: string
): Promise<RebalanceCandidate> {
  if (candidate.candidateStatus !== "executable") return candidate;

  const now = Date.now();
  const probedAt = candidate.routeProbedAt ?? 0;
  const ttlMs = candidate.routeTtlSeconds * 1000;

  if (now - probedAt <= ttlMs) return candidate; // still fresh

  const identity = await getLndIdentity();
  const selfPubkey = identity.public_key;
  if (!selfPubkey) {
    candidate.candidateStatus = "theoretical";
    candidate.probeResult = "failure";
    return candidate;
  }

  const maxFeeSats = Math.max(1, Math.ceil(candidate.amountSats * 0.01));
  const probe = await probeRoute(
    selfPubkey,
    candidate.sourceChannelId,
    destPeerPubkey,
    candidate.amountSats,
    maxFeeSats
  );

  if (probe.success) {
    candidate.routeProbedAt = Date.now();
    candidate.routeFingerprint = probe.routeFingerprint;
    candidate.estimatedFeeSats = probe.feeSats;
    candidate.probeResult = "success";
  } else {
    candidate.candidateStatus = "theoretical";
    candidate.probeResult = "failure";
  }

  // Update DB
  db.prepare(
    `UPDATE rebalance_candidates
     SET candidate_status = ?, probe_result = ?, route_probed_at = ?,
         route_fingerprint = ?, estimated_fee_sats = ?
     WHERE candidate_id = ?`
  ).run(
    candidate.candidateStatus,
    candidate.probeResult,
    candidate.routeProbedAt,
    candidate.routeFingerprint,
    candidate.estimatedFeeSats,
    candidate.candidateId
  );

  return candidate;
}
