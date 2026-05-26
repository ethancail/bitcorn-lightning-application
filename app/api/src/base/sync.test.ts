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
    memDb.exec("UPDATE base_sync_cursor SET last_synced_block_number = 0, last_synced_at = 0 WHERE id = 1");
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
        const result = await runOneTick();
        expect(result.skipped_reason).toBe("no_wallets");
        expect(fetchContractInfo).not.toHaveBeenCalled();
    });

    it("syncs one wallet end-to-end", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue(okContractInfo);
        fetchFeeRecipient.mockResolvedValue(FEE_RECIPIENT);
        fetchUsdcBalance.mockResolvedValue(okBalance());

        const result = await runOneTick();

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

        const result = await runOneTick();
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

        const result = await runOneTick();
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
        // Cursor timestamp DOES refresh (Step 6 touch path) — used by UI staleness.
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(0);
        expect(getSyncCursor().lastSyncedAt).toBeGreaterThan(0);
    });

    it("worker unconfigured: skipped cleanly without touching state", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockResolvedValue({ ...okContractInfo, rpc_status: "unconfigured" });

        const result = await runOneTick();
        expect(result.skipped_reason).toBe("worker_not_configured");
        expect(fetchUsdcBalance).not.toHaveBeenCalled();
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(0);
    });

    it("all wallets fail AND contract_info fails: cursor stays put", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockRejectedValue(new Error("rpc dead"));
        fetchUsdcBalance.mockRejectedValue(new Error("rpc dead"));

        const result = await runOneTick();
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

        const firstTick = runOneTick();
        const secondTick = await runOneTick();

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
        await runOneTick();
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

        const result = await runOneTick();

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

        await runOneTick();

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

        const first = await runOneTick();
        expect(first.events_processed).toBe(1);
        expect(first.events_already_indexed).toBe(0);

        // Simulate the next tick re-reading an overlapping range (e.g. after
        // a crash). Reset the cursor back to 0 so cold-start hits the same
        // range again.
        memDb.exec("UPDATE base_sync_cursor SET last_synced_block_number = 0 WHERE id = 1");
        __resetTickFlagForTests();

        const second = await runOneTick();
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

        const result = await runOneTick();
        // Range is empty (fromBlock=to_block+1=41_851_937 > toBlock=41_851_936)
        expect(fetchSettledEvents).not.toHaveBeenCalled();
        expect(result.event_chunks_attempted).toBe(0);
        expect(result.cursor_advanced_to).toBeUndefined();
        // Timestamp still refreshed by the touch path.
        expect(getSyncCursor().lastSyncedAt).toBeGreaterThan(0);
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

        const result = await runOneTick();
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

        const result = await runOneTick();
        expect(result.event_chunks_attempted).toBe(2); // tried chunk 2, broke out before 3
        expect(result.cursor_advanced_to).toBe(41_861_565); // last successful chunk's toBlock
        expect(result.errors.some((e) => e.context.startsWith("event_sync:"))).toBe(true);
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

        const result = await runOneTick();
        expect(result.events_processed).toBe(1);          // good log written
        expect(result.decode_errors_count).toBe(2);       // surfaced for operator
        expect(result.cursor_advanced_to).toBe(EXPECTED_EVENT_SYNC_TO_BLOCK); // still advances
        expect(countSettlementEvents()).toBe(1);
    });
});
