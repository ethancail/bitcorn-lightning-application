// The member's pinned subscription deposit address (migration 083).
//
// Source of truth: bitcorn-research specs/2026-11-10-treasury-price-trust-
// spec.md §6 (D4). Takes the db handle as a parameter (like sendMarker.ts) so
// the SQL is testable against an in-memory database.
//
// - First sight (§6.2): on the first VERIFIED, applicable status with no pin
//   row, pin the newest send marker's address if this node has ever paid
//   (marker_seed), else the stated address (first_sight). Never from an
//   unverified response — callers only reach ensurePin with a verified body.
// - Comparison: exact string equality. A case-only difference is a change,
//   the safe direction.
// - Change (§6.3): no path here writes a pin for a new address except
//   appendAcknowledgedPin, which only the host command calls (§6.4).

import type Database from "better-sqlite3";

export type PinSource = "first_sight" | "marker_seed" | "acknowledged";

export interface PinRow {
  id: number;
  member_pubkey: string;
  deposit_address: string;
  source: PinSource;
  pinned_at: number;
}

/** The current pin: the member's newest row, or null when none exists. */
export function getCurrentPin(db: Database.Database, memberPubkey: string): PinRow | null {
  const row = db
    .prepare(
      `SELECT id, member_pubkey, deposit_address, source, pinned_at
       FROM subscription_deposit_address_pin
       WHERE member_pubkey = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(memberPubkey) as PinRow | undefined;
  return row ?? null;
}

function insertPin(
  db: Database.Database,
  memberPubkey: string,
  address: string,
  source: PinSource,
  nowSec: number,
): PinRow {
  const info = db
    .prepare(
      `INSERT INTO subscription_deposit_address_pin
         (member_pubkey, deposit_address, source, pinned_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(memberPubkey, address, source, nowSec);
  return {
    id: Number(info.lastInsertRowid),
    member_pubkey: memberPubkey,
    deposit_address: address,
    source,
    pinned_at: nowSec,
  };
}

/**
 * Return the current pin, writing the first one if there is none. Idempotent:
 * once a pin exists this only reads. Call ONLY with the address of a verified,
 * applicable status. One transaction, so two first sights cannot both write.
 */
export function ensurePin(
  db: Database.Database,
  memberPubkey: string,
  statedAddress: string,
  nowSec: number,
): PinRow {
  return db.transaction((): PinRow => {
    const current = getCurrentPin(db, memberPubkey);
    if (current) return current;
    const lastPaid = db
      .prepare(
        `SELECT deposit_address FROM subscription_send_marker
         WHERE member_pubkey = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(memberPubkey) as { deposit_address: string } | undefined;
    return lastPaid
      ? insertPin(db, memberPubkey, lastPaid.deposit_address, "marker_seed", nowSec)
      : insertPin(db, memberPubkey, statedAddress, "first_sight", nowSec);
  })();
}

/** Append an `acknowledged` pin. Only the host command (§6.4) calls this; no
 *  3101 route may (control C11 scans for that). */
export function appendAcknowledgedPin(
  db: Database.Database,
  memberPubkey: string,
  address: string,
  nowSec: number,
): PinRow {
  return insertPin(db, memberPubkey, address, "acknowledged", nowSec);
}
