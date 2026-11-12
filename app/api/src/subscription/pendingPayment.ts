// The "payment sent, waiting for confirmation" read (drive-mode R45, ruling 1).
//
// The newest active send marker (migration 073) for this member, shaped for
// the web: GET /api/subscription/pay-from-node/pending. Read-only: it never
// fetches the treasury's status and never clears a marker. Clearing stays with
// clearMarkersOnCredit (sendMarker.ts), so reading this can never lift the
// pay-from-node double-send guard. The web decides when to stop showing it
// (pendingPaymentView in web/src/components/pendingPayment.ts).

import type Database from "better-sqlite3";
import { listActiveMarkers } from "./sendMarker";

export interface PendingPayment {
  amount_sats: number;
  /** null while the broadcast has not returned, or after it threw: the
   *  payment may not have been sent. */
  txid: string | null;
  /** The marker's created_at, epoch seconds: written just before the
   *  broadcast. */
  sent_at: number;
  origin: "manual" | "auto";
  /** The status's paid_through (ms) when the marker was written. */
  paid_through_at_write: number | null;
  /** Active markers for this member, the newest included. */
  count: number;
}

export function pendingPaymentOf(db: Database.Database, memberPubkey: string): PendingPayment | null {
  const active = listActiveMarkers(db, memberPubkey); // oldest first
  const newest = active[active.length - 1];
  if (!newest) return null;
  return {
    amount_sats: newest.amount_sats,
    txid: newest.txid,
    sent_at: newest.created_at,
    origin: newest.origin,
    paid_through_at_write: newest.paid_through_at_write,
    count: active.length,
  };
}
