// drive-mode P2, the dashboard's alerts that involve no automatic transfer —
// one sentence and one action each, carrying the whole fix (C6):
//   item 5 — your connection to Bitcorn is down (R18(2)): treasury_channel's
//            is_active false. "Check again" re-reads the stats (R27(12)).
//   item 8 — no price: the rate's state "none". The sentence leaves the page
//            header for an alert below the chart; "Check again" re-reads the
//            rate (R27(12)).
// Both render in the alerts slot directly below the price chart, so nothing
// above the chart changes when they fire (D2.2).
//
// Harness: MemberDashboard.figures.test.tsx's; the chart is a marker.

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
  getMemberCosts: vi.fn(), // drive-mode P2 item 14: a new dashboard read
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

const CHANNEL = {
  channel_id: "1",
  local_sats: 640_000,
  remote_sats: 360_000,
  capacity_sats: 1_000_000,
  is_active: true,
  room_to_send_sats: 630_000,
  room_to_receive_sats: 350_000,
  local_reserve_sats: 10_000,
  remote_reserve_sats: 10_000,
  pending_outgoing_sats: 0,
  pending_incoming_sats: 0,
  commit_fee_sats: null,
  freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
};

const stats = (channel: Partial<typeof CHANNEL> = {}) => ({
  hub_pubkey: null,
  membership_status: "active_member",
  node_role: "member",
  is_peered_to_hub: true,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: { ...CHANNEL, ...channel },
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
  lifetime_received_sats: 2_468_000,
});

const LOOP_UP = {
  loopDaemonRunning: true,
  loopOutAvailable: true,
  loopInAvailable: true,
  loopOutTerms: { minSats: 250_000, maxSats: 5_000_000 },
  loopInTerms: { minSats: 250_000, maxSats: 5_000_000 },
};

const advisor = (channelRole: "merchant" | "farmer" | "unknown", extra: Record<string, unknown> = {}) => ({
  channelRole,
  classification: channelRole === "unknown"
    ? null
    : { channelRole, state: "healthy", urgency: "none", memberLocalPct: 64 },
  recommendation: null,
  loopAvailability: LOOP_UP,
  ...extra,
});

const FRESH = { usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" };
const NONE_NEVER = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };
const NONE_OLD = { usd: null, source: "coinbase", fetched_at: NOW - 7 * 3_600_000, age_ms: 7 * 3_600_000, state: "none" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getMemberStats.mockResolvedValue(stats());
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue(FRESH);
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 100_000, lightning_sats: 640_000, total_sats: 740_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapLimits.mockImplementation(never);
  stub.getMemberCosts.mockImplementation(never);
  stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

async function renderDashboard() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberDashboard)));
  });
  await flush();
}

/** The alerts slot directly below the chart: the .dash child after it. */
function belowChart(): Element | null {
  const kids = [...host.querySelector(".dash")!.children];
  const i = kids.findIndex((k) => k.getAttribute("data-testid") === "price-chart");
  return kids[i + 1]?.classList.contains("dash-notices-alerts") ? kids[i + 1] : null;
}

/** An alert by a phrase in its sentence, anywhere on the page. */
const alertWith = (phrase: string) =>
  [...host.querySelectorAll(".alert")].find((a) => a.textContent?.includes(phrase)) ?? null;

const actionOf = (alert: Element) => alert.querySelector("button") as HTMLButtonElement | null;

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

const CONNECTION_DOWN =
  "Your connection to Bitcorn is down, so payments can't go through it right now. " +
  "It usually reconnects within a few minutes; if it's still down in an hour, restart the Lightning app.";
const NO_PRICE = "The bitcoin price isn't available right now, so amounts are shown in sats.";

describe("item 5: your connection to Bitcorn is down", () => {
  it("is_active false: one sentence and \"Check again\", below the chart", async () => {
    stub.getMemberStats.mockResolvedValue(stats({ is_active: false }));
    await renderDashboard();
    const alert = alertWith("Your connection to Bitcorn is down")!;
    expect(alert).not.toBeNull();
    expect(alert.querySelector(".alert-msg")!.textContent).toBe(CONNECTION_DOWN);
    expect(actionOf(alert)!.textContent).toBe("Check again");
    expect(belowChart()!.contains(alert)).toBe(true);
  });

  it("\"Check again\" re-reads the stats, and the alert clears when the connection is back", async () => {
    stub.getMemberStats.mockResolvedValue(stats({ is_active: false }));
    await renderDashboard();
    const before = stub.getMemberStats.mock.calls.length;
    stub.getMemberStats.mockResolvedValue(stats({ is_active: true }));
    await click(actionOf(alertWith("Your connection to Bitcorn is down")!)!);
    expect(stub.getMemberStats.mock.calls.length).toBe(before + 1);
    expect(alertWith("Your connection to Bitcorn is down")).toBeNull();
  });

  it("is_active true: no alert", async () => {
    await renderDashboard();
    expect(alertWith("Your connection to Bitcorn is down")).toBeNull();
  });

  it("no channel: no alert (there is no connection to be down)", async () => {
    stub.getMemberStats.mockResolvedValue({ ...stats(), treasury_channel: null });
    await renderDashboard();
    expect(alertWith("Your connection to Bitcorn is down")).toBeNull();
  });
});

