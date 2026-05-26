// Stablecoin rail HTTP client extensions.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md
//
// Reuses ../api/client.ts's apiFetch wrapper. No JWT/Bearer auth — the
// /api/stablecoin/* endpoints follow the same local-network trust model as
// the subscription endpoints (member identity derived server-side from the
// local LND pubkey via getNodeInfo()).
//
// Types mirror app/api/src/stablecoin/types.ts byte-for-byte — bigint amounts
// are wire-serialized as strings to survive JSON; the frontend parses them
// back via BigInt() at display time when arithmetic is needed.

import { API_BASE } from "../config/api";

export type RailStalenessLabel = "fresh" | "stale" | "very_stale";

export interface ChallengeRequest {
  wallet_address: string;
}

export interface ChallengeResponse {
  message: string;
  nonce: string;
  expires_at: number;
}

export interface WalletRegisterRequest {
  message: string;
  signature: string;
}

export interface WalletRegisterResponse {
  wallet_address: string;
  registered_at: number;
}

export interface WalletStatusResponse {
  wallet_address: string | null;
  registered_at: number | null;
  is_active: boolean;
}

export interface BalanceResponse {
  wallet_address: string;
  balance_units_raw: string;
  decimals: number;
  balance_human: string;
  as_of_block_number: number;
  as_of_at: number;
  staleness_seconds: number;
  staleness_label: RailStalenessLabel;
}

export interface ContractStateResponse {
  settlement_router_address: string;
  current_fee_bps: number;
  is_paused: boolean;
  fee_recipient_address: string;
  as_of_block_number: number;
  as_of_at: number;
}

export interface SyncCursorResponse {
  last_synced_block_number: number;
  last_synced_at: number;
  staleness_seconds: number;
  staleness_label: RailStalenessLabel;
}

export interface SettlementRow {
  block_number: number;
  tx_hash: string;
  log_index: number;
  sender_address: string;
  recipient_address: string;
  amount_units_raw: string;
  fee_units_raw: string;
  amount_human: string;
  fee_human: string;
  trade_ref: string;
  settled_at: number;
  discovered_at: number;
  direction: "sent" | "received";
}

export interface SettlementsResponse {
  settlements: SettlementRow[];
  next_before_block: number | null;
}

async function railFetch<T>(path: string, options?: RequestInit): Promise<T> {
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
    });
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const stablecoinApi = {
  getWalletStatus: () =>
    railFetch<WalletStatusResponse>("/api/stablecoin/wallet"),

  requestChallenge: (walletAddress: string) =>
    railFetch<ChallengeResponse>("/api/stablecoin/wallet/challenge", {
      method: "POST",
      body: JSON.stringify({ wallet_address: walletAddress }),
    }),

  registerWallet: (message: string, signature: string) =>
    railFetch<WalletRegisterResponse>("/api/stablecoin/wallet", {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    }),

  unregisterWallet: () =>
    railFetch<void>("/api/stablecoin/wallet", { method: "DELETE" }),

  getBalance: () => railFetch<BalanceResponse>("/api/stablecoin/balance"),

  getContractState: () =>
    railFetch<ContractStateResponse>("/api/stablecoin/contract-state"),

  getSyncCursor: () =>
    railFetch<SyncCursorResponse>("/api/stablecoin/sync-cursor"),

  getSettlements: (params?: { beforeBlock?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.beforeBlock !== undefined) {
      qs.set("before_block", String(params.beforeBlock));
    }
    if (params?.limit !== undefined) {
      qs.set("limit", String(params.limit));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    return railFetch<SettlementsResponse>(`/api/stablecoin/settlements${suffix}`);
  },
};
