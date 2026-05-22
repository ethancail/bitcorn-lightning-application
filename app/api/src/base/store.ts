// SQLite read/write helpers for the BASE sync subsystem.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7
//
// Every function accepts an optional `database` parameter that defaults
// to the singleton import from `../db`. Production callers omit the
// parameter; tests pass an in-memory database with the migrations
// applied. This keeps the production call sites clean while making the
// store fully unit-testable.

import type Database from "better-sqlite3";
import { db as defaultDb } from "../db";
import type {
    BaseContractStateCacheRow,
    BaseSyncCursorRow,
    BaseUsdcBalanceCacheRow,
    MemberBaseWalletRow,
} from "./types";

type Db = Database.Database;

// -----------------------------------------------------------------------
// member_base_wallet
// -----------------------------------------------------------------------

export function listActiveBaseWallets(database: Db = defaultDb): MemberBaseWalletRow[] {
    const rows = database
        .prepare(
            `SELECT id, member_pubkey, wallet_address, registered_at, is_active
             FROM member_base_wallet
             WHERE is_active = 1
             ORDER BY registered_at ASC`,
        )
        .all() as Array<{
            id: number;
            member_pubkey: string;
            wallet_address: string;
            registered_at: number;
            is_active: number;
        }>;
    return rows.map((r) => ({
        id: r.id,
        memberPubkey: r.member_pubkey,
        walletAddress: r.wallet_address.toLowerCase(),
        registeredAt: r.registered_at,
        isActive: r.is_active === 1,
    }));
}

/**
 * Insert or reactivate a member's wallet. Used by the §8.1 registration
 * UI when a member declares their BASE address. Idempotent: if the same
 * (pubkey, address) is registered again, only the registered_at and
 * is_active flag are touched.
 */
export function upsertMemberBaseWallet(
    memberPubkey: string,
    walletAddress: string,
    registeredAt: number,
    database: Db = defaultDb,
): void {
    const lc = walletAddress.toLowerCase();
    database
        .prepare(
            `INSERT INTO member_base_wallet (member_pubkey, wallet_address, registered_at, is_active)
             VALUES (?, ?, ?, 1)
             ON CONFLICT(member_pubkey) DO UPDATE SET
                 wallet_address = excluded.wallet_address,
                 registered_at = excluded.registered_at,
                 is_active = 1`,
        )
        .run(memberPubkey, lc, registeredAt);
}

// -----------------------------------------------------------------------
// base_sync_cursor (singleton)
// -----------------------------------------------------------------------

export function getSyncCursor(database: Db = defaultDb): BaseSyncCursorRow {
    const row = database
        .prepare(`SELECT last_synced_block_number, last_synced_at FROM base_sync_cursor WHERE id = 1`)
        .get() as { last_synced_block_number: number; last_synced_at: number } | undefined;
    // Migration 044 seeds (0, 0); only missing if migrations haven't run.
    return {
        lastSyncedBlockNumber: row?.last_synced_block_number ?? 0,
        lastSyncedAt: row?.last_synced_at ?? 0,
    };
}

export function advanceSyncCursor(
    blockNumber: number,
    at: number,
    database: Db = defaultDb,
): void {
    database
        .prepare(
            `UPDATE base_sync_cursor
             SET last_synced_block_number = ?, last_synced_at = ?
             WHERE id = 1`,
        )
        .run(blockNumber, at);
}

// -----------------------------------------------------------------------
// base_usdc_balance_cache
// -----------------------------------------------------------------------

export function upsertUsdcBalance(
    walletAddress: string,
    balanceUnits: bigint,
    asOfBlockNumber: number,
    asOfAt: number,
    database: Db = defaultDb,
): void {
    database
        .prepare(
            `INSERT INTO base_usdc_balance_cache (wallet_address, balance_units, as_of_block_number, as_of_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(wallet_address) DO UPDATE SET
                 balance_units = excluded.balance_units,
                 as_of_block_number = excluded.as_of_block_number,
                 as_of_at = excluded.as_of_at`,
        )
        .run(walletAddress.toLowerCase(), balanceUnits.toString(), asOfBlockNumber, asOfAt);
}

export function getUsdcBalance(
    walletAddress: string,
    database: Db = defaultDb,
): BaseUsdcBalanceCacheRow | null {
    const row = database
        .prepare(
            `SELECT wallet_address, balance_units, as_of_block_number, as_of_at
             FROM base_usdc_balance_cache
             WHERE wallet_address = ?`,
        )
        .get(walletAddress.toLowerCase()) as
        | {
              wallet_address: string;
              balance_units: string;
              as_of_block_number: number;
              as_of_at: number;
          }
        | undefined;
    if (!row) return null;
    return {
        walletAddress: row.wallet_address,
        balanceUnits: BigInt(row.balance_units),
        asOfBlockNumber: row.as_of_block_number,
        asOfAt: row.as_of_at,
    };
}

// -----------------------------------------------------------------------
// base_contract_state_cache (singleton)
// -----------------------------------------------------------------------

export function upsertContractState(
    state: {
        settlementRouterAddress: string;
        currentFeeBps: number;
        isPaused: boolean;
        feeRecipientAddress: string;
        asOfBlockNumber: number;
        asOfAt: number;
    },
    database: Db = defaultDb,
): void {
    database
        .prepare(
            `INSERT INTO base_contract_state_cache
                 (id, settlement_router_address, current_fee_bps, is_paused,
                  fee_recipient_address, as_of_block_number, as_of_at)
             VALUES (1, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 settlement_router_address = excluded.settlement_router_address,
                 current_fee_bps = excluded.current_fee_bps,
                 is_paused = excluded.is_paused,
                 fee_recipient_address = excluded.fee_recipient_address,
                 as_of_block_number = excluded.as_of_block_number,
                 as_of_at = excluded.as_of_at`,
        )
        .run(
            state.settlementRouterAddress.toLowerCase(),
            state.currentFeeBps,
            state.isPaused ? 1 : 0,
            state.feeRecipientAddress.toLowerCase(),
            state.asOfBlockNumber,
            state.asOfAt,
        );
}

export function getContractState(database: Db = defaultDb): BaseContractStateCacheRow | null {
    const row = database
        .prepare(
            `SELECT settlement_router_address, current_fee_bps, is_paused,
                    fee_recipient_address, as_of_block_number, as_of_at
             FROM base_contract_state_cache WHERE id = 1`,
        )
        .get() as
        | {
              settlement_router_address: string;
              current_fee_bps: number;
              is_paused: number;
              fee_recipient_address: string;
              as_of_block_number: number;
              as_of_at: number;
          }
        | undefined;
    if (!row) return null;
    return {
        settlementRouterAddress: row.settlement_router_address,
        currentFeeBps: row.current_fee_bps,
        isPaused: row.is_paused === 1,
        feeRecipientAddress: row.fee_recipient_address,
        asOfBlockNumber: row.as_of_block_number,
        asOfAt: row.as_of_at,
    };
}
