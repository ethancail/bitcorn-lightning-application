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

import { fetchContractInfo, fetchFeeRecipient, fetchUsdcBalance, BaseWorkerError } from "./workerClient";
import {
    advanceSyncCursor,
    listActiveBaseWallets,
    upsertContractState,
    upsertUsdcBalance,
} from "./store";
import type { SyncTickResult } from "./types";

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

    if (tickInProgress) {
        return {
            started_at,
            finished_at: Date.now(),
            skipped_reason: "in_progress",
            wallets_attempted: 0,
            wallets_succeeded: 0,
            wallets_failed: 0,
            contract_state_synced: false,
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
                errors: [],
            };
        }

        // ─── Step 1+2: contract info + fee recipient → contract state cache ───
        let contractStateSynced = false;
        let observedBlock: number | null = null;
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
                observedBlock = info.as_of_block_number;
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
                if (observedBlock == null || balance.as_of_block_number > observedBlock) {
                    observedBlock = balance.as_of_block_number;
                }
            } catch (err) {
                walletsFailed += 1;
                errors.push({
                    context: `balance:${wallet.walletAddress}`,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // ─── Step 4: advance the cursor ───
        // Only advance if we observed a block this tick. If every call failed,
        // leave the cursor where it was so the staleness signal stays accurate.
        let cursorAdvancedTo: number | undefined;
        if (observedBlock != null) {
            advanceSyncCursor(observedBlock, Date.now());
            cursorAdvancedTo = observedBlock;
        }

        return {
            started_at,
            finished_at: Date.now(),
            wallets_attempted: wallets.length,
            wallets_succeeded: walletsSucceeded,
            wallets_failed: walletsFailed,
            contract_state_synced: contractStateSynced,
            cursor_advanced_to: cursorAdvancedTo,
            errors,
        };
    } finally {
        tickInProgress = false;
    }
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
