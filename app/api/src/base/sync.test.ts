import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const memDb = new Database(":memory:");
memDb.pragma("foreign_keys = ON");
const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
for (const file of [
    "043_member_base_wallet.sql",
    "044_base_sync_cursor.sql",
    "045_base_usdc_balance_cache.sql",
    "046_base_settlement_event.sql",
    "047_base_contract_state_cache.sql",
    "053_base_sync_cursor_attempt_success.sql",
]) {
    memDb.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
}
vi.mock("../db", () => ({ db: memDb }));

const fetchContractInfo = vi.fn();
const fetchFeeRecipient = vi.fn();
const fetchUsdcBalance = vi.fn();
const fetchSettledEvents = vi.fn();

vi.mock("./workerClient", () => ({
    fetchContractInfo: (...args: unknown[]) => fetchContractInfo(...args),
    fetchFeeRecipient: (...args: unknown[]) => fetchFeeRecipient(...args),
    fetchUsdcBalance: (...args: unknown[]) => fetchUsdcBalance(...args),
    fetchSettledEvents: (...args: unknown[]) => fetchSettledEvents(...args),
    BaseWorkerError: class extends Error {
        kind: string;
        constructor(msg: string, kind: string) {
            super(msg);
            this.kind = kind;
        }
    },
}));

const { runOneTick, __resetTickFlagForTests } = await import("./sync");
const {
    upsertMemberBaseWallet,
    getContractState,
    getUsdcBalance,
    getSyncCursor,
    countSettlementEvents,
} = await import("./store");

// Default chain tip in fixtures = 41_852_000. With ENV.baseConfirmationDepth=64,
// Step 5's toBlock = 41_852_000 - 64 = 41_851_936. Cold-start fromBlock anchors
// at deploy_block = 41_851_566 (from okContractInfo). One chunk (range ~371 blocks).
const EXPECTED_EVENT_SYNC_TO_BLOCK = 41_852_000 - 64; // = 41_851_936

const PUBKEY = "02" + "11".repeat(32);
const WALLET = "0x4842925cf6b6671e8e1a25892bdea0807b4814fd";
const ROUTER = "0xf1bc89974f8520b7f98e7cf0c689a7077af04c78";
const FEE_RECIPIENT = "0xfeeefeeefeeefeeefeeefeeefeeefeeefeeefeee";

// Role thunks for runOneTick's required getNodeRole param. Every pre-existing
// test in this file registers a wallet and asserts member-shaped behaviour, so
// they all pass `asMember` — which preserves exactly the semantics they had
// before the guard became role-scoped.
const asTreasury = () => "treasury";
const asMember = () => "member";

const okContractInfo = {
    chain_id: 84532,
    settlement_router_address: ROUTER,
    settlement_router_deploy_block: 41_851_566,
    usdc_token_address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    current_fee_bps: 0,
    is_paused: false,
    as_of_block_number: 41_852_000,
    rpc_status: "ok" as const,
};

const okBalance = (block = 41_852_000, balanceRaw = "19000000") => ({
    address: WALLET,
    token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    token_symbol: "USDC",
    balance_raw: balanceRaw,
    decimals: 6,
    balance_human: "19.000000",
    as_of_block_number: block,
});