describe("item 8: no price", () => {
  for (const [name, rate] of [["never fetched", NONE_NEVER], ["older than 6 hours", NONE_OLD]] as const) {
    it(`state "none", ${name}: one sentence and "Check again", below the chart, not in the header`, async () => {
      stub.getExchangeRate.mockResolvedValue(rate);
      await renderDashboard();
      const alert = alertWith("bitcoin price")!;
      expect(alert).not.toBeNull();
      expect(alert.querySelector(".alert-msg")!.textContent).toBe(NO_PRICE);
      expect(actionOf(alert)!.textContent).toBe("Check again");
      expect(belowChart()!.contains(alert)).toBe(true);
      expect(host.querySelector(".dash-header")!.textContent).not.toContain("bitcoin price");
    });
  }

  it("\"Check again\" re-reads the rate, and the alert clears when a rate arrives", async () => {
    stub.getExchangeRate.mockResolvedValue(NONE_NEVER);
    await renderDashboard();
    const before = stub.getExchangeRate.mock.calls.length;
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await click(actionOf(alertWith("bitcoin price")!)!);
    expect(stub.getExchangeRate.mock.calls.length).toBe(before + 1);
    expect(alertWith("bitcoin price")).toBeNull();
  });

  it("a fresh rate: no alert", async () => {
    await renderDashboard();
    expect(alertWith("bitcoin price")).toBeNull();
  });

  it("a stale rate keeps its dated line in the header, with no alert", async () => {
    stub.getExchangeRate.mockResolvedValue({ ...FRESH, state: "stale", age_ms: 601_000 });
    await renderDashboard();
    expect(host.querySelector(".dash-header")!.textContent).toContain("Price as of");
    expect(alertWith("bitcoin price")).toBeNull();
  });
});

// The API's sentences (app/api/src/memberAdvisor/loopAlert.ts), as it sends them.
const LOOP_OUT_ALERT = { text: "Loop is still setting up on this node, so Withdraw isn't available yet. If this lasts more than 10 minutes, restart Bitcorn.", action: { label: "Check again" } };
const LOOP_IN_ALERT = { text: "Top Up is currently unavailable.", action: { label: "Try again" } };

describe("item 6, D2.3: Loop unavailable, the API's alert for the member's direction", () => {
  it("farmer: the loop_out (Withdraw) alert, below the chart, even in the healthy band", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", { loopAlert: { loop_out: LOOP_OUT_ALERT, loop_in: LOOP_IN_ALERT } }));
    await renderDashboard();
    const alert = alertWith("Loop is still setting up")!;
    expect(alert).not.toBeNull();
    expect(alert.querySelector(".alert-msg")!.textContent).toBe(LOOP_OUT_ALERT.text);
    expect(actionOf(alert)!.textContent).toBe("Check again");
    expect(belowChart()!.contains(alert)).toBe(true);
    expect(alertWith("Top Up is currently unavailable")).toBeNull();
  });

  it("merchant: the loop_in (Top Up) alert", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant", { loopAlert: { loop_out: LOOP_OUT_ALERT, loop_in: LOOP_IN_ALERT } }));
    await renderDashboard();
    const alert = alertWith("Top Up is currently unavailable")!;
    expect(alert).not.toBeNull();
    expect(actionOf(alert)!.textContent).toBe("Try again");
    expect(alertWith("Loop is still setting up")).toBeNull();
  });

  it("unknown role: neither (it has neither Withdraw nor Top Up)", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("unknown", { loopAlert: { loop_out: LOOP_OUT_ALERT, loop_in: LOOP_IN_ALERT } }));
    await renderDashboard();
    expect(alertWith("Loop is still setting up")).toBeNull();
    expect(alertWith("Top Up is currently unavailable")).toBeNull();
  });

  it("the action re-reads the status, and the alert clears when Loop is back", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", { loopAlert: { loop_out: LOOP_OUT_ALERT, loop_in: null } }));
    await renderDashboard();
    const before = stub.getMemberLiquidityStatus.mock.calls.length;
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", { loopAlert: { loop_out: null, loop_in: null } }));
    await click(actionOf(alertWith("Loop is still setting up")!)!);
    expect(stub.getMemberLiquidityStatus.mock.calls.length).toBe(before + 1);
    expect(alertWith("Loop is still setting up")).toBeNull();
  });

  it("available: no Loop alert", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", { loopAlert: { loop_out: null, loop_in: null } }));
    await renderDashboard();
    expect(alertWith("Loop")).toBeNull();
  });
});

