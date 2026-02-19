import { API_BASE } from "../config/api";

export async function checkHealth(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

// ---- Shared helpers ----

/** Shorten a pubkey to first 12 + last 6 chars for display. */
export function truncPubkey(pk: string): string {
  if (!pk || pk.length < 20) return pk;
  return `${pk.slice(0, 12)}…${pk.slice(-6)}`;
}

export function fmtSats(n: number): string {
  return n.toLocaleString() + " sats";
}

// ---- Node ----

export type NodeInfo = {
  alias: string;
  pubkey: string;
  block_height: number | null;
  synced_to_chain: number;
  has_treasury_channel: number;
  membership_status: string;
};

export async function fetchNode(): Promise<NodeInfo> {
  const res = await fetch(`${API_BASE}/api/node`);
  if (!res.ok) throw new Error(`/api/node failed: ${res.status}`);
  return res.json();
}

// ---- Treasury Metrics ----

export type TreasuryMetrics = {
  as_of: number;
  all_time: {
    inbound_sats: number;
    outbound_sats: number;
    outbound_fees_sats: number;
    forwarded_fees_sats: number;
    rebalance_costs_sats: number;
    net_sats: number;
  };
  last_24h: {
    inbound_sats: number;
    outbound_sats: number;
    outbound_fees_sats: number;
    forwarded_fees_sats: number;
    rebalance_costs_sats: number;
    net_sats: number;
  };
  liquidity: {
    channels_total: {
      local_sats: number;
      remote_sats: number;
      capacity_sats: number;
      active_count: number;
      total_count: number;
    };
    treasury_channel: null | {
      peer_pubkey: string;
      local_sats: number;
      remote_sats: number;
      capacity_sats: number;
      is_active: boolean;
      updated_at: number;
    };
  };
  capital_efficiency: {
    capital_deployed_sats: number;
    revenue_yield: number;
    revenue_per_1m_sats_deployed: number;
    runway_days: number | null;
  };
};

export async function fetchTreasuryMetrics(): Promise<TreasuryMetrics> {
  const res = await fetch(`${API_BASE}/api/treasury/metrics`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ---- Fee Policy ----

export type TreasuryFeePolicy = {
  id: 1;
  base_fee_msat: number;
  fee_rate_ppm: number;
  updated_at: number;
  last_applied_at: number | null;
};

export async function fetchFeePolicy(): Promise<TreasuryFeePolicy> {
  const res = await fetch(`${API_BASE}/api/treasury/fee-policy`);
  if (!res.ok) throw new Error(`fee-policy failed: ${res.status}`);
  return res.json();
}

export async function setFeePolicy(fee_rate_ppm: number): Promise<TreasuryFeePolicy> {
  const res = await fetch(`${API_BASE}/api/treasury/fee-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fee_rate_ppm }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `POST fee-policy failed: ${res.status}`);
  }
  return res.json();
}

// ---- Capital Policy ----

export type TreasuryCapitalPolicy = {
  id: 1;
  min_onchain_reserve_sats: number;
  max_deploy_ratio_ppm: number;
  max_pending_opens: number;
  max_peer_capacity_sats: number;
  peer_cooldown_minutes: number;
  max_expansions_per_day: number;
  max_daily_deploy_sats: number;
  max_daily_loss_sats: number;
  updated_at: number;
  last_applied_at: number | null;
};

export async function fetchCapitalPolicy(): Promise<TreasuryCapitalPolicy> {
  const res = await fetch(`${API_BASE}/api/treasury/capital-policy`);
  if (!res.ok) throw new Error(`capital-policy failed: ${res.status}`);
  return res.json();
}

export async function setCapitalPolicy(policy: {
  min_onchain_reserve_sats?: number;
  max_deploy_ratio_ppm?: number;
  max_daily_loss_sats?: number;
}): Promise<TreasuryCapitalPolicy> {
  const res = await fetch(`${API_BASE}/api/treasury/capital-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `POST capital-policy failed: ${res.status}`);
  }
  return res.json();
}

// ---- Alerts ----

export type AlertSeverity = "info" | "warning" | "critical";

export type TreasuryAlert = {
  type: string;
  severity: AlertSeverity;
  message: string;
  data: Record<string, unknown>;
  at: number;
};

export async function fetchAlerts(): Promise<TreasuryAlert[]> {
  const res = await fetch(`${API_BASE}/api/treasury/alerts`);
  if (!res.ok) throw new Error(`alerts failed: ${res.status}`);
  return res.json();
}

// ---- Channel Metrics ----

export type ChannelMetric = {
  channel_id: string;
  peer_pubkey: string;
  local_sats: number;
  remote_sats: number;
  capacity_sats: number;
  is_active: boolean;
  forwarded_volume_sats: number;
  forwarded_fees_sats: number;
  fee_per_1k_sats: number;
  roi_percent: number;
  liquidity_efficiency_score: number;
  payback_days: number | null;
  rebalance_costs_sats: number;
  net_fees_sats: number;
  roi_ppm: number;
};

export async function fetchChannelMetrics(): Promise<ChannelMetric[]> {
  const res = await fetch(`${API_BASE}/api/treasury/channel-metrics`);
  if (!res.ok) throw new Error(`channel-metrics failed: ${res.status}`);
  return res.json();
}

// ---- Peer Scores ----

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
  weighted_roi_ppm: number;
  uptime_ratio: number;
  peer_score: number;
};

export async function fetchPeerScores(): Promise<PeerScore[]> {
  const res = await fetch(`${API_BASE}/api/treasury/peers/performance`);
  if (!res.ok) throw new Error(`peers/performance failed: ${res.status}`);
  return res.json();
}

// ---- Rotation Candidates ----

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
  rotation_score: number;
  reason: string;
};

export type RotationDryRunResult = {
  dry_run: true;
  would_close: {
    channel_id: string;
    peer_pubkey: string;
    capacity_sats: number;
    local_sats: number;
    roi_ppm: number;
    reason: string;
    is_force_close: boolean;
  };
};

export async function fetchRotationCandidates(): Promise<RotationCandidate[]> {
  const res = await fetch(`${API_BASE}/api/treasury/rotation/candidates`);
  if (!res.ok) throw new Error(`rotation/candidates failed: ${res.status}`);
  return res.json();
}

export async function executeRotation(params: {
  channel_id: string;
  dry_run?: boolean;
  is_force_close?: boolean;
}): Promise<RotationDryRunResult | { ok: boolean; status: string; closing_txid: string | null }> {
  const res = await fetch(`${API_BASE}/api/treasury/rotation/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `rotation/execute failed: ${res.status}`);
  }
  return res.json();
}

// ---- Dynamic Fees ----

export type ChannelFeeAdjustment = {
  channel_id: string;
  peer_pubkey: string;
  health_classification: string;
  imbalance_ratio: number;
  base_fee_rate_ppm: number;
  target_fee_rate_ppm: number;
  adjustment_factor: number;
};

export async function fetchDynamicFeePreview(): Promise<ChannelFeeAdjustment[]> {
  const res = await fetch(`${API_BASE}/api/treasury/fees/dynamic-preview`);
  if (!res.ok) throw new Error(`fees/dynamic-preview failed: ${res.status}`);
  return res.json();
}

export async function applyDynamicFees(): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/treasury/fees/apply-dynamic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `apply-dynamic failed: ${res.status}`);
  }
  return res.json();
}