beforeEach(() => {
    memDb.exec("DELETE FROM member_base_wallet");
    memDb.exec("DELETE FROM base_usdc_balance_cache");
    memDb.exec("DELETE FROM base_contract_state_cache");
    memDb.exec("DELETE FROM base_settlement_event");
    memDb.exec(
        "UPDATE base_sync_cursor SET last_synced_block_number = 0, last_synced_at = 0, " +
            "last_attempt_at = 0, last_success_at = 0 WHERE id = 1",
    );
    __resetTickFlagForTests();
    fetchContractInfo.mockReset();
    fetchFeeRecipient.mockReset();
    fetchUsdcBalance.mockReset();
    fetchSettledEvents.mockReset();
    // Default: no Settled events in the range. Specific tests override.
    fetchSettledEvents.mockResolvedValue({
        event: "Settled",
        contract: ROUTER,
        from_block: 0,
        to_block: 0,
        logs: [],
        decode_errors: [],
        as_of_block_number: 41_852_000,
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("runOneTick — happy paths", () => {
    it("is a no-op when no wallets are registered", async () => {
        const result = await runOneTick(asMember);
        expect(result.skipped_reason).toBe("no_wallets");
        expect(fetchContractInfo).not.toHaveBeenCalled();
    });

    it("syncs one wallet end-to-end", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        const result = await runOneTick(asMember);

        expect(result.skipped_reason).toBeUndefined();
        expect(result.wallets_attempted).toBe(1);
        expect(result.wallets_succeeded).toBe(1);
        expect(result.wallets_failed).toBe(0);
        expect(result.contract_state_synced).toBe(true);
        // v2 cursor semantic: cursor reflects last block whose events are
        // committed, not the chain tip. tip=41_852_000 - 64 conf depth =
        // 41_851_936. Cold-start range = deploy_block..41_851_936.
        expect(result.cursor_advanced_to).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK);
        expect(result.event_chunks_attempted).toBe(1);
        expect(result.errors).toEqual([]);

        const balance = getUsdcBalance(WALLET);
        expect(balance!.balanceUnits).toBe(19_000_000n);
        const state = getContractState();
        expect(state!.currentFeeBps).toBe(0);
        expect(state!.isPaused).toBe(false);
        expect(state!.feeRecipientAddress).toBe(FEE_RECIPIENT);
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK);
    });
});

describe("runOneTick — failure isolation", () => {
    it("partial sync: one wallet fails, others succeed; cursor still advances", async () => {
        const WALLET2 = "0xed503244e4e9bfd30315c9a022150c8302af817b";
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        upsertMemberBaseWallet("02" + "22".repeat(32), WALLET2, 1_700_000_100);

        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockImplementation((addr: string) => {
            if (addr === WALLET2) return Promise.reject(new Error("RPC blip"));
            return Promise.resolve(okBalance());
        });

        const result = await runOneTick(asMember);
        expect(result.wallets_attempted).toBe(2);
        expect(result.wallets_succeeded).toBe(1);
        expect(result.wallets_failed).toBe(1);
        expect(result.contract_state_synced).toBe(true);
        // v2: cursor still advances to event-sync to_block since contract_info
        // succeeded → Step 5 ran successfully.
        expect(result.cursor_advanced_to).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].context).toBe(`balance:${WALLET2}`);
        expect(getUsdcBalance(WALLET)!.balanceUnits).toBe(19_000_000n);
        expect(getUsdcBalance(WALLET2)).toBeNull();
    });

    it("contract_info failure: balances still polled, but event sync blocked on cold-start", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockRejectedValue(new Error("worker down"));
        fetchUsdcBalance.mockResolvedValue(okBalance(41_851_999));

        const result = await runOneTick(asMember);
        expect(result.contract_state_synced).toBe(false);
        expect(result.wallets_succeeded).toBe(1);
        // v2: cursor cannot advance when cold-start has no deploy_block from
        // contract_info. Step 5 reports an error; cursor block stays at 0.
        expect(result.cursor_advanced_to).toBeUndefined();
        expect(result.errors.some((e) => e.context === "contract_info")).toBe(true);
        expect(result.errors.some((e) =>
            e.context === "event_sync" && e.error.includes("cold-start"),
        )).toBe(true);
        expect(fetchFeeRecipient).not.toHaveBeenCalled();
        // ⚠ THIS ASSERTION IS INVERTED FROM WHAT IT USED TO BE, and the old
        // version was pinning the bug. It read:
        //     expect(getSyncCursor().lastSyncedAt).toBeGreaterThan(0);
        //   // "Cursor timestamp DOES refresh (Step 6 touch path)"
        // i.e. it asserted that a tick which FAILED to sync any events still
        // refreshed the freshness timestamp, because one balance read had
        // succeeded. That is exactly the inverted signal migration 053 removes:
        // event ingestion is dead here (cold-start has no deploy block), so the
        // member's settlement history is frozen, and the staleness banner must
        // say so instead of reporting "fresh".
        //
        // Post-fix: the loop is alive (attempt moves) but nothing succeeded
        // (success stays at the never-synced sentinel).
        const cursor = getSyncCursor();
        expect(cursor.lastSyncedBlockNumber).toBe(0);
        expect(cursor.lastAttemptAt).toBeGreaterThan(0);
        expect(cursor.lastSuccessAt).toBe(0);
    });

    it("worker unconfigured: skipped cleanly without touching state", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, rpc_status: "unconfigured" });

        const result = await runOneTick(asMember);
        expect(result.skipped_reason).toBe("worker_not_configured");
        expect(fetchUsdcBalance).not.toHaveBeenCalled();
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(0);
    });

    // ─── Chain agreement ──────────────────────────────────────────────────
    //
    // The dangerous state this guards is API-on-mainnet + Worker-on-testnet,
    // which is what updating a node before flipping the Worker produces. It is
    // worse than an unconfigured Worker: SIWE still succeeds (bundle and API
    // agree), so the member reaches the send path, where the router comes from
    // the Worker (testnet) and the USDC address from a bundle-keyed client map
    // (mainnet, real Circle USDC) — an approve of real USDC to an address with
    // no code on this chain.
    //
    // okContractInfo.chain_id is 84532 and ENV.baseChainId defaults to 84532 in
    // test, so the mismatch is induced by moving the WORKER's chain, which is
    // the realistic direction: the node updates first, the Worker lags.
    it("worker on a different chain: refuses to cache the router, no state touched", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, chain_id: 8453 });

        const result = await runOneTick(asMember);
        expect(result.skipped_reason).toBe("worker_chain_mismatch");
        // Distinct from worker_not_configured on purpose — different operator fix.
        expect(result.skipped_reason).not.toBe("worker_not_configured");
        expect(result.contract_state_synced).toBe(false);
        // Never reaches wallet balances, and the cursor cannot advance — which is
        // what keeps the page on never_synced (quiet) instead of very_stale (red).
        expect(fetchUsdcBalance).not.toHaveBeenCalled();
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(0);
        // The operator-facing diagnostic names BOTH chain ids, so the log says
        // which way round the mismatch is without a second lookup.
        expect(result.errors[0]?.error).toContain("8453");
        expect(result.errors[0]?.error).toContain("84532");
    });

    it("worker chain_id null (degraded, not mismatched) does NOT trip the chain guard", async () => {
        // A null chain_id means the Worker did not state its chain, not that it
        // stated a wrong one. Treating null as a mismatch would convert every
        // degraded-RPC tick into a chain error and send an operator chasing a
        // configuration problem that does not exist.
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, chain_id: null });

        const result = await runOneTick(asMember);
        expect(result.skipped_reason).not.toBe("worker_chain_mismatch");
    });

    it("all wallets fail AND contract_info fails: cursor stays put", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockRejectedValue(new Error("rpc dead"));
        fetchUsdcBalance.mockRejectedValue(new Error("rpc dead"));

        const result = await runOneTick(asMember);
        expect(result.wallets_failed).toBe(1);
        expect(result.contract_state_synced).toBe(false);
        expect(result.cursor_advanced_to).toBeUndefined();
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(0);
    });
});

