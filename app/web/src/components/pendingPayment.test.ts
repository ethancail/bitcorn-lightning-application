// drive-mode R45, ruling 1: when the "payment sent, waiting for confirmation"
// state shows, and what it says.
//
// pendingPaymentView hides the state once the status shows the credit — the
// treasury's last_payment_txid is the marker's txid, or paid_through moved
// past the paid_through the marker recorded (the same rule as the API's
// clearMarkersOnCredit, which only runs on the scheduler's 60 s tick). It
// trusts that only from a VERIFIED status: under an unverified one, a
// "credited" status could be forged to hide a payment still in flight.
//
// ⚠ PRE-CHANGE RUN: red at 297429d — the module did not exist.

import { describe, it, expect } from "vitest";
import { pendingPaymentView, pendingPaymentCopy } from "./pendingPayment";
import type { PendingPayment, SubscriptionStatusApplicable } from "../api/client";

const P_AT_WRITE = 1_790_000_000_000;
const TXID = "ab".repeat(32);
const SENT_AT = 1_790_000_100; // seconds

const pending = (over: Partial<PendingPayment> = {}): PendingPayment => ({
  amount_sats: 50_000,
  txid: TXID,
  sent_at: SENT_AT,
  origin: "manual",
  paid_through_at_write: P_AT_WRITE,
  count: 1,
  ...over,
});

const status = (over: Partial<SubscriptionStatusApplicable> = {}): SubscriptionStatusApplicable => ({
  applicable: true,
  member_pubkey: "02abc",
  current_tier: "routing_lapsed",
  paid_through: P_AT_WRITE,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bc1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: 0, routing_until: 0, close_at: 0 },
  treasury_signature: "verified",
  treasury_signature_reason: null,
  treasury_pay_refusal: null,
  ...over,
});

describe("pendingPaymentView — when the waiting state shows", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it("no marker → hidden", () => {
    expect(pendingPaymentView(null, status())).toBeNull();
    expect(pendingPaymentView(undefined, status())).toBeNull();
  });

  it("PERMITTING CONTROL: a marker, not yet credited → shown, with what was sent", () => {
    expect(pendingPaymentView(pending(), status())).toEqual({ sent: true, amount_sats: 50_000, sent_at: SENT_AT });
  });

  it("a txid-less marker → shown, as maybe sent", () => {
    expect(pendingPaymentView(pending({ txid: null }), status())).toMatchObject({ sent: false });
  });

  it("verified, the status's last payment is the marker's txid → hidden", () => {
    expect(pendingPaymentView(pending(), status({ last_payment_txid: TXID }))).toBeNull();
  });

  it("verified, paid_through later than at write → hidden (also clears a txid-less marker)", () => {
    expect(pendingPaymentView(pending(), status({ paid_through: P_AT_WRITE + 1 }))).toBeNull();
    expect(pendingPaymentView(pending({ txid: null }), status({ paid_through: P_AT_WRITE + 1 }))).toBeNull();
  });

  it("verified, a different txid and paid_through unchanged → still shown", () => {
    expect(pendingPaymentView(pending(), status({ last_payment_txid: "cd".repeat(32) }))).not.toBeNull();
  });

  it("a txid-less marker never matches a txid-less status", () => {
    expect(pendingPaymentView(pending({ txid: null }), status({ last_payment_txid: null }))).not.toBeNull();
  });

  it.each(["unsigned", "invalid", "unverifiable"] as const)(
    "%s status claiming the credit → still shown (never hidden on an unverified credit)",
    (sig) => {
      const credited = { treasury_signature: sig, last_payment_txid: TXID, paid_through: P_AT_WRITE + 30 * 86_400_000 };
      expect(pendingPaymentView(pending(), status(credited))).not.toBeNull();
    },
  );

  it("both labels absent, claiming the credit → still shown (absent is not verified)", () => {
    const s = status({ last_payment_txid: TXID, paid_through: P_AT_WRITE + 1 });
    delete (s as any).treasury_signature;
    delete (s as any).treasury_pay_refusal;
    expect(pendingPaymentView(pending(), s)).not.toBeNull();
  });

  it("no status at all → shown (nothing shows the credit)", () => {
    expect(pendingPaymentView(pending(), null)).not.toBeNull();
  });
});

describe("pendingPaymentCopy — what the state says", () => {
  const NOW = (SENT_AT + 12 * 60) * 1000; // 12 minutes after the send

  it("sent: the amount in sats only, how long ago, and when it counts", () => {
    const c = pendingPaymentCopy({ sent: true, amount_sats: 50_000, sent_at: SENT_AT }, NOW);
    expect(c.headline).toBe("Payment sent, waiting for confirmation");
    expect(c.body).toBe(
      "Your node sent 50,000 sats 12 minutes ago. It counts after its first confirmation, usually within an hour.",
    );
  });

  it("txid-less: 'may have sent', never 'sent'", () => {
    const c = pendingPaymentCopy({ sent: false, amount_sats: 50_000, sent_at: SENT_AT }, NOW);
    expect(c.headline).toBe("Payment may have been sent");
    expect(c.body).toBe("Your node may have sent 50,000 sats 12 minutes ago. If it did, it counts once it's confirmed.");
    expect(`${c.headline} ${c.body}`).not.toMatch(/\bnode sent\b|Payment sent/);
  });

  it("never a dollar figure (an amount already sent: G3 ruling R7, Q9)", () => {
    for (const sent of [true, false]) {
      const c = pendingPaymentCopy({ sent, amount_sats: 50_000, sent_at: SENT_AT }, NOW);
      expect(`${c.headline} ${c.body}`).not.toContain("$");
    }
  });
});
