// The BASE sync loop.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7
//
// Runs in the API container at ~60s cadence. Each tick:
//   - Reads /base/contract-info (block number + governance state).
//   - Resolves feeRecipient() via /base/contract-state and upserts
//     base_contract_state_cache.
//   - Polls /base/balance for every active wallet in member_base_wallet
//     and upserts base_usdc_balance_cache.
//   - Ingests SettlementRouter Settled events via the Worker's /base/events
//     (eth_getLogs) proxy into base_settlement_event — gated at
//     BASE_CONFIRMATION_DEPTH blocks below the tip for reorg safety,
//     idempotent via UNIQUE(tx_hash, log_index), chunked over large ranges,
//     with a cold-start backfill from the router deploy block.
//   - Advances base_sync_cursor to the last block whose Settled events are
//     committed (the block advances only on event-commit progress; the
//     freshness timestamp refreshes on every successful tick).
//
// Settled-event ingestion is LIVE. (It was deferred in the first v1 cut —
// PR #197 shipped eth_call reads only — but the Worker /base/events endpoint
// and this loop's ingestion have since landed; base_settlement_event is
// populated and served via GET /api/stablecoin/settlements.) Governance-event
// *history* (FeeBpsUpdated / Paused / Unpaused) is still NOT captured — only
// current governance state (fee bps, paused) is cached.
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
    getSyncCursor,
    listActiveBaseWallets,
    recordSyncAttempt,
    recordSyncSuccess,
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
 *
 * @param getNodeRole Reads this node's `node_role` — see the wallet guard
 *   below for why the treasury needs it, and why it is a FUNCTION rather than
 *   a value. Injected rather than imported so this module keeps depending only
 *   on ./workerClient, ./store, ./types and ../config/env; the shape matches
 *   `startKeypairSyncCheck(() => getNodeInfo()?.pubkey ?? null)`
 *   (index.ts:4347), which solves the same problem for the same reason.
 */
