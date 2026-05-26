// The BASE sync loop.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7
//
// Runs in the API container at ~60s cadence. Each tick:
//   1. Reads /base/contract-info (block number + governance state).
//   2. Resolves feeRecipient() via /base/contract-state and upserts
//      base_contract_state_cache.
//   3. For every active wallet in member_base_wallet, calls /base/balance
//      and upserts base_usdc_balance_cache.
//   4. Advances base_sync_cursor.last_synced_block_number to the latest
//      block observed during the tick.
//
// Step 3 of the spec (Settled events via eth_getLogs) is intentionally
// SKIPPED in v1: PR #197 didn't add an /base/events Worker endpoint and
// a session has been allocated to add it later. base_settlement_event
// stays empty until that lands. The other four pieces of state (block
// cursor, governance state, per-wallet balances, fee recipient) are
// what the §8 UI needs at v1.
//
// Concurrency: the in-progress flag prevents overlapping ticks. A slow
// RPC round-trip won't cause the next setInterval fire to compound the
// load — the next tick skips, the one after that runs normally.
//
// Failure isolation: a failure on one wallet's balance fetch does NOT
// abort the tick. The other wallets are still polled, the contract
// state is still written, and the cursor still advances. The failure is
// recorded in the tick result for logging.

import {
    fetchContractInfo,
    fetchFeeRecipient,
    fetchSettledEvents,
    fetchUsdcBalance,
    BaseWorkerError,
} from "./workerClient";
import {
    advanceSyncCursor,
    getSyncCursor,
    listActiveBaseWallets,
    upsertContractState,
    upsertSettlementEvent,
    upsertUsdcBalance,
} from "./store";
import type { DecodedSettledFields, SyncTickResult } from "./types";
import { ENV } from "../config/env";

// Max blocks per /base/events call — matches the Worker's MAX_BLOCK_RANGE
// constant (handlers/base.ts). Larger event-sync ranges chunk into multiple
// Worker round-trips. Spec §7.4.
const MAX_EVENT_RANGE = 10_000;

const DEFAULT_TICK_INTERVAL_MS = 60_000;

// Module-scoped concurrency guard. Single-instance per process.
let tickInProgress = false;
let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Execute one sync tick. Safe to call directly (for tests) or via the
 * scheduler. Returns a structured result for logging and (in the future)
 * surfacing through an admin /api/base/sync-status endpoint.
 */
