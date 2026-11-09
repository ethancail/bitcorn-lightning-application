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
import { bannerFor } from "./subscriptionBanner";

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
