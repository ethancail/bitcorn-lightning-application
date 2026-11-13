// drive-mode R45 Polar follow-up (Ethan, "recs", 2026-11-12, item 1): the
// dashboard's subscription status polls every 15 s WHILE the banner's
// "Payment sent, waiting for confirmation" strip shows, and every 60 s
// otherwise.
//
// Why: at the R45 Polar check the treasury credited the payment 13.6 s after
// its block, the Settings panel (15 s poll) cleared at 23.7 s, but the
// dashboard (60 s poll) kept saying "waiting for confirmation" until 69.4 s.
//
// ⚠ PRE-CHANGE RUN: red at a3bb426.
//
// Harness: MemberDashboard.topRegion.test.tsx's, with fake interval timers
// (Date stays the spy, so the copy's "ago" cannot drift).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getBitcornName: vi.fn(),
  getSwapLimits: vi.fn(),
  getMemberCosts: vi.fn(),
  getPayFromNodePending: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({
  default: () => React.createElement("div", { "data-testid": "price-chart" }),
}));

import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});
const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const TXID = "ab".repeat(32);
const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };

const status = (tier: "routing_lapsed" | "current", o: Record<string, unknown> = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: tier,
  paid_through: NOW - 35 * DAY,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bc1qpinnedsubscriptionaddr000000000000zz",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: NOW - 5 * DAY, routing_until: NOW - 5 * DAY, close_at: NOW + 25 * DAY },
  ...VERIFIED,
  ...o,
});
const LAPSED = status("routing_lapsed");
/** The verified status after the treasury credits TXID: current, paid up. */
const CREDITED = status("current", {
  paid_through: NOW + 30 * DAY,
  last_payment_at: NOW,
  last_payment_txid: TXID,
  grace: { fresh_until: 0, worker_until: NOW + 60 * DAY, routing_until: NOW + 60 * DAY, close_at: NOW + 90 * DAY },
});
const MARKER = {
  amount_sats: 50_000, txid: TXID, sent_at: Math.floor(NOW / 1000) - 60, origin: "manual",
  paid_through_at_write: LAPSED.paid_through, count: 1,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getMemberStats.mockImplementation(never);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" });
  stub.getNodeBalances.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapLimits.mockImplementation(never);
  stub.getMemberCosts.mockImplementation(never);
  stub.getPayFromNodePending.mockResolvedValue({ pending: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}
async function renderDashboard() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberDashboard)));
  });
  await flush();
}
async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flush();
}
const statusCalls = () => stub.getSubscriptionStatus.mock.calls.length;
const strip = () => host.querySelector(".member-sub-banner[data-pending-payment]");
const tierBanner = () => host.querySelector(".member-sub-banner:not([data-pending-payment])");

describe("R45 follow-up: the dashboard's status cadence follows the waiting strip", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it("no waiting strip: status every 60 s, none at 15, 30 or 45 s", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(LAPSED);
    await renderDashboard();
    expect(tierBanner(), "the overdue banner shows").not.toBeNull();
    expect(strip()).toBeNull();
    const c = statusCalls();
    for (const _ of [15, 30, 45]) {
      await advance(15_000);
      expect(statusCalls()).toBe(c);
    }
    await advance(15_000);
    expect(statusCalls()).toBe(c + 1);
  });

  it("while the waiting strip shows: status every 15 s", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(LAPSED);
    stub.getPayFromNodePending.mockResolvedValue({ pending: MARKER });
    await renderDashboard();
    expect(strip(), "the waiting strip shows").not.toBeNull();
    const c = statusCalls();
    await advance(15_000);
    expect(statusCalls(), "no status read 15 s into the wait").toBe(c + 1);
    await advance(15_000);
    expect(statusCalls()).toBe(c + 2);
    expect(strip()).not.toBeNull();
  });

  it("the credit lands within one 15 s poll, the strip goes, and the cadence returns to 60 s", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(LAPSED);
    stub.getPayFromNodePending.mockResolvedValue({ pending: MARKER });
    await renderDashboard();
    expect(strip()).not.toBeNull();

    // The treasury credits the payment; the marker is still active (the
    // member's 60 s scheduler has not cleared it yet).
    stub.getSubscriptionStatus.mockResolvedValue(CREDITED);
    await advance(15_000);
    expect(strip(), "still waiting 15 s after the credit").toBeNull();
    expect(tierBanner(), "current and paid up: no banner").toBeNull();

    const c = statusCalls();
    for (const _ of [15, 30, 45]) {
      await advance(15_000);
      expect(statusCalls()).toBe(c);
    }
    await advance(15_000);
    expect(statusCalls()).toBe(c + 1);
  });

  it("a healthy member (current, no banner): 60 s, and no pending read", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(CREDITED);
    await renderDashboard();
    expect(host.querySelector(".member-sub-banner")).toBeNull();
    const c = statusCalls();
    await advance(45_000);
    expect(statusCalls()).toBe(c);
    await advance(15_000);
    expect(statusCalls()).toBe(c + 1);
    expect(stub.getPayFromNodePending).not.toHaveBeenCalled();
  });
});
