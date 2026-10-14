import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

vi.mock("../db", () => ({ db: new Database(":memory:") }));

import {
    consumeChallengeNonce,
    getChallengeNonce,
    getMemberOutstandingChallenges,
    MAX_CHALLENGES_PER_MEMBER,
    sweepExpiredChallenges,
    upsertChallengeNonce,
} from "./nonceStore";

const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
const MIGRATIONS = ["043_member_base_wallet.sql", "048_siwe_challenge_nonce.sql"];

function newDb(): Database.Database {
    const d = new Database(":memory:");
    for (const m of MIGRATIONS) {
        d.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, m), "utf8"));
    }
    return d;
}

const MEMBER = "02" + "ab".repeat(32);
const WALLET = "0x4842925cf6b6671e8e1a25892bdea0807b4814fd";
const NONCE = "MfA3xPkLqRsTuVwXyZ";

let testDb: Database.Database;

beforeEach(() => {
    testDb = newDb();
});

describe("upsertChallengeNonce", () => {
    it("inserts a fresh row", () => {
        upsertChallengeNonce(MEMBER, WALLET, NONCE, 1_000_000, 1_001_000, testDb);
        const row = getChallengeNonce(MEMBER, WALLET, 1_000_500, testDb);
        expect(row).not.toBeNull();
        expect(row!.nonce).toBe(NONCE);
    });

    it("replaces an existing row on conflict (member, wallet)", () => {
        upsertChallengeNonce(MEMBER, WALLET, "FIRSTNONCE12345678", 1_000_000, 1_001_000, testDb);
        upsertChallengeNonce(MEMBER, WALLET, "SECONDNONCE9876543", 2_000_000, 2_001_000, testDb);
        const row = getChallengeNonce(MEMBER, WALLET, 2_000_500, testDb);
        expect(row!.nonce).toBe("SECONDNONCE9876543");
        expect(row!.issuedAt).toBe(2_000_000);
    });

    it("lowercases addresses on write", () => {
        upsertChallengeNonce(MEMBER, WALLET.toUpperCase(), NONCE, 1_000_000, 1_001_000, testDb);
        const row = getChallengeNonce(MEMBER, WALLET, 1_000_500, testDb);
        expect(row!.walletAddress).toBe(WALLET);
    });

    it("rejects malformed wallet address via CHECK constraint", () => {
        expect(() =>
            upsertChallengeNonce(MEMBER, "0xtooshort", NONCE, 1_000_000, 1_001_000, testDb),
        ).toThrow();
    });

    it("rejects nonce < 16 chars via CHECK constraint", () => {
        expect(() =>
            upsertChallengeNonce(MEMBER, WALLET, "tooshort", 1_000_000, 1_001_000, testDb),
        ).toThrow();
    });
});

describe("upsertChallengeNonce — per-member row cap", () => {
    const N = MAX_CHALLENGES_PER_MEMBER;
    const FAR = 9_000_000_000;

    // Distinct, CHECK-valid (0x + 40 hex) addresses.
    const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");
    const nonceFor = (i: number) => `nonce${String(i).padStart(12, "0")}`;

    function memberRows(): Array<{ id: number; wallet_address: string; issued_at: number }> {
        return testDb
            .prepare(
                `SELECT id, wallet_address, issued_at FROM siwe_challenge_nonce
                 WHERE member_pubkey = ? ORDER BY id`,
            )
            .all(MEMBER) as Array<{ id: number; wallet_address: string; issued_at: number }>;
    }

    it("keeps at most N rows per member — the newest N, including the last write", () => {
        for (let i = 1; i <= N + 3; i++) {
            upsertChallengeNonce(MEMBER, addr(i), nonceFor(i), 1_000_000 + i * 1_000, FAR, testDb);
        }
        const rows = memberRows();
        expect(rows.length).toBeLessThanOrEqual(N);
        const survivors = rows.map((r) => r.wallet_address).sort();
        const newestN = Array.from({ length: N }, (_, k) => addr(N + 3 - k)).sort();
        expect(survivors).toEqual(newestN);
        expect(survivors).toContain(addr(N + 3));
    });

    it("two wallets: challenge A then B, both still verifiable", () => {
        const A = addr(0xa);
        const B = addr(0xb);
        upsertChallengeNonce(MEMBER, A, "nonceAAAAAAAAAAAA", 1_000_000, FAR, testDb);
        upsertChallengeNonce(MEMBER, B, "nonceBBBBBBBBBBBB", 1_001_000, FAR, testDb);
        expect(getChallengeNonce(MEMBER, A, 1_002_000, testDb)?.nonce).toBe("nonceAAAAAAAAAAAA");
        expect(getChallengeNonce(MEMBER, B, 1_002_000, testDb)?.nonce).toBe("nonceBBBBBBBBBBBB");
    });

    it("same address twice updates in place: one row, same id, second nonce", () => {
        upsertChallengeNonce(MEMBER, WALLET, "FIRSTNONCE12345678", 1_000_000, FAR, testDb);
        const before = memberRows();
        upsertChallengeNonce(MEMBER, WALLET, "SECONDNONCE9876543", 2_000_000, FAR, testDb);
        const after = memberRows();
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe(before[0].id);
        expect(getChallengeNonce(MEMBER, WALLET, 2_000_500, testDb)?.nonce).toBe("SECONDNONCE9876543");
    });

    it("a same-millisecond issued_at tie is resolved by id (the later insert wins)", () => {
        // addr(1) and addr(2) tie at t=1_000_000; the next N-1 writes are strictly
        // newer, so the cap must evict exactly one of the tied pair — the lower id.
        upsertChallengeNonce(MEMBER, addr(1), nonceFor(1), 1_000_000, FAR, testDb);
        upsertChallengeNonce(MEMBER, addr(2), nonceFor(2), 1_000_000, FAR, testDb);
        for (let i = 3; i <= N + 1; i++) {
            upsertChallengeNonce(MEMBER, addr(i), nonceFor(i), 1_000_000 + i * 1_000, FAR, testDb);
        }
        const survivors = memberRows().map((r) => r.wallet_address).sort();
        const expected = Array.from({ length: N }, (_, k) => addr(k + 2)).sort();
        expect(survivors).toEqual(expected);
    });

    it("a just-written row with an older issued_at (clock stepped back) survives its own cap", () => {
        for (let i = 1; i <= N; i++) {
            upsertChallengeNonce(MEMBER, addr(i), nonceFor(i), 2_000_000 + i * 1_000, FAR, testDb);
        }
        const stepped = addr(0xbac);
        upsertChallengeNonce(MEMBER, stepped, "nonceSTEPPEDBACK0", 1_000_000, FAR, testDb);
        const rows = memberRows();
        expect(rows.length).toBeLessThanOrEqual(N);
        expect(getChallengeNonce(MEMBER, stepped, 1_000_500, testDb)?.nonce).toBe("nonceSTEPPEDBACK0");
        // The cap evicted the oldest OTHER row, not the one just written.
        expect(rows.map((r) => r.wallet_address)).not.toContain(addr(1));
    });
});

