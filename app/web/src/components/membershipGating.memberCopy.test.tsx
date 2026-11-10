// Membership-gating slice 3, the member's copy (spec §2 M2; DW5, DW6; pass 10
// items 1, C, D; Ethan's Phase 2 split of item 1 into headline and body).
//
//   M2 item 1 — ConnectToHub shows R7's app-check message when the API answers
//               `membership_not_paid` (from its app check or the hub's acceptor).
//   M2 item 3 — the subscription panel's routing_lapsed render gets the banner's
//               rewrite (item C): no routing claim in the pill, the alert or the
//               timeline. The banner itself is pinned in subscriptionBanner.test.ts.
//   M2 item 4 — the pre-pause banner is unchanged and, with worker_until at
//               paid_through + 30d (T2), shows for 30 days (item D).
//
// ⚠ THE STRINGS ARE HARDCODED HERE, not imported from the descriptor: a test
// that imports the constant it checks cannot notice the constant changing.
//
// Harness: SubscriptionPanel.p2.test.tsx's (createRoot + act, no RTL).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") },
}));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoPayHistory: vi.fn(),
  getTreasuryInfo: vi.fn(),
  openMemberChannel: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "./SubscriptionPanel";
import { useConnectToHub } from "./firstRun/useConnectToHub";
import { bannerFor, bannerSeverityForTier, bannerSeverityForTierName, settingsBadgeFor } from "./subscriptionBanner";
import { tierToPill } from "./Pill";
import { railGateNoticeFor } from "../stablecoin/railAccess";

// R7's meaning, in S2's words (Ethan, 2026-11-05).
const R7_APP_CHECK =
  "Your membership isn't paid, so the hub can't accept your channel. Pay your membership, then connect.";
const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue({
    enabled: false, enabled_at: null, last_acknowledged_price: null, last_acknowledged_price_at: null,
    current_price: 50_000, price_change_pending: false, active_alerts: [],
    badge: { active_count: 0, highest_severity: null },
  });
  stub.getAutoPayHistory.mockResolvedValue({ alerts: [] });
  stub.getTreasuryInfo.mockResolvedValue({ pubkey: "02" + "11".repeat(32), socket: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  nowSpy.mockRestore();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

const routingLapsed = () => {
  const paidThrough = NOW - 35 * DAY;
  return {
    applicable: true,
    member_pubkey: "02" + "c".repeat(64),
    current_tier: "routing_lapsed",
    paid_through: paidThrough,
    price_sats: 50_000,
    period_days: 30,
    deposit_address: "bc1q" + "d".repeat(38),
    last_payment_at: paidThrough - 30 * DAY,
    last_payment_txid: "f".repeat(64),
    open_channel_allowed: false,
    grace: { fresh_until: 0, worker_until: paidThrough + 30 * DAY, routing_until: paidThrough + 30 * DAY, close_at: paidThrough + 60 * DAY },
  };
};

// ─── M2 item 3 / item C / DW5 ─────────────────────────────────────────────

describe("DW5 / item C — the panel's routing_lapsed render says hosted services are paused, not routing", () => {
  async function mountPanel() {
    stub.getSubscriptionStatus.mockResolvedValue(routingLapsed());
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
    });
    await settle();
    return host.textContent ?? "";
  }

  it("carries the ruled meaning, with the live price", async () => {
    const text = await mountPanel();
    expect(text).toContain(
      "Your membership payment is overdue, so hosted services are paused: valuation, Auto-Buy and stablecoin settlement data. Pay 50,000 sats to restore them.",
    );
    expect(text).toContain("payment overdue"); // the pill
  });

  it("makes no routing claim anywhere: pill, alert or timeline", async () => {
    const text = await mountPanel();
    expect(text).not.toMatch(/routing paused/i);
    expect(text).not.toMatch(/routing through the treasury is paused/i);
    expect(text).not.toMatch(/routing and all paused services/i);
    expect(text).not.toMatch(/routing/i);
    expect(text).not.toMatch(/refused|blocked/i);
  });
});

// ─── L2 — no close claim; close_due carries routing_lapsed's copy ─────────
//
// Tier 3 issues no close (app/api/src/subscription/tier3Scheduler.ts returns
// would_close and calls nothing), so neither tier may claim or imply one.

const CLOSE_CLAIM = /clos(e|ed|es|ing)|halt|scheduler|queued|cooperativ/i;

