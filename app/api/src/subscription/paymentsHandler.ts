// Subscription payment-history response shaping.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §5.1 (member-local proxy pattern; this endpoint
//     follows the same template as /api/subscription/status)
//   - app/api/src/db/migrations/036_member_subscription.sql §subscription_payment
//
// The /api/subscription/payments route runs on every node. Treasury
// computes the response by reading the subscription_payment ledger
// scoped to the JWT-subject pubkey. Members validate the caller's
// JWT locally for fast-path 401/503, then forward to treasury and
// return the unmodified response — exact same shape as the /status
// proxy in app/api/src/index.ts.
//
// Sort order: `received_at DESC` is the primary sort. The grandfather
// admin_override sentinel (kind='admin_override', confirmed_at=NULL,
// received_at=allocation_time) correctly sorts to the bottom of an
// active member's history. Sorting by confirmed_at DESC would have
// surfaced the sentinel at the top alongside any genuinely-pending
// payments — wrong shape for the user's mental model.

import { db } from "../db";

export interface SubscriptionPaymentRow {
  id: number;
  txid: string | null;
  vout: number | null;
  amount_sats: number;
  amount_usd_cents_at_receipt: number | null;
  received_at: number;
  confirmed_at: number | null;
  period_extension_days: number;
  kind: "onchain" | "admin_override";
  admin_reason: string | null;
  /**
   * Derived status for UI rendering. Saves the client from re-implementing
   * the same discrimination logic. Reads:
   *   - "admin_override" — manual override / grandfather sentinel
   *   - "pending"        — kind='onchain' AND confirmed_at IS NULL
   *   - "confirmed"      — kind='onchain' AND confirmed_at IS NOT NULL
   */
  status: "confirmed" | "pending" | "admin_override";
}

export interface SubscriptionPaymentsResponse {
  member_pubkey: string;
  payments: SubscriptionPaymentRow[];
}

interface PaymentLedgerRow {
  id: number;
  txid: string | null;
  vout: number | null;
  amount_sats: number;
  amount_usd_cents_at_receipt: number | null;
  received_at: number;
  confirmed_at: number | null;
  period_extension_days: number;
  kind: "onchain" | "admin_override";
  admin_reason: string | null;
}

/**
 * Returns the subscription_payment ledger for a single member, ordered
 * most-recent-activity first. Pure of HTTP — caller wires to a 200.
 *
 * Returns an empty `payments` array if the member has no rows (e.g.,
 * prepay member who hasn't made their first payment yet). The endpoint
 * does NOT 404 — empty history is a valid state.
 */
export function computePaymentHistoryForPubkey(
  memberPubkey: string,
): SubscriptionPaymentsResponse {
  const pubkey = memberPubkey.toLowerCase();
  const rows = db
    .prepare(
      `SELECT id, txid, vout, amount_sats, amount_usd_cents_at_receipt,
              received_at, confirmed_at, period_extension_days,
              kind, admin_reason
       FROM subscription_payment
       WHERE member_pubkey = ?
       ORDER BY received_at DESC, id DESC`,
    )
    .all(pubkey) as PaymentLedgerRow[];

  return {
    member_pubkey: pubkey,
    payments: rows.map((r) => ({
      ...r,
      status:
        r.kind === "admin_override"
          ? "admin_override"
          : r.confirmed_at === null
            ? "pending"
            : "confirmed",
    })),
  };
}
