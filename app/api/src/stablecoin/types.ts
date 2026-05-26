// TypeScript types for the stablecoin rail's HTTP surface.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md
//
// The HTTP types are conservative — strings everywhere bigint would
// overflow JSON (USDC amounts, fees, raw balances), explicit nullability
// for fields that come from cache rows that may not exist yet. The
// frontend (Phase 2 PR) parses bigints back from these strings.

import type { StalenessLabel } from "../base/staleness";

export interface SiweChallengeNonceRow {
    id: number;
    memberPubkey: string;
    walletAddress: string;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
}

// ─── /api/stablecoin/wallet/challenge ────────────────────────────────────

export interface ChallengeRequest {
    wallet_address: string;
}

export interface ChallengeResponse {
    /** Full EIP-4361 SIWE message to be signed by the member's wallet. */
    message: string;
    /** Same nonce surfaced separately for client-side display. */
    nonce: string;
    /** Unix ms; the signature must be submitted before this. */
    expires_at: number;
}

// ─── POST /api/stablecoin/wallet ─────────────────────────────────────────

export interface WalletRegisterRequest {
    /** The signed SIWE message (verbatim what the wallet signed). */
    message: string;
    /** Hex-encoded ECDSA signature returned by the wallet. */
    signature: string;
}

export interface WalletRegisterResponse {
    wallet_address: string;
    registered_at: number;
}

// ─── GET /api/stablecoin/wallet ──────────────────────────────────────────

export interface WalletStatusResponse {
    wallet_address: string | null;
    registered_at: number | null;
    is_active: boolean;
}

// ─── GET /api/stablecoin/balance ─────────────────────────────────────────

export interface BalanceResponse {
    wallet_address: string;
    balance_units_raw: string; // bigint serialized
    decimals: number;
    balance_human: string;
    as_of_block_number: number;
    as_of_at: number;
    staleness_seconds: number;
    staleness_label: StalenessLabel;
}

// ─── GET /api/stablecoin/contract-state ──────────────────────────────────

export interface ContractStateResponse {
    settlement_router_address: string;
    current_fee_bps: number;
    is_paused: boolean;
    fee_recipient_address: string;
    as_of_block_number: number;
    as_of_at: number;
}

// ─── GET /api/stablecoin/sync-cursor ─────────────────────────────────────

export type RailStalenessLabel = "fresh" | "stale" | "very_stale";

export interface SyncCursorResponse {
    last_synced_block_number: number;
    last_synced_at: number;
    staleness_seconds: number;
    /**
     * The §7 rail-specific three-state label using 3-minute / 15-minute
     * thresholds. Distinct from base/staleness.ts's general 5min/30min
     * thresholds — the rail-frontend amendment locked tighter thresholds
     * for the staleness banner.
     */
    staleness_label: RailStalenessLabel;
}

// ─── GET /api/stablecoin/settlements ─────────────────────────────────────

export interface SettlementRow {
    block_number: number;
    tx_hash: string;
    log_index: number;
    sender_address: string;
    recipient_address: string;
    amount_units_raw: string; // bigint serialized
    fee_units_raw: string; // bigint serialized
    amount_human: string;
    fee_human: string;
    trade_ref: string;
    settled_at: number;
    discovered_at: number;
    /** "sent" or "received" relative to the member's registered wallet. */
    direction: "sent" | "received";
}

export interface SettlementsResponse {
    settlements: SettlementRow[];
    /** Page cursor — next page would query `?before_block=<this>`. Null if no more. */
    next_before_block: number | null;
}