describe("getChallengeNonce", () => {
    it("returns null when no row exists", () => {
        expect(getChallengeNonce(MEMBER, WALLET, Date.now(), testDb)).toBeNull();
    });

    it("returns null when the row has expired", () => {
        upsertChallengeNonce(MEMBER, WALLET, NONCE, 1_000_000, 1_001_000, testDb);
        expect(getChallengeNonce(MEMBER, WALLET, 1_001_001, testDb)).toBeNull();
    });

    it("returns the row when within expiration window", () => {
        upsertChallengeNonce(MEMBER, WALLET, NONCE, 1_000_000, 1_001_000, testDb);
        const row = getChallengeNonce(MEMBER, WALLET, 1_000_999, testDb);
        expect(row).not.toBeNull();
    });
});

describe("consumeChallengeNonce", () => {
    it("removes the (member, wallet) row", () => {
        upsertChallengeNonce(MEMBER, WALLET, NONCE, 1_000_000, 1_001_000, testDb);
        consumeChallengeNonce(MEMBER, WALLET, testDb);
        expect(getChallengeNonce(MEMBER, WALLET, 1_000_500, testDb)).toBeNull();
    });

    it("does not affect other (member, wallet) pairs", () => {
        const otherWallet = "0xed503244e4e9bfd30315c9a022150c8302af817b";
        upsertChallengeNonce(MEMBER, WALLET, NONCE, 1_000_000, 1_001_000, testDb);
        upsertChallengeNonce(MEMBER, otherWallet, NONCE, 1_000_000, 1_001_000, testDb);
        consumeChallengeNonce(MEMBER, WALLET, testDb);
        expect(getChallengeNonce(MEMBER, WALLET, 1_000_500, testDb)).toBeNull();
        expect(getChallengeNonce(MEMBER, otherWallet, 1_000_500, testDb)).not.toBeNull();
    });
});

describe("getMemberOutstandingChallenges", () => {
    it("returns only non-expired rows for the member", () => {
        const otherWallet = "0xed503244e4e9bfd30315c9a022150c8302af817b";
        upsertChallengeNonce(MEMBER, WALLET, "fresh1234567890ab", 2_000_000, 2_001_000, testDb);
        upsertChallengeNonce(MEMBER, otherWallet, "expired12345678ab", 1_000_000, 1_001_000, testDb);
        const rows = getMemberOutstandingChallenges(MEMBER, 2_000_500, testDb);
        expect(rows).toHaveLength(1);
        expect(rows[0].nonce).toBe("fresh1234567890ab");
    });

    it("returns rows in descending issued_at order", () => {
        const otherWallet = "0xed503244e4e9bfd30315c9a022150c8302af817b";
        upsertChallengeNonce(MEMBER, WALLET, "older123456789012", 2_000_000, 3_000_000, testDb);
        upsertChallengeNonce(MEMBER, otherWallet, "newer123456789012", 2_500_000, 3_000_000, testDb);
        const rows = getMemberOutstandingChallenges(MEMBER, 2_750_000, testDb);
        expect(rows[0].nonce).toBe("newer123456789012");
        expect(rows[1].nonce).toBe("older123456789012");
    });
});

describe("sweepExpiredChallenges", () => {
    it("deletes only expired rows", () => {
        upsertChallengeNonce(MEMBER, WALLET, "fresh1234567890ab", 2_000_000, 3_000_000, testDb);
        upsertChallengeNonce(
            MEMBER,
            "0xed503244e4e9bfd30315c9a022150c8302af817b",
            "expired12345678ab",
            1_000_000,
            1_500_000,
            testDb,
        );
        const removed = sweepExpiredChallenges(2_500_000, testDb);
        expect(removed).toBe(1);
        expect(getMemberOutstandingChallenges(MEMBER, 2_500_000, testDb)).toHaveLength(1);
    });
});
