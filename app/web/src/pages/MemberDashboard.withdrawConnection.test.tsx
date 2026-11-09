// Drive-mode P3, item 5 (BACKLOG §2, owned by drive-mode under R34): Withdraw
// is disabled while the connection to Bitcorn is down. The server already
// refuses every Loop Out then (no active hub channel); the dashboard's CTA now
// says so by being disabled, rendered not hidden (decision C), and fails OPEN
// while the connection is unknown, as the daemon flag does.
//
// Harness: MemberDashboard.alerts.test.tsx's.

import { withdrawCtaGate } from "../components/withdrawCtaGate";

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

/** An alert by a phrase in its sentence, anywhere on the page. */
const alertWith = (phrase: string) =>
  [...host.querySelectorAll(".alert")].find((a) => a.textContent?.includes(phrase)) ?? null;

const withdrawButton = () =>
  [...host.querySelectorAll("button")].find((b) => /Withdraw Earnings/.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

describe("P3 — the gate itself", () => {
  it("an explicit false connection refuses, with the connection sentence", () => {
    expect(withdrawCtaGate(null, false)).toEqual({
      enabled: false,
      explanation: "Withdrawals wait until your connection to Bitcorn is back.",
    });
  });

  it("unknown connection (null / undefined) stays live — fail open, as the daemon flag does", () => {
    expect(withdrawCtaGate(null, null).enabled).toBe(true);
    expect(withdrawCtaGate(null, undefined).enabled).toBe(true);
    expect(withdrawCtaGate(null, true).enabled).toBe(true);
  });

  it("the connection sentence holds to the ban list", () => {
    expect(withdrawCtaGate(null, false).explanation).not.toMatch(/install|configur|expired|grpc/i);
  });
});

describe("P3 — the dashboard's Withdraw CTA while the connection is down", () => {
  it("connection down: the button renders and is disabled", async () => {
    stub.getMemberStats.mockResolvedValue(stats({ is_active: false }));
    await renderDashboard();
    const b = withdrawButton();
    expect(b, "rendered, not hidden (decision C)").toBeDefined();
    expect(b!.disabled).toBe(true);
  });

  it("one statement per fault: the connection-down alert says it, so no caption repeats it", async () => {
    stub.getMemberStats.mockResolvedValue(stats({ is_active: false }));
    await renderDashboard();
    expect(alertWith("Your connection to Bitcorn is down")).not.toBeNull();
    expect(host.textContent).not.toContain("Withdrawals wait until your connection to Bitcorn is back.");
  });

  it("connection up: the button is live", async () => {
    await renderDashboard();
    expect(withdrawButton()!.disabled).toBe(false);
  });
});
