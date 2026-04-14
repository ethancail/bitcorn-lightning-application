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
  getNodeAddress: () => apiFetch<{ address: string }>("/api/node/address"),
  getOnChainStatus: () => apiFetch<OnChainStatus>("/api/node/onchain-status"),
  getCoinbaseOnrampUrl: () => apiFetch<OnrampUrlResponse>("/api/coinbase/onramp-url"),
  getCommodityPrices: () => apiFetch<CommodityPrices>("/api/commodity-prices"),
  getCornHistory: () => apiFetch<CornHistoryEntry[]>("/api/corn-history"),
  getTreasuryInfo: () => apiFetch<TreasuryInfo>("/api/treasury-info"),
  getMemberStats: () => apiFetch<MemberStats>("/api/member/stats"),
  getNodePreflight: () => apiFetch<PreflightResult>("/api/node/preflight"),
  openMemberChannel: (body: { capacity_sats: number; partner_socket?: string; fee_rate?: number }) =>
    apiFetch<{ ok: boolean; funding_txid: string | null }>("/api/member/open-channel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getTreasuryMetrics: () => apiFetch<TreasuryMetrics>("/api/treasury/metrics"),
  getAlerts: () => apiFetch<TreasuryAlert[]>("/api/treasury/alerts"),
  getChannelMetrics: () => apiFetch<ChannelMetric[]>("/api/treasury/channel-metrics"),
  getPeerScores: () => apiFetch<PeerScore[]>("/api/treasury/peers/performance"),
  getLivePeers: () => apiFetch<LivePeer[]>("/api/treasury/peers/live"),
  connectPeer: (body: { pubkey?: string; address?: string; uri?: string }) =>
    apiFetch<{ ok: boolean; pubkey: string; address: string }>("/api/treasury/peers/connect", {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
  deletePayment: (id: number) =>
    apiFetch<{ ok: boolean; deleted_id: number }>(`/api/network/payments/${id}`, { method: "DELETE" }),
  // Member Liquidity Advisor (member node)
  getMemberLiquidityStatus: () => apiFetch<MemberLiquidityStatusResponse>("/api/liquidity/status"),
  setChannelRole: (channel_role: "merchant" | "farmer" | "unknown") =>
    apiFetch<{ ok: boolean; channel_role: string }>("/api/liquidity/config", {
      method: "PATCH",
      body: JSON.stringify({ channel_role }),
    }),
  getMemberLiquidityHistory: (channelId: string, limit?: number) => {
    const qs = new URLSearchParams({ channelId });
    if (limit) qs.set("limit", String(limit));
    return apiFetch<MemberLiquidityHistoryResponse>(`/api/liquidity/history?${qs}`);
  },
  // Member Liquidity (treasury-only)
  getLiquidityClusters: () => apiFetch<LiquidityClustersResponse>("/api/member-liquidity/clusters"),
  getLiquidityRecommendations: () => apiFetch<LiquidityRecommendationsResponse>("/api/member-liquidity/recommendations"),
  getLiquidityEstimate: (recId: string) =>
    apiFetch<LiquidityEstimateResponse>(`/api/member-liquidity/recommendations/${recId}/estimate`),
  approveLiquidity: (recId: string, estimateId: string) =>
    apiFetch<LiquidityApproveResponse>(`/api/member-liquidity/recommendations/${recId}/approve`, {
      method: "POST",
      body: JSON.stringify({ estimateId }),
    }),
  rejectLiquidity: (recId: string) =>
    apiFetch<{ ok: boolean }>(`/api/member-liquidity/recommendations/${recId}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  getLiquidityOutcomes: (params?: { clusterId?: string; status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.clusterId) qs.set("clusterId", params.clusterId);
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return apiFetch<LiquidityOutcomesResponse>(`/api/member-liquidity/outcomes${q ? `?${q}` : ""}`);
  },
  // Pending channels
  getPendingChannels: () => apiFetch<PendingChannel[]>("/api/channels/pending"),
  // Treasury channel operations
  treasuryOpenChannel: (body: { peer_pubkey: string; capacity_sats: number; is_private?: boolean; fee_rate?: number }) =>
    apiFetch<{ ok: boolean; funding_txid: string | null }>("/api/treasury/expansion/execute", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  treasuryCloseChannel: (body: { channel_id: string; is_force_close?: boolean }) =>
    apiFetch<{ ok: boolean; closing_txid: string | null }>("/api/treasury/rotation/execute", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Recommended peers
  getRecommendedPeers: () => apiFetch<RecommendedPeer[]>("/api/network/recommended-peers"),
  openRecommendedChannel: (peerId: string, localFundingAmountSat: number) =>
    apiFetch<OpenRecommendedChannelResult>("/api/lightning/open-recommended-channel", {
      method: "POST",
      body: JSON.stringify({ peer_id: peerId, local_funding_amount_sat: localFundingAmountSat }),
    }),
  // Swaps — member
  getSwapLoopOutQuote: (body: { amount_sat: number; destination_address?: string; max_fee_sat?: number }) =>
    apiFetch<SwapQuoteResponse>("/api/swaps/loop-out/quote", { method: "POST", body: JSON.stringify(body) }),
  initiateSwapLoopOut: (body: { swap_request_id: string; destination_address: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/swaps/loop-out", { method: "POST", body: JSON.stringify(body) }),
  // Loop In (member refill)
  getSwapLoopInQuote: (body: { amount_sat: number }) =>
    apiFetch<SwapQuoteResponse>("/api/swaps/loop-in/quote", { method: "POST", body: JSON.stringify(body) }),
  initiateSwapLoopIn: (body: { swap_request_id: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/swaps/loop-in", { method: "POST", body: JSON.stringify(body) }),
  getSwap: (id: string) => apiFetch<SwapDetailResponse>(`/api/swaps/${id}`),
  getSwapHistory: (limit?: number) => {
    const q = limit ? `?limit=${limit}` : "";
    return apiFetch<{ swaps: SwapRequest[] }>(`/api/swaps/history${q}`);
  },
  // Swaps — admin
  adminLoopOutQuote: (body: { amount_sat: number; channel_id?: string }) =>
    apiFetch<SwapQuoteResponse>("/api/admin/swaps/loop-out/quote", { method: "POST", body: JSON.stringify(body) }),
  adminLoopOut: (body: { swap_request_id: string; destination_address?: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/admin/swaps/loop-out", { method: "POST", body: JSON.stringify(body) }),
  // adminLoopInQuote / adminLoopIn — removed from active architecture (v1.7.1).
  // Treasury-INITIATED Loop In endpoints return 410 (treasury maintains its own inbound
  // via Loop OUT on external channels). Member-side Loop In (a merchant refilling their
  // own channel) is a different flow — see /api/swaps/loop-in when implemented.
  adminSwapList: (limit?: number) => {
    const q = limit ? `?limit=${limit}` : "";
    return apiFetch<{ swaps: SwapRequest[] }>(`/api/admin/swaps${q}`);
  },
  adminGetSwap: (id: string) => apiFetch<SwapDetailResponse>(`/api/admin/swaps/${id}`),
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

export type LivePeer = {
  pubkey: string;
  address: string;
  bytes_sent: number;
  bytes_received: number;
  is_inbound: boolean;
  ping_time: number;
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

export type OnChainDeposit = {
  tx_hash: string;
  amount_sat: number;
  confirmations: number;
  is_confirmed: boolean;
  block_height: number | null;
  time_stamp: string;
};

export type OnChainStatus = {
  confirmed_balance_sat: number;
  pending_balance_sat: number;
  recent_deposits: OnChainDeposit[];
};

export type OnrampUrlResponse = {
  url: string;
  wallet_address: string;
};

export type TreasuryInfo = {
  pubkey: string | null;
  socket: string | null;
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

// ─── Member Liquidity types ──────────────────────────────────────────────

export type LiquidityCluster = {
  clusterId: string;
  label: string;
  peerPubkey: string;
  policyRole: string;
  totalCapacitySats: number;
  localBalanceSats: number;
  remoteBalanceSats: number;
  localPct: number;
  targetMinPct: number;
  targetMidPct: number;
  targetMaxPct: number;
  deviationDirection: "below" | "above" | "inside";
  deviationPct: number;
  channelCount: number;
  activeChannelCount: number;
};

export type LiquidityClustersResponse = { clusters: LiquidityCluster[] };

export type LiquidityRecommendation = {
  recommendationId: string;
  clusterId: string;
  actionType: "treasury_push_topup";
  triggerReason: string;
  suggestedAmountSats: number;
  projectedLocalPct: number | null;
  status: string;
  rejectedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type LiquidityRecommendationsResponse = { recommendations: LiquidityRecommendation[] };

export type LiquidityEstimate = {
  estimateId: string;
  recommendationId: string;
  amountSats: number;
  projectedTreasuryLocalPct: number;
  projectedMemberLocalPct: number;
  estimatedRoutingFeeSats: number;
  estimatedAt: number;
  estimateTtlSeconds: number;
};

export type LiquidityEstimateResponse = { estimate: LiquidityEstimate };

export type LiquidityOutcome = {
  outcomeId: string;
  recommendationId: string;
  clusterId: string;
  actionType: string;
  status: string;
  actualAmountSats: number | null;
  actualFeeSats: number | null;
  paymentHash: string | null;
  executionMethod: string | null;
  failureReason: string | null;
  executedAt: number;
};

export type LiquidityOutcomesResponse = { outcomes: LiquidityOutcome[] };

export type LiquidityApproveResponse = { outcome: LiquidityOutcome };

// ─── Member Liquidity Advisor types (member node) ────────────────────────

export type MemberChannelState =
  | "healthy"
  | "send_heavy"
  | "send_saturated"
  | "receive_heavy"
  | "receive_exhausted";

export type MemberChannelRole = "unknown" | "merchant" | "farmer";

export type MemberChannelClassification = {
  channelId: string;
  capacitySat: number;
  memberLocalSat: number;
  treasuryLocalSat: number;
  memberLocalPct: number;
  state: MemberChannelState;
  urgency: "none" | "low" | "medium" | "high";
  consecutiveNonHealthyRuns: number;
  classifiedAt: number;
  channelRole: MemberChannelRole;
};

export type MemberLiquidityRecommendation = {
  action: "none" | "loop_out" | "loop_in" | "channel_upgrade" | "manual_recovery" | "set_role";
  suggestedAmountSats: number | null;
  projectedMemberLocalPct: number | null;
  reason: string;
  urgency: "none" | "low" | "medium" | "high";
  loopAvailable: boolean;
  generatedAt: number;
};

export type MemberLoopAvailability = {
  loopDaemonRunning: boolean;
  loopOutAvailable: boolean;
  loopInAvailable: boolean;
  loopOutTerms: { minSats: number; maxSats: number } | null;
  loopInTerms: { minSats: number; maxSats: number } | null;
};

export type MemberLiquidityStatusResponse = {
  classification: MemberChannelClassification | null;
  recommendation: MemberLiquidityRecommendation | null;
  loopAvailability: MemberLoopAvailability;
};

export type MemberLiquidityHistoryResponse = {
  history: MemberChannelClassification[];
};

// ─── Pending channels ─────────────────────────────────────────────────

export type PendingChannel = {
  peer_pubkey: string;
  capacity_sat: number;
  status: string;
};

// ─── Recommended peers ────────────────────────────────────────────────

export type RecommendedPeerChannel = {
  channel_id: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: boolean;
};

export type RecommendedPeer = {
  id: string;
  label: string;
  pubkey: string;
  socket: string;
  description: string;
  recommended_channel_size_sat: number;
  advanced: boolean;
  connected: boolean;
  has_channel: boolean;
  channels: RecommendedPeerChannel[];
};

export type OpenRecommendedChannelResult = {
  ok: boolean;
  peer_id: string;
  peer_label: string;
  funding_txid: string | null;
};

// ─── Swap types ───────────────────────────────────────────────────────────

export type SwapRequest = {
  id: string;
  created_at: number;
  updated_at: number;
  node_pubkey: string;
  role: string;
  swap_type: string;
  direction: string;
  status: string;
  amount_sat: number;
  max_fee_sat: number | null;
  quoted_fee_sat: number | null;
  actual_fee_sat: number | null;
  destination_address: string | null;
  channel_id: string | null;
  quote_expires_at: number | null;
  failure_reason: string | null;
  notes: string | null;
};

export type SwapExecution = {
  id: string;
  swap_request_id: string;
  provider: string;
  provider_swap_id: string | null;
  status: string;
  raw_provider_status: string | null;
  onchain_txid: string | null;
  sweep_txid: string | null;
  started_at: number;
  completed_at: number | null;
};

export type SwapEvent = {
  id: string;
  event_type: string;
  event_json: string;
  created_at: number;
};

export type SwapQuoteResponse = {
  swap_request: SwapRequest;
  quote: {
    amount_sat: number;
    swap_fee_sat: number;
    total_fee_sat: number;
    conf_target: number;
    prepay_sat?: number;
    miner_fee_sat?: number;
    htlc_publish_fee_sat?: number;
  };
  policy_check: { ok: true } | { ok: false; reason: string; code: string };
};

export type SwapDetailResponse = {
  swap_request: SwapRequest;
  execution: SwapExecution | null;
  events: SwapEvent[];
};

/** Resolve a pubkey to a contact name, or fall back to truncated pubkey. */
export function resolveContactName(pubkey: string, contacts: Contact[]): string {
  if (!pubkey) return "—";
  const contact = contacts.find((c) => c.pubkey === pubkey);
  return contact ? contact.name : truncPubkey(pubkey);
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