describe("runOneTick — concurrency", () => {
    it("skips when a previous tick is still in progress", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);

        let release: () => void = () => {};
        fetchContractInfo.mockReturnValue(
            new Promise((res) => {
                release = () => res(okContractInfo);
            }),
        );
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        const firstTick = runOneTick(asMember);
        const secondTick = await runOneTick(asMember);

        expect(secondTick.skipped_reason).toBe("in_progress");
        expect(secondTick.wallets_attempted).toBe(0);

        release();
        const firstResult = await firstTick;
        expect(firstResult.skipped_reason).toBeUndefined();
        expect(firstResult.wallets_succeeded).toBe(1);
    });
});

describe("runOneTick — staleness anchor", () => {
    it("writes as_of_at close to wall-clock time", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        const before = Date.now();
        await runOneTick(asMember);
        const after = Date.now();

        const balance = getUsdcBalance(WALLET)!;
        expect(balance.asOfAt).toBeGreaterThanOrEqual(before);
        expect(balance.asOfAt).toBeLessThanOrEqual(after);
        const state = getContractState()!;
        expect(state.asOfAt).toBeGreaterThanOrEqual(before);
        expect(state.asOfAt).toBeLessThanOrEqual(after);
    });
});

// ─── Step 5 (event sync) — added in PR #200 ────────────────────────────

// A realistic Settled-log response shape matching what the Worker /base/events
// handler returns. tradeRef matches the on-chain smoke transaction from
// PR #198 + #199's smoke runs.
const settledLogFixture = {
    block_number: 41_851_567,
    tx_hash: "0x3826e7bc20027f791885f0cb08e09a05fc3fb89a603ea2896f14176fce3a4547",
    log_index: 4,
    decoded: {
        sender: "0x4842925cf6b6671e8e1a25892bdea0807b4814fd",
        recipient: "0xed503244e4e9bfd30315c9a022150c8302af817b",
        trade_ref: "0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155",
        amount: "1000000",
        fee: "0",
    },
};

