// drive-mode P2, the renewal alerts:
//   item 11 (R6(a), D2.4) — the warning before services pause. From P
//     (paid_through) until grace.worker_until the tier is still "current" and
//     hosted services still run; the banner says when they pause, with Renew.
//     The dates are the status's own, never a literal 7 days (R27(11): it
//     starts at P).
//   item 12 — services paused (worker_lapsed) carries the dollar amount, with
//     the sats beside it; no rate, sats only.
// The other tiers' copy is unchanged.

import { describe, it, expect } from "vitest";
import { bannerFor } from "./subscriptionBanner";
import type { SubscriptionStatusApplicable, SubscriptionTier } from "../api/client";

const DAY = 86_400_000;
const P = 1_790_000_000_000; // paid_through
const WORKER_UNTIL = P + 9 * DAY; // not 7: the banner must read the status's date
const RATE = 60_000; // 50,000 sats → $30.00

const status = (tier: SubscriptionTier): SubscriptionStatusApplicable => ({
  applicable: true,
  member_pubkey: "02abc",
  current_tier: tier,
  paid_through: P,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bc1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: WORKER_UNTIL, routing_until: P + 30 * DAY, close_at: P + 60 * DAY },
});

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

describe("item 11, D2.4: the warning before hosted services pause", () => {
  it("at P (paid through today): the warning, dated from grace.worker_until, with Renew", () => {
    const d = bannerFor(status("current"), P, RATE);
    expect(d.render).toBe(true);
    expect(d.severity).toBe("amber");
    expect(d.headline).toBe(`Hosted services pause on ${date(WORKER_UNTIL)}`); // R34 item 6: no full stop
    expect(d.body).toBe("Renew for $30.00 (50,000 sats) before then to keep them running.");
    expect(d.actionLabel).toBe("Renew $30.00");
  });

  it("at P minus 8 days: nothing", () => {
    expect(bannerFor(status("current"), P - 8 * DAY, RATE).render).toBe(false);
  });

  it("one day before P: nothing (the warning starts at P, R27(11))", () => {
    expect(bannerFor(status("current"), P - DAY, RATE).render).toBe(false);
  });

  it("the last moment before the pause: still the warning", () => {
    expect(bannerFor(status("current"), WORKER_UNTIL - 1, RATE).headline).toBe(`Hosted services pause on ${date(WORKER_UNTIL)}`);
  });

  it("past worker_until the server's tier is worker_lapsed: the paused banner, not the warning", () => {
    const d = bannerFor(status("worker_lapsed"), WORKER_UNTIL + DAY, RATE);
    expect(d.headline).toBe("Action needed: hosted services lapsed");
    expect(d.headline).not.toContain("pause on");
  });

  it("no rate: the sats alone", () => {
    const d = bannerFor(status("current"), P, null);
    expect(d.body).toBe("Renew for 50,000 sats before then to keep them running.");
    expect(d.actionLabel).toBe("Renew 50,000 sats");
  });
});

describe("item 12: services paused carries the dollar amount", () => {
  it("with a rate: dollars, the sats beside them", () => {
    const d = bannerFor(status("worker_lapsed"), WORKER_UNTIL + DAY, RATE);
    expect(d.body).toBe(
      `Your subscription lapsed on ${date(P)}. Hosted services are paused; your channel and routing still work. ` +
      "Renew for $30.00 (50,000 sats) to restore.",
    );
    expect(d.actionLabel).toBe("Renew $30.00");
  });

  it("no rate: sats only", () => {
    const d = bannerFor(status("worker_lapsed"), WORKER_UNTIL + DAY, null);
    expect(d.body).toContain("Renew for 50,000 sats to restore.");
    expect(d.actionLabel).toBe("Renew 50,000 sats");
  });

  it("the other tiers are unchanged by a rate", () => {
    expect(bannerFor(status("routing_lapsed"), P + 31 * DAY, RATE).actionLabel).toBe("Renew 50,000 sats");
    expect(bannerFor(status("prepay"), P, RATE).actionLabel).toBe("Pay 50,000 sats");
  });
});