describe("L2 — neither lapsed tier claims a channel close, and close_due matches routing_lapsed", () => {
  async function panelText(status: unknown) {
    stub.getSubscriptionStatus.mockResolvedValue(status);
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
    });
    await settle();
    const text = host.textContent ?? "";
    lastHtml = host.innerHTML;
    await act(async () => { root.render(React.createElement("div")); });
    return text;
  }
  let lastHtml = "";
  const closeDue = () => ({ ...routingLapsed(), current_tier: "close_due", paid_through: NOW - 65 * DAY });
  const banner = (s: unknown) => {
    const d = bannerFor(s as any, NOW);
    if (!d.render) throw new Error("no banner");
    return d;
  };

  it("routing_lapsed: the panel and the banner make no close/halt/scheduler/queued claim", async () => {
    const text = await panelText(routingLapsed());
    expect(text).toContain("Your membership payment is overdue"); // it rendered the tier
    expect(text).not.toMatch(CLOSE_CLAIM);
    const d = banner(routingLapsed());
    expect(`${d.headline} ${d.body} ${d.actionLabel}`).not.toMatch(CLOSE_CLAIM);
  });

  it("close_due: the panel and the banner make no close/halt/scheduler/queued claim", async () => {
    const text = await panelText(closeDue());
    expect(text).toContain("Your membership payment is overdue");
    expect(text).not.toMatch(CLOSE_CLAIM);
    const d = banner(closeDue());
    expect(`${d.headline} ${d.body} ${d.actionLabel}`).not.toMatch(CLOSE_CLAIM);
  });

  it("close_due's panel equals routing_lapsed's: every word, and the markup (colors, icon)", async () => {
    // Same paid_through, so the PAID THROUGH stat is equal too; only the tier differs.
    const routing = await panelText(routingLapsed());
    const routingHtml = lastHtml;
    const close = await panelText({ ...routingLapsed(), current_tier: "close_due" });
    expect(close).toBe(routing);
    expect(lastHtml).toBe(routingHtml); // pill kind, alert variant and ⚠ icon included
    expect(routingHtml).toContain("sub-stat-accent-orange");
    expect(routingHtml).not.toMatch(/\bred\b|critical|✕/);
  });

  it("close_due's banner equals routing_lapsed's, severity included", () => {
    const r = banner(routingLapsed());
    const c = banner({ ...routingLapsed(), current_tier: "close_due" });
    expect(c).toEqual(r);
    expect(c.headline).toBe("Your membership payment is overdue");
    expect(c.actionLabel).toBe("Renew 50,000 sats");
    expect(c.severity).toBe("orange");
  });

  it("close_due's severity equals routing_lapsed's on every surface: banner, badge, 402 notice, rail notice, pill", () => {
    expect(bannerSeverityForTier("close_due")).toBe(bannerSeverityForTier("routing_lapsed"));
    expect(bannerSeverityForTierName("close_due")).toBe(bannerSeverityForTierName("routing_lapsed")); // 402 notice
    expect(settingsBadgeFor(closeDue() as any)).toEqual(settingsBadgeFor(routingLapsed() as any));
    const rail = (s: unknown) => {
      const n = railGateNoticeFor(s as any);
      if (!n.render) throw new Error("no rail notice");
      return { severity: n.severity, variantClass: n.variantClass, icon: n.icon };
    };
    expect(rail(closeDue())).toEqual(rail(routingLapsed()));
    expect(tierToPill("close_due")).toEqual(tierToPill("routing_lapsed"));
    expect(bannerSeverityForTier("close_due")).toBe("orange");
  });

  it("the not-renewing line says only what is true", async () => {
    const text = await panelText(closeDue());
    expect(text).toContain("If you don't renew — hosted services stay paused and your connection to Bitcorn stays open.");
  });
});

describe("L2 follow-up — no lapsed tier claims routing pauses", () => {
  // "routing paused", "routing pauses", "routing also pauses", "routing is paused".
  const ROUTING_PAUSE_CLAIM = /routing (is |also )?paus(e|ed|es)\b/i;
  const tiers = ["worker_lapsed", "routing_lapsed", "close_due"] as const;
  const statusFor = (tier: (typeof tiers)[number]) => ({ ...routingLapsed(), current_tier: tier });

  it.each(tiers)("%s: the panel says nothing about routing pausing", async (tier) => {
    stub.getSubscriptionStatus.mockResolvedValue(statusFor(tier));
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
    });
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain("If you don't renew"); // the timeline rendered
    expect(text).not.toMatch(ROUTING_PAUSE_CLAIM);
  });

  it.each(tiers)("%s: the pill and the banner say nothing about routing pausing", (tier) => {
    expect(tierToPill(tier).label).not.toMatch(ROUTING_PAUSE_CLAIM);
    const d = bannerFor(statusFor(tier) as any, NOW);
    if (!d.render) throw new Error("no banner");
    expect(`${d.headline} ${d.body} ${d.actionLabel}`).not.toMatch(ROUTING_PAUSE_CLAIM);
  });

  it("worker_lapsed's not-renewing line says only what is true", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(statusFor("worker_lapsed"));
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
    });
    await settle();
    expect(host.textContent ?? "").toContain("If you don't renew — hosted services stay paused and your connection to Bitcorn stays open.");
  });

  it("routing_lapsed's pill is the panel's 'payment overdue'", () => {
    expect(tierToPill("routing_lapsed")).toEqual({ kind: "orange", label: "payment overdue" });
  });
});

