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
    const message = err.detail
      ? `${err.error ?? "Request failed"}: ${err.detail}`
      : (err.error ?? "Request failed");
    throw Object.assign(new Error(message), {
      status: res.status,
      detail: err.detail,
      code: err.error,
      body: err, // full parsed error body — carries the 402 remediation payload
    });
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
  getSubscriptionStatus: () => apiFetch<SubscriptionStatus>("/api/subscription/status"),
  getSubscriptionPayments: () => apiFetch<SubscriptionPaymentsResponse>("/api/subscription/payments"),
  // Pay-from-node modal (the "I have BTC → Pay from this node" path).
  // The POST takes no body — amount + destination are derived
  // server-side from the treasury status; the quote returns the
  // member-local fee estimate for the confirm-step preview.
  getPayFromNodeQuote: () => apiFetch<PayFromNodeQuote>("/api/subscription/pay-from-node/quote"),
  payFromNode: () => apiFetch<PayFromNodeResult>("/api/subscription/pay-from-node", { method: "POST" }),
  getAdminMembers: () => apiFetch<AdminMembersResponse>("/api/admin/members"),
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
  treasuryCloseChannel: (body: { channel_id: string; is_force_close?: boolean; fee_rate?: number }) =>
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

  // Valuation manual inputs (treasury-only)
  getValuationInputStatus: () =>
    apiFetch<ManualMetricStatusResponse>("/api/valuation/manual/status"),
  submitValuationInputs: (body: SubmitValuationInputsRequest) =>
    apiFetch<SubmitValuationInputsResponse>("/api/valuation/manual", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getValuationDay: (date: string) =>
    apiFetch<DayValues>(`/api/valuation/manual/day?date=${encodeURIComponent(date)}`),

  getValuationCalendar: (from: string, to: string) =>
    apiFetch<CalendarSummary>(`/api/valuation/manual/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  submitValuationDay: (req: DaySubmitRequest) =>
    apiFetch<DaySubmitResponse>("/api/valuation/manual", { method: "POST", body: JSON.stringify(req) }),

  refreshValuationWorker: () =>
    apiFetch<{ ok: boolean; worker_status?: number; worker_error?: string | null }>(
      "/api/valuation/refresh-worker",
      { method: "POST" },
    ),

  // ─── Coinbase Auto-Buy ───────────────────────────────────────────────
  getAutoBuyStatus: () =>
    apiFetch<AutoBuyStatus>("/api/autobuy/status"),

  // Auto-Buy failure alerts (Phase 2). Active list (banner, 30s on-page poll),
  // 30-day history (Alerts tab, on-demand), dismissal, and the lightweight
  // badge count (nav badge, 60s app-wide poll).
  getAutoBuyAlerts: () =>
    apiFetch<{ alerts: AutoBuyAlert[] }>("/api/autobuy/alerts").then((r) => r.alerts),
  getAutoBuyAlertHistory: () =>
    apiFetch<{ alerts: AutoBuyAlert[] }>("/api/autobuy/alerts/history").then((r) => r.alerts),
  dismissAutoBuyAlert: (id: number) =>
    apiFetch<{ ok: true; alert: AutoBuyAlert }>(`/api/autobuy/alerts/${id}/dismiss`, { method: "POST" }),
  getAutoBuyAlertBadge: () =>
    apiFetch<AutoBuyAlertBadge>("/api/autobuy/alerts/badge-count"),

  getAutoBuyHistory: (opts?: { limit?: number; offset?: number; status?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    if (opts?.status) qs.set("status", opts.status);
    const q = qs.toString();
    return apiFetch<{ rows: AutoBuyRun[]; total: number; limit: number; offset: number }>(
      `/api/autobuy/history${q ? `?${q}` : ""}`,
    );
  },

  patchAutoBuyConfig: (body: {
    base_unit_usd?: number;
    frequency?: AutoBuyConfig["frequency"];
    zone_multipliers?: AutoBuyZoneMultipliers;
    currency_preference?: CurrencyPreference;
    sweep_day_of_week?: number;
    whitelist_confirmed?: boolean;
  }) =>
    apiFetch<{ ok: true; config: unknown }>("/api/autobuy/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  enableAutoBuy: () =>
    apiFetch<{ ok: true; enabled: true }>("/api/autobuy/enable", { method: "POST" }),

  pauseAutoBuy: () =>
    apiFetch<{ ok: true; enabled: false }>("/api/autobuy/pause", { method: "POST" }),

  executeAutoBuyNow: () =>
    apiFetch<{ ok: true }>("/api/autobuy/execute-now", { method: "POST" }),

  postAutoBuyCredentials: (body: { json_blob: string } | { key_name: string; private_key: string }) =>
    apiFetch<{ ok: true; key_name: string; connected_at: number }>("/api/autobuy/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  deleteAutoBuyCredentials: () =>
    apiFetch<{ ok: true }>("/api/autobuy/credentials", { method: "DELETE" }),

  verifyAutoBuyCredentials: () =>
    apiFetch<{ ok: true; last_verified_at: number; accounts: Array<{ currency: string; available: number }> }>(
      "/api/autobuy/credentials/verify",
      { method: "POST" },
    ),

  getValuationCurrent: () =>
    apiFetch<ValuationCurrent>("/api/valuation/current"),

  getValuationHistory: (opts?: { since?: string; until?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.since) qs.set("since", opts.since);
    if (opts?.until) qs.set("until", opts.until);
    const q = qs.toString();
    return apiFetch<{ series: Array<{ date: string; z_score: number; zone: string; price_usd?: number }> }>(
      `/api/valuation/history${q ? `?${q}` : ""}`,
    );
  },

  getValuationInputs: () =>
    apiFetch<ValuationInputsResponse>("/api/valuation/inputs"),
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

// ─── Subscription status (Stage 5a §5.2) ───────────────────────────────────
// Discriminated by `applicable`. When true, the full subscription payload
// is present. When false, `reason` identifies one of five sub-cases the UI
// branches on.

export type SubscriptionTier =
  | "prepay"
  | "current"
  | "worker_lapsed"
  | "routing_lapsed"
  | "close_due";

export type SubscriptionStatusApplicable = {
  applicable: true;
  member_pubkey: string;
  current_tier: SubscriptionTier;
  paid_through: number;
  price_sats: number;
  period_days: number;
  deposit_address: string;
  last_payment_at: number | null;
  last_payment_txid: string | null;
  grace: {
    /**
     * Pre-payment fresh-onboarding grace deadline (ms epoch). Meaningful
     * only when `last_payment_txid === null` (member hasn't paid yet).
     * After this milestone the row drops from `current` to `prepay`
     * until a payment lands. Added in migration 042.
     */
    fresh_until: number;
    worker_until: number;
    routing_until: number;
    close_at: number;
  };
};

export type SubscriptionNotApplicableReason =
  | "external_peer"
  | "unclassified"
  | "not_yet_allocated"
  | "missing"
  | "no_channel";

export type SubscriptionStatusNotApplicable = {
  applicable: false;
  reason: SubscriptionNotApplicableReason;
  /** Present only when reason === "not_yet_allocated". */
  channel_age_seconds?: number;
};

export type SubscriptionStatus =
  | SubscriptionStatusApplicable
  | SubscriptionStatusNotApplicable;

// Pay-from-node modal (decision 2026-06-11). The quote's amount +
// deposit_address echo the treasury-truth status; estimated_fee_sats is
// the member-local LND fee estimate the treasury can't compute.
export type PayFromNodeQuote = {
  amount_sats: number;
  deposit_address: string;
  estimated_fee_sats: number;
};

export type PayFromNodeResult = {
  txid: string;
};

// ─── Subscription payment history (Stage 5a follow-up) ───────────────────

export type SubscriptionPaymentStatus =
  | "confirmed"      // on-chain receipt with confirmed_at set
  | "pending"        // on-chain receipt seen but not yet confirmed
  | "admin_override"; // grandfather sentinel or operator manual extension

export type SubscriptionPaymentRow = {
  id: number;
  txid: string | null;
  vout: number | null;
  amount_sats: number;
  amount_usd_cents_at_receipt: number | null;
  received_at: number;
  confirmed_at: number | null;
  period_extension_days: number;
  kind: "onchain" | "admin_override";
  admin_reason: string | null;
  status: SubscriptionPaymentStatus;
};

export type SubscriptionPaymentsResponse = {
  member_pubkey: string;
  payments: SubscriptionPaymentRow[];
};

// ─── Admin members list (Stage 5b) ─────────────────────────────────

export type LanePurpose =
  | "merchant_lane"
  | "farmer_lane"
  | "external_peer"
  | "unclassified";

export type SubscriptionStateKey =
  | "current"
  | "prepay"
  | "worker_lapsed"
  | "routing_lapsed"
  | "close_due"
  | "external_peer"
  | "unclassified"
  | "not_yet_allocated"
  | "missing"
  | "no_channel";

export type AdminMembersRow = {
  member_pubkey: string;
  lane_purpose: LanePurpose;
  subscription_state: SubscriptionStateKey;
  current_tier: SubscriptionTier | null;
  paid_through: number | null;
  last_payment_at: number | null;
  last_payment_amount_sats: number | null;
};

export type AdminMembersResponse = {
  fetched_at: number;
  members: AdminMembersRow[];
  totals: {
    total_members: number;
    by_state: Record<SubscriptionStateKey, number>;
  };
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

// ─── Valuation manual input types (treasury-only) ─────────────────────────

export type ManualMetricKey =
  | "mvrv"
  | "puell"
  | "sopr"
  | "reserve_risk"
  | "nvt"
  | "hash_ribbons"
  | "difficulty_ribbon"
  | "miner_outflows"
  | "hodl_waves";

export type ManualMetricStatus = {
  metric_key: ManualMetricKey;
  value: number | null;
  submitted_at: number | null;        // unix seconds
  worker_sync_status: "pending" | "confirmed" | "failed" | null;
  worker_sync_error: string | null;
  worker_sync_at: number | null;
};

export type ManualMetricStatusResponse = {
  metrics: ManualMetricStatus[];
};

export type SubmitValuationInputsRequest = {
  values: Record<ManualMetricKey, number>;
};

// 200 on full success, 207 on local-saved-but-worker-failed (apiFetch treats
// both as success). Distinguish via `ok`.
export type SubmitValuationInputsResponse =
  | { ok: true; submitted_at: string }
  | {
      ok: false;
      submitted_at: string;
      local_saved: true;
      worker_error: string | null;
      worker_status: number;
    };

export interface DayMetricStatus {
  value: number | null;
  submitted_at: number | null;
  worker_sync_status: "pending" | "confirmed" | "failed" | null;
}

export interface DayValues {
  date: string;
  metrics: Record<ManualMetricKey, DayMetricStatus>;
}

export interface CalendarSummary {
  from: string;
  to: string;
  days: Record<string, { filled: number; total: number }>;
}

export interface DaySubmitRequest {
  date: string;
  values?: Partial<Record<ManualMetricKey, number>>;
  delete?: ManualMetricKey[];
}

export interface DaySubmitResponse {
  ok: boolean;
  date: string;
  submitted_at: string;
  local_saved?: boolean;
  worker_error?: string | null;
  worker_status?: number;
}

// ─── Coinbase Auto-Buy ─────────────────────────────────────────────────

export type AutoBuyZoneMultipliers = {
  extreme_buy: number;
  undervalued: number;
  fair_value: number;
  elevated: number;
  overvalued: number;
  extreme_sell: number;
};

export type CurrencyPreference = "usd_only" | "usdc_only" | "usd_preferred" | "usdc_preferred";

export type AutoBuyConfig = {
  enabled: boolean;
  base_unit_usd: number;
  frequency: "daily" | "weekly" | "biweekly" | "monthly";
  zone_multipliers: AutoBuyZoneMultipliers;
  currency_preference: CurrencyPreference;
  withdraw_address: string;
  withdraw_address_whitelisted_at: number | null;
  sweep_day_of_week: number;
  consecutive_failures: number;
  paused_reason: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
};

export type AutoBuyCredentialsInfo = {
  key_name: string;
  connected_at: number;
  last_verified_at: number | null;
};

export type AutoBuyRun = {
  id: number;
  scheduled_for: number;
  z_score: number | null;
  zone: string | null;
  multiplier: number | null;
  base_unit_usd: number | null;
  intended_buy_usd: number | null;
  status: string;
  coinbase_order_id?: string | null;
  filled_btc?: number | null;
  filled_usd?: number | null;
  filled_at?: number | null;
  withdraw_txid?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  currencies_checked?: string | null;
  currency_used?: string | null;
  created_at?: number;
  updated_at?: number;
};

export type AutoBuyStatus = {
  config: AutoBuyConfig | null;
  credentials: AutoBuyCredentialsInfo | null;
  in_flight: AutoBuyRun[];
  recent: AutoBuyRun[];
};

// Auto-Buy failure alerts (Phase 2). Reuses the shared AlertSeverity, but the
// stored model is narrowed to warning|critical (the API never emits info).
export type AutoBuyAlertType =
  | "AUTOBUY_INSUFFICIENT_FUNDS"
  | "AUTOBUY_AUTH_FAILURE"
  | "AUTOBUY_RATE_LIMITED"
  | "AUTOBUY_ORDER_FAILED"
  | "AUTOBUY_SWEEP_FAILED";

export type AutoBuyAlert = {
  id: number;
  type: AutoBuyAlertType | string;
  severity: Extract<AlertSeverity, "warning" | "critical">;
  status: "active" | "resolved" | "dismissed";
  consecutive_count: number;
  latest_run_id: number | null;
  context: Record<string, unknown> | null;
  created_at: number; // epoch seconds
  updated_at: number;
  resolved_at?: number | null;
  dismissed_at?: number | null;
};

export type AutoBuyAlertBadge = {
  active_count: number;
  highest_severity: "warning" | "critical" | null;
};

export type ValuationZone = "extreme_buy" | "undervalued" | "fair_value" | "elevated" | "overvalued" | "extreme_sell";

export type ValuationDistributionStats = {
  mean: number;
  std_dev: number;
  min_z: number;
  max_z: number;
  min_z_date: string; // ISO yyyy-mm-dd
  max_z_date: string;
  n: number;
};

export type ValuationCurrent = {
  z_score: number;
  zone: ValuationZone;
  updated_at: string;
  price_usd?: number;
  // Populated after the first cron run with ≥1 historical datapoint. Drives
  // the Distribution Statistics panel + historical percentile hero card.
  stats?: ValuationDistributionStats;
};

export type ValuationInput = {
  value: number | null;
  z: number | null;
  weight: number;
  updated_at: string | null;
  category?: string;
  source?: string;
};

export type ValuationInputsResponse = Record<string, ValuationInput>;
