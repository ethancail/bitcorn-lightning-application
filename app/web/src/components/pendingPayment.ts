// The "payment sent, waiting for confirmation" state (drive-mode R45, ruling
// 1), for the Settings subscription panel and the dashboard banner.
//
// The marker comes from GET /api/subscription/pay-from-node/pending, which
// reads this node's database and clears nothing. The API clears a marker on
// the auto-pay scheduler's 60 s tick (clearMarkersOnCredit), but the status
// shows a credit as soon as the treasury's 15 s scan writes it. So the web
// applies the same rule itself, to avoid "waiting" beside "paid up" for up to
// a minute: hidden once the status's last_payment_txid is the marker's txid,
// or its paid_through is later than the one the marker recorded.
//
// It trusts a credit ONLY from a verified status (treasury_signature
// "verified"). Under an unsigned, invalid or unverifiable status, or one
// missing the label, the credit could be forged to hide a payment still in
// flight, so the state stays (treasury-price-trust R5 also skips clearing on
// an unverified status, so the marker stays too).

import { fmtSats, type PendingPayment, type SubscriptionStatus } from "../api/client";
import { formatDistanceStrict } from "date-fns";

export type PendingView = {
  /** false when the marker has no txid: the broadcast never returned, so the
   *  payment may not have been sent. */
  sent: boolean;
  amount_sats: number;
  sent_at: number; // unix seconds
};

/** Whether the waiting state shows, and what it shows; null hides it. */
export function pendingPaymentView(
  pending: PendingPayment | null | undefined,
  status: SubscriptionStatus | null | undefined,
): PendingView | null {
  if (!pending) return null;
  if (status && status.applicable === true && status.treasury_signature === "verified") {
    if (pending.txid && status.last_payment_txid === pending.txid) return null;
    if (pending.paid_through_at_write != null && status.paid_through > pending.paid_through_at_write) return null;
  }
  return { sent: pending.txid != null, amount_sats: pending.amount_sats, sent_at: pending.sent_at };
}

/** The state's words, the same on both surfaces. The amount already sent is
 *  in sats only: today's rate would misstate it (pay-from-node G3 ruling R7;
 *  R45 Q9). A marker without a txid says "may have sent" (R45 Q2). The
 *  headline has no full stop, like the banner's other headlines. */
export function pendingPaymentCopy(view: PendingView, nowMs: number): { headline: string; body: string } {
  const amount = fmtSats(view.amount_sats);
  const ago = formatDistanceStrict(view.sent_at * 1000, nowMs, { addSuffix: true, roundingMethod: "floor" });
  return view.sent
    ? {
        headline: "Payment sent, waiting for confirmation",
        body: `Your node sent ${amount} ${ago}. It counts after its first confirmation, usually within an hour.`,
      }
    : {
        headline: "Payment may have been sent",
        body: `Your node may have sent ${amount} ${ago}. If it did, it counts once it's confirmed.`,
      };
}