describe("L2 drive-mode review — no 'funds are safe', R14's 'connection', amounts dollars first", () => {
  const RATE = 60_000; // 50,000 sats → $30.00
  const overdue = ["routing_lapsed", "close_due"] as const;
  async function panel(tier: string) {
    stub.getSubscriptionStatus.mockResolvedValue({ ...routingLapsed(), current_tier: tier });
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
    });
    await settle();
    return host.textContent ?? "";
  }

  it.each(overdue)("%s panel: the balance sentence, not 'funds are safe'", async (tier) => {
    const text = await panel(tier);
    expect(text).toContain("Your connection to Bitcorn is still open and its balance is unchanged.");
    expect(text).not.toMatch(/funds are safe/i);
  });

  it.each(overdue)("%s panel: R14's 'connection to Bitcorn' in every line L2 wrote", async (tier) => {
    const text = await panel(tier);
    expect(text).toContain("If you don't renew — hosted services stay paused and your connection to Bitcorn stays open.");
    expect(text).toContain("Right now — your connection to Bitcorn remains open and its balance is unchanged.");
    expect(text).not.toMatch(/your channel (is still open|stays open|remains open)|channel balance/i);
  });

  it.each(overdue)("%s banner with a rate: dollars first, the sats beside them", (tier) => {
    const d = bannerFor({ ...routingLapsed(), current_tier: tier } as any, NOW, RATE);
    if (!d.render) throw new Error("no banner");
    expect(d.body).toBe(
      "Hosted services are paused: valuation, Auto-Buy and stablecoin settlement data. Pay $30.00 (50,000 sats) to restore them.",
    );
    expect(d.actionLabel).toBe("Renew 50,000 sats"); // P2: the action is unchanged by a rate
  });

  it.each(overdue)("%s banner with no rate: the sats alone", (tier) => {
    const d = bannerFor({ ...routingLapsed(), current_tier: tier } as any, NOW, null);
    if (!d.render) throw new Error("no banner");
    expect(d.body).toBe(
      "Hosted services are paused: valuation, Auto-Buy and stablecoin settlement data. Pay 50,000 sats to restore them.",
    );
    expect(d.body).not.toContain("$");
  });
});

describe("L2 — 'lapsed N days ago' and the PAID THROUGH stat's 'Nd ago' use one day computation", () => {
  it("agree on a fractional day, where ceil and floor of the elapsed time differ", async () => {
    // 88.5 days: ceil would say 89, floor 88 — the gate 1 screenshot's split.
    const paidThrough = NOW - 88.5 * DAY;
    stub.getSubscriptionStatus.mockResolvedValue({
      ...routingLapsed(),
      current_tier: "worker_lapsed",
      paid_through: paidThrough,
      last_payment_at: paidThrough - 30 * DAY,
    });
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
    });
    await settle();
    const text = host.textContent ?? "";
    const lapsed = text.match(/lapsed (\d+) days? ago/)?.[1];
    const suffixes = Array.from(host.querySelectorAll(".sub-stat-suffix"), (el) => el.textContent ?? "");
    const paid = suffixes.map((s) => s.match(/^(\d+)d ago$/)?.[1]).find(Boolean);
    expect(lapsed).toBeDefined();
    expect(paid).toBeDefined();
    expect(lapsed).toBe(paid);
    expect(paid).toBe("88");
  });
});

// ─── M2 item 4 / item D ───────────────────────────────────────────────────

describe("item D — the pre-pause banner is unchanged and, under T2, shows for 30 days", () => {
  const P = NOW;
  const current = (now: number) =>
    bannerFor(
      {
        ...routingLapsed(),
        current_tier: "current",
        paid_through: P,
        grace: { fresh_until: 0, worker_until: P + 30 * DAY, routing_until: P + 30 * DAY, close_at: P + 60 * DAY },
      } as any,
      now,
    );

  it("shows from paid_through through day 29, reading worker_until", () => {
    for (const day of [0, 7, 8, 29]) {
      const d = current(P + day * DAY);
      if (!d.render) throw new Error(`no banner on day ${day}`);
      expect(d.headline).toMatch(/^Hosted services pause on /);
      expect(d.severity).toBe("amber");
    }
  });

  it("is gone at worker_until", () => {
    expect(current(P + 30 * DAY).render).toBe(false);
  });
});

// ─── M2 item 1 / DW6 ──────────────────────────────────────────────────────

describe("DW6 / M2 item 1 — ConnectToHub shows R7's app-check message on a membership refusal", () => {
  const probe: { s: ReturnType<typeof useConnectToHub> | null } = { s: null };
  function Probe() {
    probe.s = useConnectToHub({ isPeered: true });
    return React.createElement("div", { className: "alert-msg" }, probe.s.error ?? "");
  }

  async function openWith(err: unknown) {
    stub.openMemberChannel.mockRejectedValue(err);
    await act(async () => { root.render(React.createElement(Probe)); });
    await settle();
    await act(async () => { await probe.s!.handleOpen(); });
    return host.textContent ?? "";
  }

  it("membership_not_paid → R7's words, exactly", async () => {
    const shown = await openWith(
      Object.assign(new Error("membership_not_paid"), { status: 403, code: "membership_not_paid" }),
    );
    expect(shown).toBe(R7_APP_CHECK);
  });

  it("any other failure keeps today's message", async () => {
    const shown = await openWith(
      Object.assign(new Error("failed_to_open_channel"), { status: 500, code: "failed_to_open_channel" }),
    );
    expect(shown).toBe("failed_to_open_channel");
  });
});
