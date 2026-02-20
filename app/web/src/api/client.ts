import { API_BASE } from "../config/api";

export async function checkHealth(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

// ─── Core fetch helper ────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? "Request failed"), { status: res.status });
  }
  return res.json();
}

// ─── Namespaced API object (used by App, Wizard, Dashboard) ──────────────

export const api = {
  getNode: () => apiFetch<NodeInfo>("/api/node"),
  getMemberStats: () => apiFetch<MemberStats>("/api/member/stats"),
  getTreasuryMetrics: () => apiFetch<TreasuryMetrics>("/api/treasury/metrics"),
  getAlerts: () => apiFetch<TreasuryAlert[]>("/api/treasury/alerts"),
  getChannelMetrics: () => apiFetch<ChannelMetric[]>("/api/treasury/channel-metrics"),
  getPeerScores: () => apiFetch<PeerScore[]>("/api/treasury/peers/performance"),
  getRotationCandidates: () => apiFetch<RotationCandidate[]>("/api/treasury/rotation/candidates"),
  getDynamicFeePreview: () => apiFetch<ChannelFeeAdjustment[]>("/api/treasury/fees/dynamic-preview"),
  applyDynamicFees: () => apiFetch<{ ok: boolean; applied: number }>("/api/treasury/fees/apply-dynamic", { method: "POST", body: "{}" }),
  getCapitalPolicy: () => apiFetch<TreasuryCapitalPolicy>("/api/treasury/capital-policy"),
  setCapitalPolicy: (body: Partial<TreasuryCapitalPolicy>) =>
    apiFetch<TreasuryCapitalPolicy>("/api/treasury/capital-policy", { method: "POST", body: JSON.stringify(body) }),
  getFeePolicy: () => apiFetch<TreasuryFeePolicy>("/api/treasury/fee-policy"),
  setFeePolicy: (base_fee_msat: number, fee_rate_ppm: number) =>
    apiFetch<TreasuryFeePolicy>("/api/treasury/fee-policy", {
      method: "POST",
      body: JSON.stringify({ base_fee_msat, fee_rate_ppm }),
    }),
  previewRotation: (channel_id: string) =>
    apiFetch<RotationPreviewResult>("/api/treasury/rotation/execute", {
      method: "POST",
      body: JSON.stringify({ channel_id, dry_run: true }),
    }),
};

// ─── Shared helpers ───────────────────────────────────────────────────────

/** Shorten a pubkey to first 12 + last 6 chars for display. */
export function truncPubkey(pk: string): string {
  if (!pk || pk.length < 20) return pk;
  return `${pk.slice(0, 12)}…${pk.slice(-6)}`;
}

export function fmtSats(n: number): string {
  return n.toLocaleString() + " sats";
}

// ─── Shared types ─────────────────────────────────────────────────────────

export type NodeInfo = {
  alias: string;
  pubkey: string;
  block_height: number | null;
  synced_to_chain: number;
  has_treasury_channel: number;
  membership_status: string;
  node_role: string;
};

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

export type AlertSeverity = "info" | "warning" | "critical";

export type TreasuryAlert = {
  type: string;
  severity: AlertSeverity;
  message: string;
  data: Record<string, unknown>;
  at: number;
};

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

export type ChannelFeeAdjustment = {
  channel_id: string;
  peer_pubkey: string;
  health_classification: string;
  imbalance_ratio: number;
  base_fee_rate_ppm: number;
  target_fee_rate_ppm: number;
  adjustment_factor: number;
};

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

export type TreasuryFeePolicy = {
  id: 1;
  base_fee_msat: number;
  fee_rate_ppm: number;
  updated_at: number;
  last_applied_at: number | null;
};

export type RotationPreviewResult = {
  ok: boolean;
  dry_run: boolean;
  channel_id: string;
  peer_pubkey: string;
  capacity_sats: number;
  local_sats: number;
  roi_ppm: number;
  reason: string;
};

export type MemberStats = {
  hub_pubkey: string | null;
  membership_status: string;
  node_role: string;
  treasury_channel: null | {
    channel_id: string;
    local_sats: number;
    remote_sats: number;
    capacity_sats: number;
    is_active: boolean;
  };
  forwarded_fees: {
    total_sats: number;
    last_24h_sats: number;
    last_30d_sats: number;
  };
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

// ─── Named fetch exports (legacy compat) ─────────────────────────────────

export async function fetchNode(): Promise<NodeInfo> {
  return apiFetch<NodeInfo>("/api/node");
}

export async function fetchTreasuryMetrics(): Promise<TreasuryMetrics> {
  return apiFetch<TreasuryMetrics>("/api/treasury/metrics");
}

export async function fetchFeePolicy(): Promise<TreasuryFeePolicy> {
  return apiFetch<TreasuryFeePolicy>("/api/treasury/fee-policy");
}

export async function setFeePolicy(fee_rate_ppm: number): Promise<TreasuryFeePolicy> {
  return apiFetch<TreasuryFeePolicy>("/api/treasury/fee-policy", {
    method: "POST",
    body: JSON.stringify({ fee_rate_ppm }),
  });
}

export async function fetchCapitalPolicy(): Promise<TreasuryCapitalPolicy> {
  return apiFetch<TreasuryCapitalPolicy>("/api/treasury/capital-policy");
}

export async function setCapitalPolicy(policy: {
  min_onchain_reserve_sats?: number;
  max_deploy_ratio_ppm?: number;
  max_daily_loss_sats?: number;
}): Promise<TreasuryCapitalPolicy> {
  return apiFetch<TreasuryCapitalPolicy>("/api/treasury/capital-policy", {
    method: "POST",
    body: JSON.stringify(policy),
  });
}

export async function fetchAlerts(): Promise<TreasuryAlert[]> {
  return apiFetch<TreasuryAlert[]>("/api/treasury/alerts");
}

export async function fetchChannelMetrics(): Promise<ChannelMetric[]> {
  return apiFetch<ChannelMetric[]>("/api/treasury/channel-metrics");
}

export async function fetchPeerScores(): Promise<PeerScore[]> {
  return apiFetch<PeerScore[]>("/api/treasury/peers/performance");
}

export async function fetchRotationCandidates(): Promise<RotationCandidate[]> {
  return apiFetch<RotationCandidate[]>("/api/treasury/rotation/candidates");
}

export async function executeRotation(params: {
  channel_id: string;
  dry_run?: boolean;
  is_force_close?: boolean;
}): Promise<RotationDryRunResult | { ok: boolean; status: string; closing_txid: string | null }> {
  return apiFetch("/api/treasury/rotation/execute", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function fetchDynamicFeePreview(): Promise<ChannelFeeAdjustment[]> {
  return apiFetch<ChannelFeeAdjustment[]>("/api/treasury/fees/dynamic-preview");
}

export async function applyDynamicFees(): Promise<unknown> {
  return apiFetch("/api/treasury/fees/apply-dynamic", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