// Finding 5 (R33): one statement per fault. While a direction's Loop alert
// shows, the advisor's message and that direction's button caption are not
// shown — they would say the same fault again.
describe("R33 finding 5: one statement per fault", () => {
  const OUT = { text: "Loop isn't responding right now, so Withdraw isn't available.", action: { label: "Check again" } };
  const IN = { text: "Loop isn't responding right now, so Top Up isn't available.", action: { label: "Check again" } };
  const DOWN = { ...LOOP_UP, loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };
  const recommendation = (action: string, reason: string) => ({
    action, suggestedAmountSats: action === "loop_in" ? 500_000 : null, projectedMemberLocalPct: null,
    reason, urgency: "high", loopAvailable: false, generatedAt: NOW,
  });
  const FARMER_REASON = "Earnings are 90% full. Withdraw earnings from the Withdraw page, or send a payment to make room. Loop isn't responding right now.";
  const statements = () => (host.textContent ?? "").split(/Loop isn't responding|currently unavailable/).length - 1;

  it("farmer: the Loop alert only — no advisor message, no Withdraw caption", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", {
      loopAvailability: DOWN, recommendation: recommendation("manual_recovery", FARMER_REASON), loopAlert: { loop_out: OUT, loop_in: IN },
    }));
    await renderDashboard();
    expect(alertWith("Loop isn't responding right now, so Withdraw")).not.toBeNull();
    expect(host.textContent).not.toContain("Earnings are 90% full");
    expect(host.textContent).not.toContain("Withdrawals are currently unavailable.");
    expect(statements()).toBe(1);
    // The button is still refused (the gate is unchanged); only its caption goes.
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Withdraw Earnings →") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("merchant: the Loop alert only — no advisor message, no Top Up caption", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant", {
      loopAvailability: DOWN, recommendation: recommendation("loop_in", "Your channel is nearly out of room to send."), loopAlert: { loop_out: OUT, loop_in: IN },
    }));
    await renderDashboard();
    expect(alertWith("Loop isn't responding right now, so Top Up")).not.toBeNull();
    expect(host.textContent).not.toContain("nearly out of room to send");
    expect(host.textContent).not.toContain("Bitcorn recommends");
    expect(statements()).toBe(1);
  });

  it("PERMITTING: no Loop alert — the advisor's message and the caption show as before", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("farmer", {
      loopAvailability: DOWN, recommendation: recommendation("manual_recovery", FARMER_REASON), loopAlert: { loop_out: null, loop_in: null },
    }));
    await renderDashboard();
    expect(host.textContent).toContain("Earnings are 90% full");
    expect(host.textContent).toContain("Withdrawals are currently unavailable.");
  });
});

// Items 11-12 on the dashboard: the subscription banner gets the dashboard's
// rate, so the renewal copy is dollars first (no new fetch).
describe("items 11-12: the dashboard's renewal banner reads its rate", () => {
  const sub = (current_tier: string, paid_through: number) => ({
    applicable: true, member_pubkey: "03" + "a".repeat(64), current_tier, paid_through,
    price_sats: 50_000, period_days: 30, deposit_address: "bcrt1qexample", last_payment_at: null, last_payment_txid: null,
    grace: { fresh_until: 0, worker_until: paid_through + 9 * 86_400_000, routing_until: paid_through + 30 * 86_400_000, close_at: paid_through + 60 * 86_400_000 },
  });

  it("at P: the pre-pause warning, in dollars", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(sub("current", NOW));
    await renderDashboard();
    expect(host.textContent).toContain("Renew for $30.00 (50,000 sats) before then to keep them running.");
    expect(host.textContent).toContain("Renew $30.00");
  });

  it("services paused: the dollar amount", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(sub("worker_lapsed", NOW - 10 * 86_400_000));
    await renderDashboard();
    expect(host.textContent).toContain("Renew for $30.00 (50,000 sats) to restore.");
  });
});

describe("the alerts slot is empty, and hidden, on a healthy dashboard", () => {
  it("renders no alert", async () => {
    await renderDashboard();
    const slot = host.querySelector(".dash-notices-alerts");
    expect(slot === null || slot.childElementCount === 0).toBe(true);
  });
});
