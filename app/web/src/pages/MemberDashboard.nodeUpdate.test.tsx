// node-version-alert (R4): the member's "app out of date" line on the dashboard.
//
// Placement, confirmed by member-first-run-ui (Ethan, 2026-11-20): the top
// notice slot, AFTER the cert-expiry notice, with no channel gate — a member
// with no connection yet still runs an LND that can be out of date. One line,
// no heading (Q2). Markup: the existing alert classes only, no inline style.
//
// The API writes the sentence; this side only shows it or not. null (version
// current or unknown) and a dashboard still loading both render nothing.
//
// Harness: MemberDashboard.topRegion.test.tsx's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const NOTICE =
  "Your Lightning Node app is out of date, and part of it has stopped working. " +
  "Update it in your Umbrel's App Store, and update Bitcoin Node and Electrs too if you have them.";

// No connection: the case a channel gate would hide.
const STATS = {
  hub_pubkey: null,
  membership_status: "no_treasury_channel",
  node_role: "external",
  is_peered_to_hub: false,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  node_update_notice: null as string | null,
  treasury_channel: null,
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
  lifetime_received_sats: 0,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 100_000, lightning_sats: 0, total_sats: 100_000 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getSwapLimits.mockImplementation(never);
  stub.getMemberCosts.mockImplementation(never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
});

async function renderDashboard() {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberDashboard)));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const topMessages = () =>
  [...host.querySelectorAll(".dash-notices-top .alert .alert-msg")].map((e) => e.textContent);

describe("the node-update line on the member dashboard", () => {
  it("shows in the top slot on a node with NO connection (no channel gate)", async () => {
    stub.getMemberStats.mockResolvedValue({ ...STATS, node_update_notice: NOTICE });
    await renderDashboard();
    expect(topMessages()).toEqual([NOTICE]);
  });

  it("shows nothing when the API sends null — a current or unknown version", async () => {
    stub.getMemberStats.mockResolvedValue({ ...STATS, node_update_notice: null });
    await renderDashboard();
    expect(topMessages()).toEqual([]);
    expect(host.textContent).not.toContain("out of date");
  });

  it("shows nothing while the stats are still loading", async () => {
    stub.getMemberStats.mockImplementation(never);
    await renderDashboard();
    expect(host.textContent).not.toContain("out of date");
  });

  it("sits AFTER the cert-expiry notice in the top slot", async () => {
    stub.getMemberStats.mockResolvedValue({
      ...STATS,
      cert_expiry: { level: "expired", message: "Cert line.", not_after_ms: NOW - 1 },
      node_update_notice: NOTICE,
    });
    await renderDashboard();
    expect(topMessages()).toEqual(["Cert line.", NOTICE]);
  });

  it("is one line with no heading, in the existing alert classes, with no inline style", async () => {
    stub.getMemberStats.mockResolvedValue({ ...STATS, node_update_notice: NOTICE });
    await renderDashboard();
    const msg = [...host.querySelectorAll(".dash-notices-top .alert-msg")].find((e) => e.textContent === NOTICE)!;
    const alert = msg.closest(".alert")!;
    expect(alert.className).toBe("alert warning");
    const ALLOWED = new Set(["alert", "warning", "alert-icon", "alert-body", "alert-msg"]);
    for (const el of [alert, ...alert.querySelectorAll("*")]) {
      expect(el.hasAttribute("style"), el.outerHTML).toBe(false);
      for (const c of el.classList) expect(ALLOWED.has(c), `class ${c}`).toBe(true);
    }
    // One line: the message is the alert's only text besides its icon.
    expect(alert.querySelectorAll(".alert-msg").length).toBe(1);
    expect(alert.querySelector(".alert-type, h1, h2, h3, h4, strong")).toBeNull();
  });
});
