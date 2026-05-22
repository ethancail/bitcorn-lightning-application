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

vi.mock("./workerClient", () => ({
    fetchContractInfo: (...args: unknown[]) => fetchContractInfo(...args),
    fetchFeeRecipient: (...args: unknown[]) => fetchFeeRecipient(...args),
    fetchUsdcBalance: (...args: unknown[]) => fetchUsdcBalance(...args),
    BaseWorkerError: class extends Error {
        kind: string;
        constructor(msg: string, kind: string) {
            super(msg);
            this.kind = kind;
        }
    },
}));

const { runOneTick, __resetTickFlagForTests } = await import("./sync");
const { upsertMemberBaseWallet, getContractState, getUsdcBalance, getSyncCursor } = await import(
    "./store"
);

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
    memDb.exec("UPDATE base_sync_cursor SET last_synced_block_number = 0, last_synced_at = 0 WHERE id = 1");
    __resetTickFlagForTests();
    fetchContractInfo.mockReset();
    fetchFeeRecipient.mockReset();
    fetchUsdcBalance.mockReset();
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
        expect(result.cursor_advanced_to).toBe(41_852_000);
        expect(result.errors).toEqual([]);

        const balance = getUsdcBalance(WALLET);
        expect(balance!.balanceUnits).toBe(19_000_000n);
        const state = getContractState();
        expect(state!.currentFeeBps).toBe(0);
        expect(state!.isPaused).toBe(false);
        expect(state!.feeRecipientAddress).toBe(FEE_RECIPIENT);
        expect(getSyncCursor().lastSyncedBlockNumber).toBe(41_852_000);
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
        expect(result.cursor_advanced_to).toBe(41_852_000);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].context).toBe(`balance:${WALLET2}`);
        expect(getUsdcBalance(WALLET)!.balanceUnits).toBe(19_000_000n);
        expect(getUsdcBalance(WALLET2)).toBeNull();
    });

    it("contract_info failure: balances still polled, contract state not written", async () => {
        upsertMemberBaseWallet(PUBKEY, WALLET, 1_700_000_000);
        fetchContractInfo.mockRejectedValue(new Error("worker down"));
        fetchUsdcBalance.mockResolvedValue(okBalance(41_851_999));

        const result = await runOneTick();
        expect(result.contract_state_synced).toBe(false);
        expect(result.wallets_succeeded).toBe(1);
        expect(result.cursor_advanced_to).toBe(41_851_999);
        expect(result.errors.some((e) => e.context === "contract_info")).toBe(true);
        expect(fetchFeeRecipient).not.toHaveBeenCalled();
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