const okEventsResponse = (overrides: Partial<typeof eventsBase> = {}) => ({
    ...eventsBase,
    ...overrides,
});
const eventsBase = {
    event: "Settled",
    contract: ROUTER,
    from_block: 41_851_566,
    to_block: 41_851_936,
    logs: [],
    decode_errors: [],
    as_of_block_number: 41_852_000,
};

describe("runOneTick — Step 5 event sync (happy paths)", () => {
    it("writes a Settled row when /base/events returns one log", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());
        fetchSettledEvents.mockResolvedValue(okEventsResponse({ logs: [settledLogFixture] }));

        const result = await runOneTick(asMember);

        expect(result.events_processed).toBe(1);
        expect(result.events_already_indexed).toBe(0);
        expect(result.decode_errors_count).toBe(0);
        expect(result.event_chunks_attempted).toBe(1);
        expect(result.cursor_advanced_to).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK);

        expect(countSettlementEvents()).toBe(1);
        const row = memDb
            .prepare(`SELECT sender_address, recipient_address, amount_units, fee_units, trade_ref FROM base_settlement_event`)
            .get() as Record<string, string>;
        expect(row.sender_address).toBe("0x4842925cf6b6671e8e1a25892bdea0807b4814fd");
        expect(row.recipient_address).toBe("0xed503244e4e9bfd30315c9a022150c8302af817b");
        expect(row.amount_units).toBe("1000000");
        expect(row.fee_units).toBe("0");
        expect(row.trade_ref).toBe("0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155");
    });

    it("calls /base/events with cold-start anchored at deploy_block", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        await runOneTick(asMember);

        expect(fetchSettledEvents).toHaveBeenCalledTimes(1);
        const [fromBlock, toBlock] = fetchSettledEvents.mock.calls[0];
        expect(fromBlock).toBe(41_851_566); // deploy_block from okContractInfo
        expect(toBlock).toBe(41_851_936);   // chain_tip - confirmation_depth(64)
    });

    it("idempotent: re-running the same tick does not duplicate rows", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());
        fetchSettledEvents.mockResolvedValue(okEventsResponse({ logs: [settledLogFixture] }));

        const first = await runOneTick(asMember);
        expect(first.events_processed).toBe(1);
        expect(first.events_already_indexed).toBe(0);

        // Simulate the next tick re-reading an overlapping range (e.g. after
        // a crash). Reset the cursor back to 0 so cold-start hits the same
        // range again.
        memDb.exec("UPDATE base_sync_cursor SET last_synced_block_number = 0 WHERE id = 1");
        __resetTickFlagForTests();

        const second = await runOneTick(asMember);
        expect(second.events_processed).toBe(0); // UNIQUE constraint skipped
        expect(second.events_already_indexed).toBe(1);
        expect(countSettlementEvents()).toBe(1); // still just one
    });

    it("steady state: cursor already past tip-confDepth → no events call needed", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        // Pre-seed the cursor to a block just below tip-confDepth.
        memDb.exec(
            `UPDATE base_sync_cursor SET last_synced_block_number = ${EXPECTED_EVENT_SYNC_TO_BLOCK} WHERE id = 1`,
        );
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        const result = await runOneTick(asMember);
        // Range is empty (fromBlock=to_block+1=41_851_937 > toBlock=41_851_936)
        expect(fetchSettledEvents).not.toHaveBeenCalled();
        expect(result.event_chunks_attempted).toBe(0);
        expect(result.cursor_advanced_to).toBeUndefined();
        // Caught up IS a success: there was nothing to fetch precisely because
        // our view of the Settled stream is current. So success refreshes even
        // though the block number doesn't move. This is the case that must NOT
        // be swept up by the stricter migration-053 rule — contrast the
        // cold-start-blocked test above, where success correctly stays at 0.
        const cursor = getSyncCursor();
        expect(cursor.lastSuccessAt).toBeGreaterThan(0);
        expect(cursor.lastAttemptAt).toBeGreaterThan(0);
    });
});

