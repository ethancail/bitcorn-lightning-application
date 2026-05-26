// SQLite read/write helpers for siwe_challenge_nonce.
//
// Spec: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §2
//
// The nonce table is per-(member_pubkey, wallet_address) with the
// UNIQUE constraint on that pair (migration 048). A second challenge
// for the same pair REPLACES the first via UPSERT — convenient for the
// case where a member retries the wallet-connect flow after a wallet
// disconnection or timeout, without leaving stale rows lying around.
//
// Idempotency expectation matches the base/store.ts pattern: every
// function accepts an optional `database` parameter that defaults to
// the singleton import. Production callers omit it; tests pass an
// in-memory db with migration 048 applied.

import type Database from "better-sqlite3";
import { db as defaultDb } from "../db";
import type { SiweChallengeNonceRow } from "./types";

type Db = Database.Database;

/**
 * Insert or replace a challenge nonce. A second challenge for the same
 * (member, wallet) replaces the first — the older nonce is invalidated.
 */
export function upsertChallengeNonce(
    memberPubkey: string,
    walletAddress: string,
    nonce: string,
    issuedAt: number,
    expiresAt: number,
    database: Db = defaultDb,
): void {
    database
        .prepare(
            `INSERT INTO siwe_challenge_nonce
                 (member_pubkey, wallet_address, nonce, issued_at, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(member_pubkey, wallet_address) DO UPDATE SET
                 nonce = excluded.nonce,
                 issued_at = excluded.issued_at,
                 expires_at = excluded.expires_at`,
        )
        .run(memberPubkey.toLowerCase(), walletAddress.toLowerCase(), nonce, issuedAt, expiresAt);
}

/**
 * Look up an outstanding challenge for a member+wallet pair. Returns null
 * if no row exists or if the row has expired. Expired rows are NOT
 * automatically deleted — they linger until a janitorial sweep or until
 * a new challenge UPSERTs over them.
 */
export function getChallengeNonce(
    memberPubkey: string,
    walletAddress: string,
    nowMs: number = Date.now(),
    database: Db = defaultDb,
): SiweChallengeNonceRow | null {
    const row = database
        .prepare(
            `SELECT id, member_pubkey, wallet_address, nonce, issued_at, expires_at
             FROM siwe_challenge_nonce
             WHERE member_pubkey = ? AND wallet_address = ?`,
        )
        .get(memberPubkey.toLowerCase(), walletAddress.toLowerCase()) as
        | {
              id: number;
              member_pubkey: string;
              wallet_address: string;
              nonce: string;
              issued_at: number;
              expires_at: number;
          }
        | undefined;
    if (!row) return null;
    if (row.expires_at <= nowMs) return null;
    return {
        id: row.id,
        memberPubkey: row.member_pubkey,
        walletAddress: row.wallet_address,
        nonce: row.nonce,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
    };
}

/**
 * Look up a challenge by member alone — used by the verify endpoint
 * which receives just the message + signature (the wallet_address is
 * extracted from the parsed message). Returns the most recently issued
 * non-expired challenge for the member, or null.
 *
 * This is a member-scoped lookup so a malicious caller can't substitute
 * another member's nonce. The member_pubkey is the local node's pubkey;
 * the API trusts the local origin.
 */
export function getMemberOutstandingChallenges(
    memberPubkey: string,
    nowMs: number = Date.now(),
    database: Db = defaultDb,
): SiweChallengeNonceRow[] {
    const rows = database
        .prepare(
            `SELECT id, member_pubkey, wallet_address, nonce, issued_at, expires_at
             FROM siwe_challenge_nonce
             WHERE member_pubkey = ? AND expires_at > ?
             ORDER BY issued_at DESC`,
        )
        .all(memberPubkey.toLowerCase(), nowMs) as Array<{
            id: number;
            member_pubkey: string;
            wallet_address: string;
            nonce: string;
            issued_at: number;
            expires_at: number;
        }>;
    return rows.map((r) => ({
        id: r.id,
        memberPubkey: r.member_pubkey,
        walletAddress: r.wallet_address,
        nonce: r.nonce,
        issuedAt: r.issued_at,
        expiresAt: r.expires_at,
    }));
}

/** Consume (delete) a challenge after successful verification. One-shot use. */
export function consumeChallengeNonce(
    memberPubkey: string,
    walletAddress: string,
    database: Db = defaultDb,
): void {
    database
        .prepare(
            `DELETE FROM siwe_challenge_nonce
             WHERE member_pubkey = ? AND wallet_address = ?`,
        )
        .run(memberPubkey.toLowerCase(), walletAddress.toLowerCase());
}

/** Janitorial sweep: delete all expired challenges. Safe to call periodically. */
export function sweepExpiredChallenges(
    nowMs: number = Date.now(),
    database: Db = defaultDb,
): number {
    const result = database
        .prepare(`DELETE FROM siwe_challenge_nonce WHERE expires_at <= ?`)
        .run(nowMs);
    return result.changes;
}
