// TypeScript types for the BASE sync subsystem.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7
//
// Numeric values from on-chain (balances, fee amounts) are kept as
// `bigint` in memory and serialized to TEXT in SQLite. The Worker
// returns them as decimal strings via its ABI decoder; this module
// parses to bigint, stores as string, never as Number (USDC at 6
// decimals stays within int64 but defensively avoiding float precision
// loss is cheaper than a future debugging session).

export interface MemberBaseWalletRow {
    id: number;
    memberPubkey: string;
    walletAddress: string; // always lowercased on write
    registeredAt: number;
    isActive: boolean;
}

export interface BaseSyncCursorRow {
    lastSyncedBlockNumber: number;
    lastSyncedAt: number;
}

export interface BaseUsdcBalanceCacheRow {
    walletAddress: string;
    balanceUnits: bigint;
    asOfBlockNumber: number;
    asOfAt: number;
}

export interface BaseSettlementEventRow {
    id: number;
    blockNumber: number;
    txHash: string;
    logIndex: number;
    senderAddress: string;
    recipientAddress: string;
    amountUnits: bigint;
    feeUnits: bigint;
    tradeRef: string;
    settledAt: number;
    discoveredAt: number;
}

export interface BaseContractStateCacheRow {
    settlementRouterAddress: string;
    currentFeeBps: number;
    isPaused: boolean;
    feeRecipientAddress: string;
    asOfBlockNumber: number;
    asOfAt: number;
}

// ─── Worker response shapes (mirror the Worker's handler outputs) ─────

export interface WorkerContractInfoResponse {
    chain_id: number | null;
    settlement_router_address: string | null;
    settlement_router_deploy_block: number | null;
    usdc_token_address: string | null;
    current_fee_bps: number | null;
    is_paused: boolean | null;
    as_of_block_number: number | null;
    rpc_status: "ok" | "unconfigured" | "upstream_error";
}

export interface WorkerContractStateResponse {
    contract: string;
    signature: string;
    result: string | number | boolean | unknown;
    as_of_block_number: number;
}

export interface WorkerBalanceResponse {
    address: string;
    token: string;
    token_symbol: string | null;
    balance_raw: string;
    decimals: number;
    balance_human: string;
    as_of_block_number: number;
}

// Shape returned by POST /base/events (Worker PR #199). The Worker decodes
// each log against the requested event's spec and returns a `decoded` object
// whose keys depend on the event. For Settled, the keys are the five fields
// below (snake_case to match the Worker's serialization).
export interface DecodedSettledFields {
    sender: string;
    recipient: string;
    trade_ref: string;
    amount: string; // bigint as decimal string
    fee: string; // bigint as decimal string
}

export interface DecodedLog {
    block_number: number;
    tx_hash: string;
    log_index: number;
    decoded: Record<string, string | number | boolean>;
}

export interface WorkerEventsResponse {
    event: string;
    contract: string;
    from_block: number;
    to_block: number;
    logs: DecodedLog[];
    decode_errors: Array<{ tx_hash: string; log_index: string; error: string }>;
    as_of_block_number: number;
}

// ─── Sync loop result type (for logging + the future /api/base/* admin endpoints) ─────

export interface SyncTickResult {
    started_at: number;
    finished_at: number;
    skipped_reason?: "in_progress" | "no_wallets" | "worker_not_configured";
    wallets_attempted: number;
    wallets_succeeded: number;
    wallets_failed: number;
    contract_state_synced: boolean;
    cursor_advanced_to?: number;
    // ─── Step 5 (event sync) per PR #200 ───
    events_processed: number; // count of Settled rows newly written this tick
    events_already_indexed: number; // duplicates skipped by UNIQUE(tx_hash, log_index)
    decode_errors_count: number; // malformed logs surfaced by the Worker
    event_chunks_attempted: number; // number of /base/events calls in this tick
    errors: Array<{ context: string; error: string }>;
}