export async function runOneTick(): Promise<SyncTickResult> {
    const started_at = Date.now();
    const errors: SyncTickResult["errors"] = [];

    // Zero defaults for event-sync counters; used by all early-return paths.
    const zeroEventCounts = {
        events_processed: 0,
        events_already_indexed: 0,
        decode_errors_count: 0,
        event_chunks_attempted: 0,
    };

    if (tickInProgress) {
        return {
            started_at,
            finished_at: Date.now(),
            skipped_reason: "in_progress",
            wallets_attempted: 0,
            wallets_succeeded: 0,
            wallets_failed: 0,
            contract_state_synced: false,
            ...zeroEventCounts,
            errors: [],
        };
    }
    tickInProgress = true;

    try {
        // No-op when no wallets are registered. Avoids hitting the Worker
        // (and incurring its rate-limit budget) on member nodes that have
        // never registered a BASE address.
        const wallets = listActiveBaseWallets();
        if (wallets.length === 0) {
            return {
                started_at,
                finished_at: Date.now(),
                skipped_reason: "no_wallets",
                wallets_attempted: 0,
                wallets_succeeded: 0,
                wallets_failed: 0,
                contract_state_synced: false,
                ...zeroEventCounts,
                errors: [],
            };
        }

        // ─── Step 1+2: contract info + fee recipient → contract state cache ───
        // Also captures the chain tip + router deploy block needed by Step 5.
        let contractStateSynced = false;
        let chainTip: number | null = null;
        let routerDeployBlock: number | null = null;
        try {
            const info = await fetchContractInfo();
            if (info.rpc_status === "unconfigured") {
                return {
                    started_at,
                    finished_at: Date.now(),
                    skipped_reason: "worker_not_configured",
                    wallets_attempted: 0,
                    wallets_succeeded: 0,
                    wallets_failed: 0,
                    contract_state_synced: false,
                    ...zeroEventCounts,
                    errors: [],
                };
            }
            if (
                info.settlement_router_address &&
                info.current_fee_bps != null &&
                info.is_paused != null &&
                info.as_of_block_number != null
            ) {
                const feeRecipient = await fetchFeeRecipient(info.settlement_router_address);
                upsertContractState({
                    settlementRouterAddress: info.settlement_router_address,
                    currentFeeBps: info.current_fee_bps,
                    isPaused: info.is_paused,
                    feeRecipientAddress: feeRecipient,
                    asOfBlockNumber: info.as_of_block_number,
                    asOfAt: Date.now(),
                });
                contractStateSynced = true;
                chainTip = info.as_of_block_number;
                // Option B (PR #200 T-gate decision): Worker is single source
                // of truth for the deploy block. Cached locally only in-tick.
                routerDeployBlock = info.settlement_router_deploy_block;
            } else {
                errors.push({
                    context: "contract_info",
                    error: `RPC degraded (rpc_status=${info.rpc_status}); skipping contract state upsert`,
                });
            }
        } catch (err) {
            errors.push({
                context: "contract_info",
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // ─── Step 3: per-wallet balance fetch + upsert ───
        let walletsSucceeded = 0;
        let walletsFailed = 0;
        for (const wallet of wallets) {
            try {
                const balance = await fetchUsdcBalance(wallet.walletAddress);
                upsertUsdcBalance(
                    wallet.walletAddress,
                    BigInt(balance.balance_raw),
                    balance.as_of_block_number,
                    Date.now(),
                );
                walletsSucceeded += 1;
                // Update chain tip with the freshest block seen across calls;
                // balance reads happen after contract_info so they're typically
                // newer by a block or two.
                if (chainTip == null || balance.as_of_block_number > chainTip) {
                    chainTip = balance.as_of_block_number;
                }
            } catch (err) {
                walletsFailed += 1;
                errors.push({
                    context: `balance:${wallet.walletAddress}`,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // ─── Step 5: Settled event sync (spec §7.2 step 3) ───
        // Cursor semantic v2: last_synced_block_number reflects the last block
        // whose Settled events are committed to base_settlement_event. Stricter
        // than v1 (which advanced cursor on any observed block); matches §7.4's
        // reorg-safe replay guarantee.
        const eventResult = await syncSettledEvents(chainTip, routerDeployBlock, errors);

        // ─── Step 6: cursor maintenance ───
        // Block advances only on Step 5 progress. Timestamp refreshes on every
        // successful tick so the UI's staleness signal stays accurate even when
        // Step 5 has nothing to do (chain hasn't moved past confirmation depth).
        let cursorAdvancedTo: number | undefined;
        if (eventResult.cursorAdvancedTo != null) {
            advanceSyncCursor(eventResult.cursorAdvancedTo, Date.now());
            cursorAdvancedTo = eventResult.cursorAdvancedTo;
        } else if (chainTip != null) {
            // Step 5 didn't advance, but the tick otherwise succeeded enough
            // to confirm the loop is running. Touch the timestamp without
            // moving the block.
            const current = getSyncCursor();
            advanceSyncCursor(current.lastSyncedBlockNumber, Date.now());
        }

        return {
            started_at,
            finished_at: Date.now(),
            wallets_attempted: wallets.length,
            wallets_succeeded: walletsSucceeded,
            wallets_failed: walletsFailed,
            contract_state_synced: contractStateSynced,
            cursor_advanced_to: cursorAdvancedTo,
            events_processed: eventResult.processed,
            events_already_indexed: eventResult.alreadyIndexed,
            decode_errors_count: eventResult.decodeErrorsCount,
            event_chunks_attempted: eventResult.chunksAttempted,
            errors,
        };
    } finally {
        tickInProgress = false;
    }
}

// -----------------------------------------------------------------------
// Step 5 internals
// -----------------------------------------------------------------------

interface EventSyncResult {
    cursorAdvancedTo: number | null;
    processed: number;
    alreadyIndexed: number;
    decodeErrorsCount: number;
    chunksAttempted: number;
}

/**
 * Pull Settled events from the Worker over [fromBlock, toBlock] (chunked at
 * MAX_EVENT_RANGE) and upsert each into base_settlement_event. Idempotent
 * via the UNIQUE(tx_hash, log_index) constraint. Returns the last block
 * whose events were successfully committed, or null if no progress was made.
 *
 * Cold-start handling: when the cursor is still at its seeded (0,0) value,
 * the fromBlock anchors on `routerDeployBlock` per the Option B decision
 * locked at session start. Without a deploy block from /base/contract-info,
 * cold-start can't run — surfaces an error and returns no progress.
 *
 * Failure isolation: a failed chunk stops further processing but does NOT
 * roll back previously-committed chunks. The cursor reflects the last
 * fully-committed chunk so the next tick resumes from there.
 *
 * decode_errors handling: per the T-gate decision, malformed logs (surfaced
 * by the Worker in `response.decode_errors`) are SKIPPED — no row written —
 * but the cursor still advances for that chunk (the malformed logs were at
 * confirmation depth and won't change on re-query). The count is surfaced
 * in `decodeErrorsCount` for operator visibility; non-zero counts warrant
 * manual review per spec §7.5.
 */
async function syncSettledEvents(
    chainTip: number | null,
    routerDeployBlock: number | null,
    errors: SyncTickResult["errors"],
): Promise<EventSyncResult> {
    const out: EventSyncResult = {
        cursorAdvancedTo: null,
        processed: 0,
        alreadyIndexed: 0,
        decodeErrorsCount: 0,
        chunksAttempted: 0,
    };

    if (chainTip == null) {
        errors.push({
            context: "event_sync",
            error: "no chain tip available (contract_info + all balance fetches failed)",
        });
        return out;
    }

    const confDepth = ENV.baseConfirmationDepth;
    const toBlock = chainTip - confDepth;
    if (toBlock < 0) {
        // Brand-new chain — won't happen on Sepolia/mainnet in practice.
        return out;
    }

    // Resolve fromBlock: cold-start anchors on deploy block, otherwise resume
    // from one past the last committed cursor.
    const cursor = getSyncCursor();
    let fromBlock: number;
    if (cursor.lastSyncedBlockNumber === 0) {
        if (routerDeployBlock == null) {
            errors.push({
                context: "event_sync",
                error: "cold-start: contract_info did not return settlement_router_deploy_block; cannot anchor cursor",
            });
            return out;
        }
        fromBlock = routerDeployBlock;
    } else {
        fromBlock = cursor.lastSyncedBlockNumber + 1;
    }

    if (fromBlock > toBlock) {
        // Steady state: chain hasn't advanced past (cursor + confirmation
        // depth) since last tick. Normal and frequent.
        return out;
    }

    // Chunk into MAX_EVENT_RANGE-sized windows. The Worker enforces the same
    // cap (handlers/base.ts MAX_BLOCK_RANGE = 10_000); chunking client-side
    // means cold-start backfills work without operator intervention.
    let chunkFrom = fromBlock;
    let lastCommittedTo: number | null = null;
    while (chunkFrom <= toBlock) {
        const chunkTo = Math.min(chunkFrom + MAX_EVENT_RANGE - 1, toBlock);
        out.chunksAttempted += 1;
        try {
            const response = await fetchSettledEvents(chunkFrom, chunkTo);
            const now = Date.now();
            for (const log of response.logs) {
                // The Worker returns the decoded payload under `log.decoded`;
                // for Settled events it carries the five DecodedSettledFields.
                const d = log.decoded as unknown as DecodedSettledFields;
                const inserted = upsertSettlementEvent({
                    blockNumber: log.block_number,
                    txHash: log.tx_hash,
                    logIndex: log.log_index,
                    senderAddress: d.sender,
                    recipientAddress: d.recipient,
                    amountUnits: BigInt(d.amount),
                    feeUnits: BigInt(d.fee),
                    tradeRef: d.trade_ref,
                    // v1 limitation: /base/events doesn't return block.timestamp.
                    // Using discovery time as a proxy. block_number is the
                    // definitive ordering anchor; UI displays "discovered at"
                    // for the wall-clock cue. Follow-up: extend the Worker
                    // response with block_timestamp or do a separate
                    // eth_getBlockByNumber call.
                    settledAt: now,
                    discoveredAt: now,
                });
                if (inserted) out.processed += 1;
                else out.alreadyIndexed += 1;
            }
            out.decodeErrorsCount += response.decode_errors.length;
            lastCommittedTo = chunkTo;
            chunkFrom = chunkTo + 1;
        } catch (err) {
            errors.push({
                context: `event_sync:${chunkFrom}-${chunkTo}`,
                error: err instanceof Error ? err.message : String(err),
            });
            // Stop processing further chunks; cursor reflects last successful
            // chunk only. Next tick retries from chunkFrom.
            break;
        }
    }

    if (lastCommittedTo != null) {
        out.cursorAdvancedTo = lastCommittedTo;
    }
    return out;
}

/**
 * Start the periodic sync loop. Idempotent — calling twice is a no-op.
 *
 * @param intervalMs Tick interval. Defaults to 60s per spec §7.1.
 * @param runImmediately If true, runs one tick on startup before the first
 *   interval delay. Matches the LND sync loop's "kick on boot" pattern.
 */
export function startBaseSyncLoop(opts: { intervalMs?: number; runImmediately?: boolean } = {}): void {
    if (intervalHandle != null) {
        console.warn("[base/sync] startBaseSyncLoop called twice; ignoring second call");
        return;
    }
    const intervalMs = opts.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    const runImmediately = opts.runImmediately ?? true;

    console.log(`[base/sync] starting loop (interval=${intervalMs}ms, run_immediately=${runImmediately})`);

    const tick = () => {
        runOneTick()
            .then((result) => {
                if (result.skipped_reason) {
                    // Quiet log — these are expected steady states.
                    return;
                }
                console.log(
                    `[base/sync] tick complete — wallets ${result.wallets_succeeded}/${result.wallets_attempted}, ` +
                        `contract_state=${result.contract_state_synced}, ` +
                        `cursor=${result.cursor_advanced_to ?? "unchanged"}, ` +
                        `errors=${result.errors.length}`,
                );
                if (result.errors.length > 0) {
                    for (const e of result.errors) {
                        console.warn(`[base/sync]   ${e.context}: ${e.error}`);
                    }
                }
            })
            .catch((err) => {
                // Defensive — runOneTick already catches per-step errors and
                // returns them in the result. This is reached only on a bug
                // in runOneTick itself.
                console.error(
                    "[base/sync] unexpected tick error:",
                    err instanceof Error ? err.message : String(err),
                );
            });
    };

    if (runImmediately) tick();
    intervalHandle = setInterval(tick, intervalMs);
}

/** Stop the sync loop. Used by tests and clean shutdown handlers. */
export function stopBaseSyncLoop(): void {
    if (intervalHandle != null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

/** Test helper: reset the in-progress flag. Production code never calls this. */
export function __resetTickFlagForTests(): void {
    tickInProgress = false;
}