describe("runOneTick — Step 5 chunking", () => {
    it("splits a range > MAX_EVENT_RANGE (10k blocks) into sequential chunks", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        // Tip 41_872_000 means tip - 64 = 41_871_936. Cold-start from 41_851_566.
        // Range = 41_871_936 - 41_851_566 + 1 = 20_371 blocks → 3 chunks.
        const bigTip = 41_872_000;
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, as_of_block_number: bigTip });
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance(bigTip));
        fetchSettledEvents.mockResolvedValue(okEventsResponse());

        const result = await runOneTick(asMember);
        expect(result.event_chunks_attempted).toBe(3); // 10k + 10k + 371 = 20371
        expect(result.cursor_advanced_to).toBe(bigTip - 64);

        // Verify chunk boundaries are non-overlapping and contiguous.
        const calls = fetchSettledEvents.mock.calls as Array<[number, number]>;
        expect(calls[0]).toEqual([41_851_566, 41_861_565]);
        expect(calls[1]).toEqual([41_861_566, 41_871_565]);
        expect(calls[2]).toEqual([41_871_566, 41_871_936]);
    });

    it("partial chunk failure: cursor advances only to last successful chunk", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        const bigTip = 41_872_000;
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, as_of_block_number: bigTip });
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance(bigTip));
        // First chunk succeeds, second fails, third never attempted.
        let callCount = 0;
        fetchSettledEvents.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 2) throw new Error("RPC blip mid-backfill");
            return okEventsResponse();
        });

        const result = await runOneTick(asMember);
        expect(result.event_chunks_attempted).toBe(2); // tried chunk 2, broke out before 3
        expect(result.cursor_advanced_to).toBe(41_861_565); // last successful chunk's toBlock
        expect(result.errors.some((e) => e.context.startsWith("event_sync:"))).toBe(true);
        // Partial progress advances the block AND stamps success — real events
        // did commit. But the tail is still missing, so the next tick must keep
        // going; success here reflects "we committed through 41_861_565", which
        // is true.
        expect(getSyncCursor().lastSuccessAt).toBeGreaterThan(0);
    });

    it("⚠ event sync failing while balances succeed does NOT look fresh", async () => {
        // THE CASE MIGRATION 053 EXISTS FOR, and the one the old `chainTip !=
        // null` condition got wrong.
        //
        // Balance reads succeed, so the pre-fix code set chainTip and refreshed
        // the freshness timestamp — while EVERY /base/events call failed, so the
        // member's settlement history was frozen. The UI reported "fresh" over a
        // dead stream: a hard failure looking healthier than a misconfiguration.
        //
        // Distinct from the partial-chunk test above: there, some events DID
        // commit. Here nothing commits, so there is no success to stamp and the
        // staleness banner must be allowed to climb.
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        const bigTip = 41_872_000;
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, as_of_block_number: bigTip });
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance(bigTip));
        fetchSettledEvents.mockRejectedValue(new Error("eth_getLogs upstream error"));

        const result = await runOneTick(asMember);

        // The tick was otherwise healthy: contract state cached, wallet polled.
        // Without the split, those successes alone would have masked the failure.
        expect(result.contract_state_synced).toBe(true);
        expect(result.wallets_succeeded).toBe(1);
        expect(result.cursor_advanced_to).toBeUndefined();
        expect(result.errors.some((e) => e.context.startsWith("event_sync:"))).toBe(true);

        const cursor = getSyncCursor();
        expect(cursor.lastAttemptAt).toBeGreaterThan(0); // loop is alive
        expect(cursor.lastSuccessAt).toBe(0); // but nothing is current
        expect(cursor.lastSyncedBlockNumber).toBe(0);
    });
});

