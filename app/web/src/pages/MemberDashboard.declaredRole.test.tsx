// SH9, on the member dashboard: the role-dependent channel panel uses the
// DECLARED role when the advisor's classification is null (the treasury
// channel is inactive). Before, the panel read the role only from inside
// classification, so a declared merchant with an inactive channel got the
// unknown-role panel ("Your Channel" and a "Set your channel role" prompt)
// instead of the merchant one ("Merchant Channel", "Available to send").
//
// Harness: MemberDashboard.namePrompt.test.tsx's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const NOW = Date.now();

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getBitcornName: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});

/** The member's stats with the treasury channel present but INACTIVE. */
const INACTIVE_CHANNEL = {
  hub_pubkey: null,
  membership_status: "active",
  node_role: "member",
  is_peered_to_hub: true,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: {
    channel_id: "1",
    local_sats: 500_000,
    remote_sats: 500_000,
    capacity_sats: 1_000_000,
    is_active: false,
    freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
  },
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
};

const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };

/** What /api/liquidity/status returns while that channel is inactive. */
const inactiveWithRole = (channelRole: "merchant" | "farmer" | "unknown") => ({
  channelRole,
  classification: null,
  recommendation: null,
  loopAvailability: LOOP,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue(INACTIVE_CHANNEL);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 0, lightning_sats: 0, total_sats: 0 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function renderDashboard() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberDashboard)));
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  return host.textContent ?? "";
}

describe("SH9 — the dashboard's role panel with an inactive channel", () => {
  it("PERMITTING: inactive channel, role merchant → the merchant panel", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(inactiveWithRole("merchant"));
    const text = await renderDashboard();
    expect(text).toContain("Merchant Channel");
    expect(text).toContain("Available to send");
    expect(text).not.toContain("Set your channel role");
  });

  it("inactive channel, role farmer → the farmer panel", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(inactiveWithRole("farmer"));
    const text = await renderDashboard();
    expect(text).toContain("Your Earnings");
    expect(text).toContain("Available to withdraw");
  });

  it("nothing declared → the unknown-role panel and its prompt, unchanged", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(inactiveWithRole("unknown"));
    const text = await renderDashboard();
    expect(text).toContain("Your Channel");
    expect(text).toContain("Set your channel role");
  });
});