export async function runOneTick(
    getNodeRole: () => string | null,
): Promise<SyncTickResult> {
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
        //
        // ─── …EXCEPT ON THE TREASURY. Added 2026-08-10. ──────────────────
        //
        // WHY: the treasury syncs as the fleet's INDEXER, not as a rail
        // participant. Those two reasons coincided while the rail was
        // member-only — you synced because you had a wallet to watch — and
        // diverged the moment treasury fee revenue became a thing. The Worker's
        // /base/events returns EVERY Settled log on the router (topic0 filter
        // only, handlers/base.ts) and this loop persists every one of them with
        // no wallet filter, so the treasury's base_settlement_event is the
        // fleet-wide record. Wallet-scoping happens at READ time
        // (handleSettlements), never at ingest.
        //
        // Without this branch the treasury ingests nothing, forever: it has
        // never registered a BASE wallet, so the guard fired on every tick
        // since the rail went live (2026-08-07) — cursor never_synced,
        // base_settlement_event empty, and every rail surface on the treasury
        // reading as an honest-looking but false zero.
        //
        // COST, measured rather than estimated: 2 Worker requests per 60s tick
        // in steady state (contract-info + feeRecipient; /base/events returns
        // early at fromBlock > toBlock), 3 when the chain has advanced. That is
        // BELOW what a single member node with one wallet already spends (3-4),
        // so letting one treasury through does not move the budget this guard
        // exists to protect. Cold start is bounded too: the cursor anchors on
        // the router deploy block, not 0 (syncSettledEvents), and the chunk
        // loop drains within a single tick.
        //
        // ⚠ REJECTED ALTERNATIVE — DO NOT RE-PROPOSE. "Proceed if the node has
        // wallets OR a router is configured", so the condition describes work
        // available instead of naming a role. It is circular: the router
        // address comes FROM the Worker, so evaluating it needs either a Worker
        // call (spending exactly the budget this guard protects) or
        // base_contract_state_cache — which only a SUCCESSFUL SYNC populates.
        // A fresh member node's cache is empty, so the guard fires, so the
        // cache never populates, so the guard fires forever.
        //
        // ⚠ WHY getNodeRole IS A FUNCTION AND NOT A VALUE. node_role is not
        // known at boot. Migration 010 defaults the column to 'external', and
        // the value is written into lnd_node_info by the LND sync
        // (lightning/persist.ts) — from a fire-and-forget async IIFE
        // (index.ts:229) that nothing awaits, racing startBaseSyncLoop
        // (index.ts:4355). A treasury node whose LND is slow or unreachable at
        // boot therefore genuinely reads as 'external' for a while. Capturing
        // the role once would freeze that: the treasury would skip forever and
        // look exactly like the bug this change fixes. Reading per tick makes
        // it SELF-HEALING — an early tick skips, a later tick proceeds — which
        // is pinned by the role-changes-between-ticks test in sync.test.ts.
        //
        // The general shape, because it keeps recurring: a value that looks
        // static is often produced by an independent async writer, and code
        // that snapshots it inherits whatever was true at snapshot time. Don't
        // capture the value — capture the way to ask. (Same shape as the
        // registered_at clock-skew fix in walletStatusView.ts, where a
        // server-minted timestamp was compared against the browser's clock.)
        const wallets = listActiveBaseWallets();
        const isTreasury = getNodeRole() === "treasury";
        if (wallets.length === 0 && !isTreasury) {
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
            // ─── Chain agreement: refuse to cache another chain's router ──────
            //
            // WHY THIS EXISTS, and why it is worth more than the four lines it
            // costs. Three chain-id sources have to agree: the web bundle's
            // build-time VITE_BASE_CHAIN_ID, this API's BASE_CHAIN_ID, and the
            // Worker's BASE_CHAIN_ID. Nothing used to compare the third.
            //
            // The dangerous combination is API-on-mainnet + Worker-on-testnet. It
            // is not hypothetical: it is what you get by updating a node before
            // flipping the Worker. In that state SIWE registration SUCCEEDS (the
            // bundle and this API agree), so the member reaches the send path —
            // where the router address comes from the Worker (testnet) while the
            // USDC address comes from a client-side map keyed on the bundle's
            // chain (mainnet, real Circle USDC). The member is then asked to
            // approve REAL USDC to an address that has no code on this chain.
            // `approve()` succeeds — ERC-20 does not check the spender has code —
            // leaving a live allowance against an address nobody controls.
            //
            // Refusing here restores fail-closed: no router is cached, so
            // submitGuard blocks the send path, the cursor stays at 0 →
            // never_synced → StaleBanner renders nothing, and the page stays
            // clean rather than alarming. Same downstream shape as
            // `worker_not_configured` above, deliberately.
            //
            // NOTE: this needed no new plumbing. WorkerContractInfoResponse
            // already carried `chain_id` (base/types.ts) — the Worker has always
            // sent it and this file has always discarded it. Only the comparison
            // was missing.
            //
            // A client-side check (chain_id on ContractStateResponse) is the
            // complementary defence and is deliberately NOT done here — it is the
            // separate arc docker-publish.yml's own comment earmarks.
            if (info.chain_id != null && info.chain_id !== ENV.baseChainId) {
                return {
                    started_at,
                    finished_at: Date.now(),
                    skipped_reason: "worker_chain_mismatch",
                    wallets_attempted: 0,
                    wallets_succeeded: 0,
                    wallets_failed: 0,
                    contract_state_synced: false,
                    ...zeroEventCounts,
                    errors: [
                        {
                            context: "contract_info",
                            error:
                                `Worker chain_id=${info.chain_id} does not match this node's ` +
                                `BASE_CHAIN_ID=${ENV.baseChainId}; refusing to cache another ` +
                                `chain's router address.`,
                        },
                    ],
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

        // ─── Step 6: cursor maintenance (migration 053 semantics) ───
        //
        // last_attempt_at records liveness and is written unconditionally here —
        // we got past every early-return guard, so the loop is alive.
        //
        // last_success_at is written ONLY when the Settled stream is provably
        // current: Step 5 either advanced the high-water mark, or confirmed the
        // cursor was already at (tip − confirmation depth) with no chunk errors.
        //
        // WHY THIS IS STRICTER THAN IT USED TO BE: the previous condition was
        // `chainTip != null`, i.e. "some chain read worked." That refreshed the
        // freshness timestamp even when event ingestion was failing every tick,
        // because a successful /base/balance read alone was enough to set
        // chainTip. The staleness banner therefore reported "fresh" while the
        // member's settlement history was frozen — the failure looked healthier
        // than a misconfiguration. Freshness now means "the settlement stream is
        // current", which is what the banner actually claims.
        const cursorNow = Date.now();
        recordSyncAttempt(cursorNow);
        let cursorAdvancedTo: number | undefined;
        if (eventResult.cursorAdvancedTo != null) {
            recordSyncSuccess(eventResult.cursorAdvancedTo, cursorNow);
            cursorAdvancedTo = eventResult.cursorAdvancedTo;
        } else if (eventResult.upToDate) {
            // Nothing to fetch — the chain hasn't advanced past (cursor +
            // confirmation depth) since the last tick. Normal steady state, and
            // a genuine success: our view IS current. Refresh the timestamp
            // without moving the block.
            recordSyncSuccess(getSyncCursor().lastSyncedBlockNumber, cursorNow);
        }
        // Otherwise: leave last_success_at alone so staleness grows and the
        // banner tells the truth about the stream being stuck.

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
    /**
     * True only when the Settled stream is PROVABLY current: every chunk up to
     * (tip − confirmation depth) committed this tick, or the cursor was already
     * at/past that point so there was nothing to fetch.
     *
     * False on every error path — no chain tip, cold-start with no deploy block,
     * or a chunk that threw. Drives last_success_at (migration 053), so a false
     * here is what lets the staleness banner correctly report a stuck stream.
     */
    upToDate: boolean;
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
        upToDate: false,
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
        // depth) since last tick. Normal and frequent — and a genuine success:
        // there is nothing to fetch precisely because our view is current.
        out.upToDate = true;
        return out;
    }

    // Chunk into MAX_EVENT_RANGE-sized windows. The Worker enforces the same
    // cap (handlers/base.ts MAX_BLOCK_RANGE = 10_000); chunking client-side
    // means cold-start backfills work without operator intervention.
    let chunkFrom = fromBlock;
    let lastCommittedTo: number | null = null;
    let errored = false;
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
            errored = true;
            break;
        }
    }

    if (lastCommittedTo != null) {
        out.cursorAdvancedTo = lastCommittedTo;
    }
    // Provably current only if we drained the whole range without a chunk
    // failing. A partial drain still advances the cursor (progress is real and
    // kept) but does NOT count as current — the tail is missing, so the
    // staleness banner should keep climbing until it lands.
    out.upToDate = !errored && chunkFrom > toBlock;
    return out;
}

/**
 * Start the periodic sync loop. Idempotent — calling twice is a no-op.
 *
 * @param getNodeRole REQUIRED. Reads this node's `node_role` fresh on every
 *   tick — see runOneTick's wallet guard for why it must not be captured as a
 *   value. Deliberately has no default: a default would make this module import
 *   the api/ layer, and the injection point is what keeps the guard testable
 *   without an lnd_node_info table.
 * @param intervalMs Tick interval. Defaults to 60s per spec §7.1.
 * @param runImmediately If true, runs one tick on startup before the first
 *   interval delay. Matches the LND sync loop's "kick on boot" pattern.
 */
export function startBaseSyncLoop(opts: {
    getNodeRole: () => string | null;
    intervalMs?: number;
    runImmediately?: boolean;
}): void {
    if (intervalHandle != null) {
        console.warn("[base/sync] startBaseSyncLoop called twice; ignoring second call");
        return;
    }
    const intervalMs = opts.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    const runImmediately = opts.runImmediately ?? true;

    console.log(`[base/sync] starting loop (interval=${intervalMs}ms, run_immediately=${runImmediately})`);

    const tick = () => {
        runOneTick(opts.getNodeRole)
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
