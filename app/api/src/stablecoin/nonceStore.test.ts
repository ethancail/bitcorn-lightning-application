import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

vi.mock("../db", () => ({ db: new Database(":memory:") }));

import {
    consumeChallengeNonce,
    getChallengeNonce,
    getMemberOutstandingChallenges,
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
