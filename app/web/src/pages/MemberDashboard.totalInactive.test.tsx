// Drive-mode P3 (BACKLOG §2 "Your Node's Total leaves out an inactive
// channel", owned by drive-mode): a member's Total counts the local balance
// of inactive channels (/api/node/balances lightning_inactive_sats), on Your
// Node and in the merchant headline (R40(6)). The API's total_sats stays
// active-only for the treasury dashboard, so the member page adds it.
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


// 100,000 on-chain + 640,000 active + 200,000 in an inactive channel.
const BALANCES = { onchain_sats: 100_000, lightning_sats: 640_000, lightning_inactive_sats: 200_000, total_sats: 740_000 };

const kvValue = (label: string) => {
  const row = [...host.querySelectorAll(".kv")].find((k) => k.querySelector(".kv-label")?.textContent === label);
  return row?.querySelector(".kv-meta")?.textContent ?? row?.querySelector(".kv-value")?.textContent ?? null;
};

const hlNums = () => [...host.querySelectorAll(".hl-num")].map((n) => n.textContent);

describe("P3 — Total counts the inactive channel's balance", () => {
  it("farmer: Your Node's Total is on-chain + active + inactive", async () => {
    stub.getNodeBalances.mockResolvedValue(BALANCES);
    await renderDashboard();
    expect(kvValue("Total")).toBe("940,000 sats");
  });

  it("merchant: the headline Total is on-chain + active + inactive (R40(6))", async () => {
    stub.getNodeBalances.mockResolvedValue(BALANCES);
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor("merchant"));
    await renderDashboard();
    expect(hlNums()).toContain("940,000");
    expect(hlNums()).not.toContain("740,000");
  });

  it("with no inactive balance the Total is unchanged", async () => {
    stub.getNodeBalances.mockResolvedValue({ ...BALANCES, lightning_inactive_sats: 0 });
    await renderDashboard();
    expect(kvValue("Total")).toBe("740,000 sats");
  });
});
