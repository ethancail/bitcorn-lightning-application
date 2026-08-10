// TypeScript types for the stablecoin rail's HTTP surface.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md
//
// The HTTP types are conservative — strings everywhere bigint would
// overflow JSON (USDC amounts, fees, raw balances), explicit nullability
// for fields that come from cache rows that may not exist yet. The
// frontend (Phase 2 PR) parses bigints back from these strings.

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
    /**
     * Classified by classifyRailStaleness (the rail's 3/15-min thresholds), so
     * it carries the RAIL label type — matching what the web client already
     * declared for this field (web client.ts BalanceResponse). It was typed as
     * the generic base/staleness.ts StalenessLabel here only because the two
     * unions happened to be identical before `never_synced` existed; the
     * mismatch was latent, not intentional.
     *
     * `never_synced` is unreachable in practice for a BALANCE: the cache row is
     * only ever written on a successful read, so as_of_at is always > 0. The
     * union is widened to match the classifier's real return type rather than to
     * describe a reachable state.
     */
    staleness_label: RailStalenessLabel;
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

export type RailStalenessLabel = "never_synced" | "fresh" | "stale" | "very_stale";

export interface SyncCursorResponse {
    last_synced_block_number: number;
    /**
     * Alias of `last_success_at`, kept for wire compatibility with an older web
     * bundle. Migration 053 split attempt from success; this field carries the
     * SUCCESS timestamp, which is what it always claimed to mean.
     */
    last_synced_at: number;
    /** Last tick that proved the Settled stream current (migration 053). */
    last_success_at: number;
    /**
     * Last tick that RAN. Diagnostic — deliberately NOT what the staleness
     * banner reads, because liveness is not freshness. Surfaced so an operator
     * can distinguish "the loop is dead" from "the loop is alive but the stream
     * is stuck" without shelling into the container.
     */
    last_attempt_at: number;
    /** 0 when never synced — there is no meaningful age to report. */
    staleness_seconds: number;
    /**
     * The §7 rail-specific label using 3-minute / 15-minute thresholds, plus the
     * distinct `never_synced` state for a cursor that has no successful sync on
     * record. Distinct from base/staleness.ts's general 5min/30min thresholds —
     * the rail-frontend amendment locked tighter thresholds for the banner.
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
    amount_units_raw: string; // bigint serialized — GROSS, pulled from the sender
    fee_units_raw: string; // bigint serialized
    /**
     * What the RECIPIENT was actually credited: `amount - fee`, in base
     * units. The Settled event emits gross and fee only, so this is
     * derived — see toSettlementRow(). The contract computes the same
     * quantity as `netToRecipient` (SettlementRouter.sol:267) and
     * transfers exactly it, so this is an exact integer identity, not an
     * estimate.
     *
     * Deliberately has NO `net_human` sibling. The two-decimal
     * `*_human` fields are truncated (formatUsdcUnits), and a truncated
     * net does not reconcile against a truncated gross and fee: at 25bps
     * on 45001.00 USDC the three render as 45001.00 / 112.50 / 44888.49,
     * where the displayed subtraction gives 44888.50. Emitting a 2dp net
     * would invite consumers to reproduce that contradiction. Consumers
     * that display net should format from these base units at the
     * precision their surface needs.
     */
    net_units_raw: string; // bigint serialized
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

// ─── GET /api/admin/rail/fee-revenue (treasury-only) ─────────────────────

/** One aggregation bucket. See stablecoin/feeRevenue.ts for what it means. */
export interface RailFeeTotals {
    /** Exact sum in USDC base units, decimal string. This is the contract. */
    fee_units_raw: string;
    /** Truncated to 2dp by formatUsdcUnits — display only, never arithmetic. */
    fee_human: string;
    gross_units_raw: string;
    gross_human: string;
    settlement_count: number;
}

export interface RailFeeWindowTotals extends RailFeeTotals {
    /** Inclusive block range actually counted, stated so no reader has to
     *  trust the word "24h" — the window is block-keyed, not time-keyed. */
    from_block: number;
    to_block: number;
}

export interface RailFeeRevenueResponse {
    all_time: RailFeeTotals;
    last_24h: RailFeeWindowTotals;
    /** Deliberately in the same payload as the numbers: a figure is only a
     *  fact when the cursor is fresh. */
    freshness: {
        last_synced_block_number: number;
        /** 0 is the never-synced sentinel, not a timestamp. */
        last_success_at: number;
        staleness_seconds: number;
        staleness_label: RailStalenessLabel;
    };
    /** Fees were DELIVERED, not merely accrued — the Settled event is emitted
     *  after the fee transfer and SafeERC20 reverts on failure. Sweeps are not
     *  tracked, so this is cumulative delivery, not a balance. */
    basis: "delivered";
    /** CURRENT fee recipient. Does NOT describe historical attribution. */
    fee_recipient_address: string | null;
    currency: "USDC";
    decimals: number;
}