describe("runOneTick — Step 5 decode_errors handling", () => {
    it("skips malformed logs but advances cursor and surfaces count", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());
        // Worker surfaces 2 decode errors alongside the good log.
        fetchSettledEvents.mockResolvedValue(okEventsResponse({
            logs: [settledLogFixture],
            decode_errors: [
                { tx_hash: "0xbad1", log_index: "0x0", error: "expected 3 indexed topics" },
                { tx_hash: "0xbad2", log_index: "0x0", error: "data too short" },
            ],
        }));

        const result = await runOneTick(asMember);
        expect(result.events_processed).toBe(1);          // good log written
        expect(result.decode_errors_count).toBe(2);       // surfaced for operator
        expect(result.cursor_advanced_to).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK); // still advances
        expect(countSettlementEvents()).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The role-scoped wallet guard (2026-08-10).
//
// The treasury syncs as the fleet's INDEXER, not as a rail participant, so it
// must proceed with zero registered wallets. Members must NOT — the guard's
// original purpose (sparing the Worker's rate-limit budget on nodes with no
// rail involvement) survives only if they stay excluded, which is what the
// member test below is for.
//
// Role is injected as a THUNK, not a value. node_role is written into
// lnd_node_info by the LND sync (lightning/persist.ts) from an unawaited async
// IIFE (index.ts:229) that races startBaseSyncLoop (index.ts:4355), and
// migration 010 defaults the column to 'external'. A treasury node whose LND is
// slow at boot therefore reads as not-treasury for a while, and capturing the
// role once would freeze that forever. The per-tick read is what makes it
// self-healing — pinned by the changes-between-ticks test at the end.
// ─────────────────────────────────────────────────────────────────────────

describe("runOneTick — role-scoped wallet guard", () => {
    it("TREASURY with zero wallets PROCEEDS past the guard", async () => {
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);

        const result = await runOneTick(asTreasury);

        // Asserted positively — not merely "skipped_reason !== 'no_wallets'",
        // which a different early return would also satisfy.
        expect(result.skipped_reason).toBeUndefined();
        expect(fetchContractInfo).toHaveBeenCalled();
        // Zero wallets is not a failure, it is the expected treasury shape.
        expect(result.wallets_attempted).toBe(0);
        expect(result.wallets_failed).toBe(0);
    });

    it("MEMBER with zero wallets is STILL guarded — the original purpose survives", async () => {
        // THE TEST THAT MATTERS. Role-scoping is only correct if members remain
        // excluded; if this ever goes green-by-accident the change has become a
        // blanket removal of the guard and every member node starts spending
        // Worker budget it has no use for.
        const result = await runOneTick(asMember);

        expect(result.skipped_reason).toBe("no_wallets");
        expect(fetchContractInfo).not.toHaveBeenCalled();
    });

    it("an UNKNOWN/absent role is treated as not-treasury — fail closed", async () => {
        // getNodeRole returns null before the LND sync has written the row.
        // Anything that is not exactly "treasury" must be guarded, matching
        // utils/role.ts:2's `role !== "treasury"`.
        const result = await runOneTick(() => null);

        expect(result.skipped_reason).toBe("no_wallets");
        expect(fetchContractInfo).not.toHaveBeenCalled();
    });

    it("MEMBER with a wallet still syncs — role-scoping did not narrow the guard", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        const result = await runOneTick(asMember);

        expect(result.skipped_reason).toBeUndefined();
        expect(result.wallets_succeeded).toBe(1);
    });

    it("treasury with zero wallets runs the WALLET-INDEPENDENT steps", async () => {
        // Observable effects, not "the function returned". These three are
        // exactly what the fee-revenue surface depends on.
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchSettledEvents.mockResolvedValue(okEventsResponse({ logs: [settledLogFixture] }));

        const result = await runOneTick(asTreasury);

        // 1. Contract-state cache WRITTEN (row in base_contract_state_cache).
        const state = getContractState();
        expect(state?.settlementRouterAddress).toBe(ROUTER);
        expect(state?.feeRecipientAddress).toBe(FEE_RECIPIENT);
        expect(result.contract_state_synced).toBe(true);

        // 2. Event ingestion ATTEMPTED and committed — the row is in the table.
        expect(fetchSettledEvents).toHaveBeenCalled();
        expect(result.events_processed).toBe(1);
        expect(countSettlementEvents()).toBe(1);

        // 3. Cursor ADVANCED.
        expect(result.cursor_advanced_to).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK);
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK);

        // And no balance work happened, because there are no wallets to poll.
        expect(fetchUsdcBalance).not.toHaveBeenCalled();
    });

    it("SELF-HEALS when the role changes between ticks — the reason it is a thunk", async () => {
        // The boot race, reproduced. node_role defaults to 'external'
        // (migration 010) and is written later by the LND sync from an
        // unawaited IIFE, so the first tick of a treasury node can genuinely
        // read as not-treasury.
        //
        // A captured role would freeze the first reading and the treasury would
        // skip forever — indistinguishable from the bug this change fixes. This
        // test is the only thing standing between that and a refactor that
        // hoists getNodeRole() out of the tick: every other test here passes a
        // constant thunk and would stay green.
        let role = "external";
        const changingRole = () => role;

        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);

        const early = await runOneTick(changingRole);
        expect(early.skipped_reason).toBe("no_wallets");
        expect(fetchContractInfo).not.toHaveBeenCalled();

        // LND sync lands; the row now says treasury. Nothing else changes.
        role = "treasury";

        const later = await runOneTick(changingRole);
        expect(later.skipped_reason).toBeUndefined();
        expect(fetchContractInfo).toHaveBeenCalled();
    });
});
