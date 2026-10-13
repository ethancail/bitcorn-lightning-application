// D3 / V11 on the member pages — the dashboard gauge, Top Up and Cash Out take
// their capacity colour from the Liquidity Advisor's state, never red and never
// from the percentage. R2 / PR3-4: an unknown role or no classification is
// neutral. PR3-2: Top Up's projected % is --text. PR3-7: amber only on the bar.
//
// The fixtures put the state and the percentage at odds (a 50% channel the
// advisor calls receive_exhausted, a 10% one it calls healthy), so a colour
// recomputed from the percentage fails them.
//
// Harness: MemberDashboard.declaredRole.test.tsx's.

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
  getSwapHistory: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import MemberDashboard from "./MemberDashboard";
import RefillChannel from "./RefillChannel";
import WithdrawBitcoin from "./WithdrawBitcoin";
import type { MemberChannelRole, MemberChannelState } from "../api/client";

const never = () => new Promise<never>(() => {});

const stats = (localSats: number) => ({
  hub_pubkey: null,
  membership_status: "active",
  node_role: "member",
  is_peered_to_hub: true,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: {
    channel_id: "1",
    local_sats: localSats,
    remote_sats: 1_000_000 - localSats,
    capacity_sats: 1_000_000,
    is_active: true,
    freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
  },
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
});

const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };

const status = (role: MemberChannelRole, state: MemberChannelState | null) => ({
  channelRole: role,
  classification: state === null ? null : {
    channelId: "1", capacitySat: 1_000_000, memberLocalSat: 0, treasuryLocalSat: 0, memberLocalPct: 0,
    state, urgency: "medium", consecutiveNonHealthyRuns: 1, classifiedAt: NOW, channelRole: role,
  },
  recommendation: null,
  loopAvailability: LOOP,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function render(page: React.ComponentType) {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(page)));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const style = (el: Element) => el.getAttribute("style") ?? "";
const bar = () => {
  const el = host.querySelector('[data-testid="capacity-bar"]');
  expect(el, "the capacity bar renders").not.toBeNull();
  return style(el!);
};
const texts = () => Array.from(host.querySelectorAll('[data-testid="capacity-text"]'));

function setup(localSats: number, role: MemberChannelRole, state: MemberChannelState | null) {
  stub.getMemberStats.mockResolvedValue(stats(localSats));
  stub.getMemberLiquidityStatus.mockResolvedValue(status(role, state));
}

describe("V11 — the member dashboard's gauge", () => {
  it("a merchant at 50% the advisor calls receive_exhausted → amber bar, hero in --text, \"Low\"", async () => {
    setup(500_000, "merchant", "receive_exhausted");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--amber)");
    expect(texts().map(style).join("|")).not.toMatch(/amber|red/);
    expect(host.textContent).toContain("Room to send · Low");
  });

  it("PERMITTING: a merchant at 10% the advisor calls healthy → green bar, no word", async () => {
    setup(100_000, "merchant", "healthy");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--green)");
    expect(host.textContent).not.toContain("· Low");
  });

  it("a farmer the advisor calls send_saturated → amber bar, \"Getting full\", never red", async () => {
    setup(900_000, "farmer", "send_saturated");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--amber)");
    expect(host.textContent).toContain("Earnings accumulated · Getting full");
    expect(host.innerHTML).not.toContain("var(--red)");
  });

  it("R2: an unknown role at 5% → a neutral bar", async () => {
    setup(50_000, "unknown", "receive_exhausted");
    await render(MemberDashboard);
    expect(bar()).toContain("var(--text-3)");
  });

  it("PR3-4: a declared merchant with no classification → a neutral bar", async () => {
    setup(50_000, "merchant", null);
    await render(MemberDashboard);
    expect(bar()).toContain("var(--text-3)");
  });
});

describe("V11 — Top Up", () => {
  it("a merchant at 50% the advisor calls receive_heavy → amber bar, \"Low\", text in --text", async () => {
    setup(500_000, "merchant", "receive_heavy");
    await render(RefillChannel);
    expect(bar()).toContain("var(--amber)");
    expect(host.textContent).toContain("Low · 50% local");
    expect(texts().length).toBeGreaterThanOrEqual(3);
    expect(texts().map(style).join("|")).not.toMatch(/amber|red/);
  });

  it("PERMITTING: a merchant at 10% the advisor calls healthy → green bar", async () => {
    setup(100_000, "merchant", "healthy");
    await render(RefillChannel);
    expect(bar()).toContain("var(--green)");
  });

  it("PR3-2: the projected \"after top up\" % is --text", async () => {
    setup(100_000, "merchant", "healthy");
    await render(RefillChannel);
    const projected = texts().find((el) => el.textContent?.trim() === "35%");
    expect(projected, "the projected 35% renders").toBeDefined();
    expect(style(projected!)).toContain("color: var(--text)");
  });
});

describe("V11 — Cash Out", () => {
  it("a farmer at 50% the advisor calls send_heavy → amber bar, \"Getting full\", text in --text", async () => {
    setup(500_000, "farmer", "send_heavy");
    await render(WithdrawBitcoin);
    expect(bar()).toContain("var(--amber)");
    expect(host.textContent).toContain("Getting full · 50% local");
    expect(texts().map(style).join("|")).not.toMatch(/amber|red/);
  });

  it("PERMITTING: a farmer at 5% the advisor calls healthy → green bar, never red", async () => {
    setup(50_000, "farmer", "healthy");
    await render(WithdrawBitcoin);
    expect(bar()).toContain("var(--green)");
    expect(host.innerHTML).not.toContain("var(--red)");
  });
});
