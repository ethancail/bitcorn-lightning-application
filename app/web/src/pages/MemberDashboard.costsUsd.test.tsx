// Drive-mode P3 (R40(5); gate 2: "the itemised costs are sats only, while the
// totals are dollars first"): the 30-day aggregate is converted at TODAY's
// price — it spans many records with no single stored rate — and says so,
// "at today's price"; its itemised rows are dollars first too.
//
// Harness: MemberDashboard.alerts.test.tsx's.


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


// Payment 42 + Withdraw 4,000 = 4,042 sats; at today's $60,000: $0.03, $2.40, $2.43.
const COSTS = { window_days: 30, payment_fees_sat: 42, withdraw_fees_sat: 4_000, topup_fees_sat: 0, total_sat: 4_042 };

function costsPanel() {
  return [...host.querySelectorAll(".panel")].find((p) => p.querySelector(".panel-title")?.textContent?.includes("Costs, last 30 days")) ?? null;
}

describe("P3 — Costs, last 30 days: dollars at today's price, said so", () => {
  it("the total is labelled 'at today's price'", async () => {
    stub.getMemberCosts.mockResolvedValue(COSTS);
    await renderDashboard();
    const p = costsPanel()!;
    expect(p.querySelector("[data-testid='costs-total']")!.textContent).toBe("$2.43");
    expect(p.querySelector("[data-testid='costs-price-note']")?.textContent).toBe("at today's price");
  });

  it("the itemised costs are dollars first too, with sats beneath", async () => {
    stub.getMemberCosts.mockResolvedValue(COSTS);
    await renderDashboard();
    const rows = [...costsPanel()!.querySelectorAll("[data-testid='cost-part']")].map((r) => (r.textContent ?? "").replace(/\s+/g, " "));
    expect(rows).toEqual(["Payment fees$0.0342 sats", "Withdraw fees$2.404,000 sats"]);
  });

  it("no price: sats, and no 'at today's price'", async () => {
    stub.getExchangeRate.mockResolvedValue({ usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" });
    stub.getMemberCosts.mockResolvedValue(COSTS);
    await renderDashboard();
    const p = costsPanel()!;
    expect(p.querySelector("[data-testid='costs-total']")!.textContent).toBe("4,042 sats");
    expect(p.querySelector("[data-testid='costs-price-note']")).toBeNull();
  });
});
