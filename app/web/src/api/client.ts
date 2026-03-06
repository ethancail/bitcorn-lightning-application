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
  getNodeBalances: () => apiFetch<NodeBalances>("/api/node/balances"),
  getCoinbaseOnrampUrl: () => apiFetch<OnrampUrlResponse>("/api/coinbase/onramp-url"),
  getCommodityPrices: () => apiFetch<CommodityPrices>("/api/commodity-prices"),
  getCornHistory: () => apiFetch<CornHistoryEntry[]>("/api/corn-history"),
  getMemberStats: () => apiFetch<MemberStats>("/api/member/stats"),
  getNodePreflight: () => apiFetch<PreflightResult>("/api/node/preflight"),
  openMemberChannel: (body: { capacity_sats: number; partner_socket?: string }) =>
    apiFetch<{ ok: boolean; funding_txid: string | null }>("/api/member/open-channel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getTreasuryMetrics: () => apiFetch<TreasuryMetrics>("/api/treasury/metrics"),
  getAlerts: () => apiFetch<TreasuryAlert[]>("/api/treasury/alerts"),
  getChannelMetrics: () => apiFetch<ChannelMetric[]>("/api/treasury/channel-metrics"),
  getPeerScores: () => apiFetch<PeerScore[]>("/api/treasury/peers/performance"),
  getRotationCandidates: () => apiFetch<RotationCandidate[]>("/api/treasury/rotation/candidates"),
  getDynamicFeePreview: () => apiFetch<ChannelFeeAdjustment[]>("/api/treasury/fees/dynamic-preview"),
  getLiquidityHealth: () => apiFetch<ChannelLiquidityHealth[]>("/api/treasury/liquidity-health"),
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
  getContacts: () => apiFetch<Contact[]>("/api/contacts"),
  createContact: (body: { pubkey: string; name: string; notes?: string; tags?: string[] }) =>
    apiFetch<{ ok: boolean; contact: Contact }>("/api/contacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateContact: (pubkey: string, body: { name?: string; notes?: string; tags?: string[] }) =>
    apiFetch<{ ok: boolean; contact: Contact }>(`/api/contacts/${pubkey}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteContact: (pubkey: string) =>
    apiFetch<{ ok: boolean }>(`/api/contacts/${pubkey}`, { method: "DELETE" }),
  syncPeers: () =>
    apiFetch<{ ok: boolean; added: number; skipped: number }>("/api/contacts/sync-peers", {
      method: "POST",
    }),
  // Network Payments
  getExchangeRate: () => apiFetch<ExchangeRate>("/api/exchange-rate"),
  getNetworkPayments: (params?: { direction?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.direction) qs.set("direction", params.direction);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return apiFetch<NetworkPayment[]>(`/api/network/payments${q ? `?${q}` : ""}`);
  },
  createNetworkInvoice: (body: { amount_sats: number; memo?: string }) =>
    apiFetch<InvoiceResult>("/api/network/invoice", { method: "POST", body: JSON.stringify(body) }),
  decodeInvoice: (payment_request: string) =>
    apiFetch<DecodedInvoice>("/api/network/decode", { method: "POST", body: JSON.stringify({ payment_request }) }),
  payNetworkInvoice: (payment_request: string) =>
    apiFetch<PaymentResult>("/api/network/pay", { method: "POST", body: JSON.stringify({ payment_request }) }),
  syncSettlements: () =>
    apiFetch<{ ok: boolean; updated: number }>("/api/network/sync-settlements", { method: "POST" }),
};

// ─── Shared helpers ───────────────────────────────────────────────────────

/** Shorten a pubkey to first 12 + last 6 chars for display. */
export function truncPubkey(pk: string): string {
  if (!pk || pk.length < 20) return pk;
  return `${pk.slice(0, 12)}…${pk.slice(-6)}`;
}

export function fmtSats(n: number | undefined | null): string {
  if (n == null) return "— sats";
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

export type NodeBalances = {
  onchain_sats: number;
  lightning_sats: number;
  total_sats: number;
};

export type OnrampUrlResponse = {
  url: string;
  wallet_address: string;
};

export type MemberStats = {
  hub_pubkey: string | null;
  membership_status: string;
  node_role: string;
  is_peered_to_hub: boolean;
  keysend_enabled: boolean;
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

export type PreflightCheck = {
  check: string;
  passed: boolean;
  message: string;
  required: boolean;
};

export type PreflightResult = {
  checks: PreflightCheck[];
  all_passed: boolean;
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

export type CornHistoryEntry = {
  year: number;
  month: number;
  price: number;
};

export type CommodityPrice = {
  price: number;
  unit: string;
  label: string;
  updated_at: string;
} | null;

export type CommodityPrices = {
  gold: CommodityPrice;
  corn: CommodityPrice;
  soybeans: CommodityPrice;
  wheat: CommodityPrice;
};

export type ChannelLiquidityHealth = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sats: number;
  local_sats: number;
  remote_sats: number;
  imbalance_ratio: number;
  health_classification: string;
  velocity_24h_sats: number;
  recommended_action: string;
  is_active: boolean;
};

export type ContactChannel = {
  channel_id: string;
  capacity_sats: number;
  local_sats: number;
  remote_sats: number;
  is_active: boolean;
};

export type Contact = {
  id: number;
  pubkey: string;
  name: string;
  notes: string | null;
  tags: string[];
  source: "auto" | "manual";
  created_at: number;
  updated_at: number;
  channels: ContactChannel[];
};

export type NetworkPayment = {
  id: number;
  payment_hash: string;
  direction: "send" | "receive";
  status: "pending" | "succeeded" | "failed" | "expired";
  amount_sats: number;
  fee_sats: number;
  exchange_rate_usd: number | null;
  amount_usd: number | null;
  memo: string | null;
  counterparty_pubkey: string | null;
  payment_request: string | null;
  created_at: number;
  settled_at: number | null;
};

export type InvoiceResult = {
  payment_hash: string;
  payment_request: string;
  amount_sats: number;
  amount_usd: number | null;
  exchange_rate_usd: number | null;
};

export type DecodedInvoice = {
  id: string;
  destination: string;
  tokens: number;
  description: string | null;
  expires_at: string | null;
};

export type PaymentResult = {
  ok: boolean;
  payment_hash: string;
  amount_sats: number;
  fee_sats: number;
  amount_usd: number | null;
  destination: string;
  memo: string | null;
  error?: string;
};

export type ExchangeRate = { usd: number; source: string };

/** Resolve a pubkey to a contact name, or fall back to truncated pubkey. */
export function resolveContactName(pubkey: string, contacts: Contact[]): string {
  const contact = contacts.find((c) => c.pubkey === pubkey);
  return contact ? contact.name : `${pubkey.slice(0, 12)}…${pubkey.slice(-6)}`;
}


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
