// Persistence for the pay-from-node settlement guard (migration 073).
//
// Source of truth: bitcorn-research/specs/2026-11-05-pay-from-node-spec.md §3
// and decisions/2026-11-05-pay-from-node-confirmation-by-echo-settlement-
// guard-and-price-ceiling.md D2.
//
// A marker is written, committed, before a subscription payment is broadcast,
// by both the manual route and the auto-pay scheduler (both go through
// executePayFromNode). It is "active" while cleared_at IS NULL, and only the
// clearing rule below clears it: the treasury's status showing the payment
// credited. Nothing here reads or writes any alert — dismissing an auto-pay
// alert can never lift the guard (spec §3.4).
//
// Takes the db handle as a parameter (like autoPayAlertStore.ts) so the SQL is
// testable against an in-memory database. Timestamps are epoch SECONDS;
// paid_through_at_write is whatever unit the status uses (ms), compared only
// against the status's own paid_through.

import type Database from "better-sqlite3";

export interface SendMarkerRow {
  id: number;
  member_pubkey: string;
  origin: "manual" | "auto";
  amount_sats: number;
  deposit_address: string;
  paid_through_at_write: number | null;
  last_payment_txid_at_write: string | null;
  created_at: number;
  txid: string | null;
  cleared_at: number | null;
  cleared_reason: string | null;
}

export interface NewSendMarker {
  member_pubkey: string;
  origin: "manual" | "auto";
  amount_sats: number;
  deposit_address: string;
  paid_through_at_write: number | null;
  last_payment_txid_at_write: string | null;
  created_at: number;
}

/** The status fields the clearing rule reads. */
export interface CreditState {
  paid_through: number | null;
  last_payment_txid: string | null;
}

/** Insert a marker; returns its id. Synchronous: the caller commits it before
 *  broadcasting. */
export function writeMarker(db: Database.Database, m: NewSendMarker): number {
  const info = db
    .prepare(
      `INSERT INTO subscription_send_marker
         (member_pubkey, origin, amount_sats, deposit_address,
          paid_through_at_write, last_payment_txid_at_write, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.member_pubkey,
      m.origin,
      m.amount_sats,
      m.deposit_address,
      m.paid_through_at_write,
      m.last_payment_txid_at_write,
      m.created_at,
    );
  return Number(info.lastInsertRowid);
}

/** Record the txid the broadcast returned. */
export function setMarkerTxid(db: Database.Database, id: number, txid: string): void {
  db.prepare(`UPDATE subscription_send_marker SET txid = ? WHERE id = ?`).run(txid, id);
}

/** Active markers for a member, oldest first. */
export function listActiveMarkers(db: Database.Database, memberPubkey: string): SendMarkerRow[] {
  return db
    .prepare(
      `SELECT * FROM subscription_send_marker
       WHERE member_pubkey = ? AND cleared_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all(memberPubkey) as SendMarkerRow[];
}

/**
 * The clearing rule (spec §6 Q1(a), ruled 2026-11-05): a marker clears ON
 * CREDIT and on nothing else — when the status's last_payment_txid equals the
 * marker's txid, or its paid_through is later than the paid_through the marker
 * recorded. The second clause also clears a txid-less marker left by a crash
 * between write and broadcast. No timeout clears a marker.
 *
 * Note (accepted 2026-11-05, Phase 1 O8): one credit advances paid_through, so
 * it clears every marker written before it, including a deliberate second
 * payment not yet confirmed. Auto-pay fires only in a lapsed tier, which that
 * credit has just left.
 *
 * Returns the number of markers cleared.
 */
export function clearMarkersOnCredit(
  db: Database.Database,
  memberPubkey: string,
  credit: CreditState,
  nowSec: number,
): number {
  let cleared = 0;
  if (credit.last_payment_txid) {
    cleared += db
      .prepare(
        `UPDATE subscription_send_marker
         SET cleared_at = ?, cleared_reason = 'credited_txid'
         WHERE member_pubkey = ? AND cleared_at IS NULL
           AND txid IS NOT NULL AND txid = ?`,
      )
      .run(nowSec, memberPubkey, credit.last_payment_txid).changes;
  }
  if (credit.paid_through != null) {
    cleared += db
      .prepare(
        `UPDATE subscription_send_marker
         SET cleared_at = ?, cleared_reason = 'credited_paid_through'
         WHERE member_pubkey = ? AND cleared_at IS NULL
           AND paid_through_at_write IS NOT NULL AND ? > paid_through_at_write`,
      )
      .run(nowSec, memberPubkey, credit.paid_through).changes;
  }
  return cleared;
}
