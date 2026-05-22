import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Stub the singleton db module so importing ./store (which imports ../db)
// doesn't try to mkdir /data/db on the test host.
vi.mock("../db", () => ({ db: new Database(":memory:") }));

import {
    advanceSyncCursor,
    getContractState,
    getSyncCursor,
    getUsdcBalance,
    listActiveBaseWallets,
    upsertContractState,
    upsertMemberBaseWallet,
    upsertUsdcBalance,
} from "./store";

const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
const BASE_MIGRATIONS = [
    "043_member_base_wallet.sql",
    "044_base_sync_cursor.sql",
    "045_base_usdc_balance_cache.sql",
    "046_base_settlement_event.sql",
    "047_base_contract_state_cache.sql",
];

function applyMigration(db: Database.Database, file: string): void {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
}

function newTestDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const file of BASE_MIGRATIONS) applyMigration(db, file);
    return db;
}

let db: Database.Database;
beforeEach(() => {
    db = newTestDb();
});

describe("member_base_wallet store", () => {
    const PUBKEY = "02" + "00".repeat(32);
    const ADDR = "0x4842925CF6B6671e8e1A25892bdeA0807b4814fD";

    it("upserts and lists an active wallet", () => {
        upsertMemberBaseWallet(PUBKEY, ADDR, 1_700_000_000, db);
        const rows = listActiveBaseWallets(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].memberPubkey).toBe(PUBKEY);
        expect(rows[0].walletAddress).toBe(ADDR.toLowerCase());
        expect(rows[0].isActive).toBe(true);
    });

    it("overwrites address on re-registration (same pubkey)", () => {
        const ADDR2 = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        upsertMemberBaseWallet(PUBKEY, ADDR, 1_700_000_000, db);
        upsertMemberBaseWallet(PUBKEY, ADDR2, 1_700_000_100, db);
        const rows = listActiveBaseWallets(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].walletAddress).toBe(ADDR2);
        expect(rows[0].registeredAt).toBe(1_700_000_100);
    });

    it("rejects malformed wallet address via CHECK constraint", () => {
        expect(() => upsertMemberBaseWallet(PUBKEY, "not-an-address", 1_700_000_000, db)).toThrow();
        expect(() =>
            upsertMemberBaseWallet(PUBKEY, "0x" + "0".repeat(39), 1_700_000_000, db),
        ).toThrow();
    });
});

describe("base_sync_cursor store", () => {
    it("returns the seeded (0, 0) cursor on a fresh db", () => {
        const cursor = getSyncCursor(db);
        expect(cursor).toEqual({ lastSyncedBlockNumber: 0, lastSyncedAt: 0 });
    });

    it("advances and re-reads", () => {
        advanceSyncCursor(41_852_000, 1_700_000_500_000, db);
        const cursor = getSyncCursor(db);
        expect(cursor.lastSyncedBlockNumber).toBe(41_852_000);
        expect(cursor.lastSyncedAt).toBe(1_700_000_500_000);
    });
});

describe("base_usdc_balance_cache store", () => {
    const ADDR = "0x4842925cf6b6671e8e1a25892bdea0807b4814fd";

    it("upserts and reads back", () => {
        upsertUsdcBalance(ADDR, 19_000_000n, 41_852_000, 1_700_000_500_000, db);
        const row = getUsdcBalance(ADDR, db);
        expect(row).not.toBeNull();
        expect(row!.balanceUnits).toBe(19_000_000n);
        expect(row!.asOfBlockNumber).toBe(41_852_000);
        expect(row!.asOfAt).toBe(1_700_000_500_000);
    });

    it("overwrites on second upsert (most recent wins)", () => {
        upsertUsdcBalance(ADDR, 19_000_000n, 41_852_000, 1_700_000_500_000, db);
        upsertUsdcBalance(ADDR, 18_000_000n, 41_852_100, 1_700_000_600_000, db);
        expect(getUsdcBalance(ADDR, db)!.balanceUnits).toBe(18_000_000n);
    });

    it("normalizes address case on write + read", () => {
        upsertUsdcBalance("0x4842925CF6B6671E8E1A25892BDEA0807B4814FD", 1n, 1, 1, db);
        expect(getUsdcBalance(ADDR.toUpperCase(), db)!.balanceUnits).toBe(1n);
    });

    it("returns null for an unknown wallet", () => {
        expect(getUsdcBalance("0x" + "0".repeat(40), db)).toBeNull();
    });

    it("handles very large balances (1e18 units = 1T USDC at 6 decimals)", () => {
        const huge = 10n ** 18n;
        upsertUsdcBalance(ADDR, huge, 1, 1, db);
        expect(getUsdcBalance(ADDR, db)!.balanceUnits).toBe(huge);
    });
});

describe("base_contract_state_cache store", () => {
    const ROUTER = "0xf1bc89974f8520b7f98e7cf0c689a7077af04c78";
    const FEE_RECIPIENT = "0x4842925cf6b6671e8e1a25892bdea0807b4814fd";

    it("returns null on a fresh db", () => {
        expect(getContractState(db)).toBeNull();
    });

    it("upserts and reads back", () => {
        upsertContractState({
            settlementRouterAddress: ROUTER,
            currentFeeBps: 0,
            isPaused: false,
            feeRecipientAddress: FEE_RECIPIENT,
            asOfBlockNumber: 41_852_000,
            asOfAt: 1_700_000_500_000,
        }, db);
        const row = getContractState(db);
        expect(row).not.toBeNull();
        expect(row!.currentFeeBps).toBe(0);
        expect(row!.isPaused).toBe(false);
        expect(row!.feeRecipientAddress).toBe(FEE_RECIPIENT);
        expect(row!.asOfBlockNumber).toBe(41_852_000);
    });

    it("overwrites on second upsert", () => {
        upsertContractState({
            settlementRouterAddress: ROUTER,
            currentFeeBps: 0,
            isPaused: false,
            feeRecipientAddress: FEE_RECIPIENT,
            asOfBlockNumber: 1,
            asOfAt: 1,
        }, db);
        upsertContractState({
            settlementRouterAddress: ROUTER,
            currentFeeBps: 25,
            isPaused: true,
            feeRecipientAddress: FEE_RECIPIENT,
            asOfBlockNumber: 2,
            asOfAt: 2,
        }, db);
        const row = getContractState(db)!;
        expect(row.currentFeeBps).toBe(25);
        expect(row.isPaused).toBe(true);
    });

    it("rejects feeBps > 10000 via CHECK constraint", () => {
        expect(() =>
            upsertContractState({
                settlementRouterAddress: ROUTER,
                currentFeeBps: 10_001,
                isPaused: false,
                feeRecipientAddress: FEE_RECIPIENT,
                asOfBlockNumber: 1,
                asOfAt: 1,
            }, db),
        ).toThrow();
    });
});
