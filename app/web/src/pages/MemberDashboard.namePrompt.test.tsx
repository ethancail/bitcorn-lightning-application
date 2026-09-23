// MemberDashboard render controls for the member-name prompt — spec
// 2026-09-23-member-name-prompt §7.2, §7.3, §9.1–§9.4.
//
// ─── WHY A RENDER TEST, NOT ONLY THE DESCRIPTOR TEST ────────────────────────
// memberNamePrompt.test.ts proves WHAT the prompt says for each read. It
// cannot see WHERE the page mounts it. The hazard this arc exists to avoid is
// the prompt landing inside `{hasChannel && …}` beside the role nudge — every
// member it exists for is channel-less, so that placement renders it for
// nobody who needs it. Only rendering the page can catch that.
//
// ─── THE SHAPE OF EVERY FORBIDDING TEST ─────────────────────────────────────
// "No prompt" passes vacuously against a page that cannot render one (which
// is exactly what pre-change code is). So every absence assertion here is
// paired with a positive built from the IDENTICAL fixture with the name unset
// (§9.4): the pair proves the fixture is able to render the prompt.
//
// Copy is hardcoded (§8), and this file deliberately does not import the
// descriptor module, so that against pre-change code the presence tests fail
// on "prompt not found" rather than on a missing import.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library — the
// repo's established approach (vitest.config.ts header).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const HEADLINE = "Add a name for your farm";
const ACTION = "Add name in Settings →";

const NOW = Date.now();
const DAY_MS = 86_400_000;

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
// Recharts + a live Coinbase fetch; irrelevant to the banner stack.
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});

const CHANNEL_LESS = {
  hub_pubkey: null,
  membership_status: "active",
  node_role: "member",
  is_peered_to_hub: false,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: null,
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
};

const WITH_CHANNEL = {
  ...CHANNEL_LESS,
  is_peered_to_hub: true,
  treasury_channel: {
    channel_id: "1",
    local_sats: 500_000,
    remote_sats: 500_000,
    capacity_sats: 1_000_000,
    is_active: true,
    freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
  },
};

// Fresh grace: tier `current`, never paid, fresh_until in the future.
const FRESH_GRACE = {
  applicable: true,
  member_pubkey: "03" + "a".repeat(64),
  current_tier: "current",
  paid_through: 0,
  price_sats: 10_000,
  period_days: 30,
  deposit_address: "bcrt1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: {
    fresh_until: NOW + 14 * DAY_MS,
    worker_until: NOW + 21 * DAY_MS,
    routing_until: NOW + 28 * DAY_MS,
    close_at: NOW + 35 * DAY_MS,
  },
};

const NAMED = { bitcorn_name: "Green Acres", bitcorn_name_set_at: 1_790_000_000 };
const UNSET = { bitcorn_name: null, bitcorn_name_set_at: null };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue(CHANNEL_LESS);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 0, lightning_sats: 0, total_sats: 0 });
  stub.getSubscriptionStatus.mockImplementation(never); // null: no token yet
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue(UNSET);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function renderDashboard(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard"] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/dashboard", element: React.createElement(MemberDashboard) }),
          React.createElement(Route, { path: "/settings", element: React.createElement("div", null, "SETTINGS PAGE") }),
        ),
      ),
    );
  });
  await flush();
}

const hasPrompt = () => (host.textContent ?? "").includes(HEADLINE);

describe("§9.1 PERMITTING CONTROL — a member WITH a stored name sees NO prompt", () => {
  it("channel-less + named → no prompt", async () => {
    stub.getBitcornName.mockResolvedValue(NAMED);
    await renderDashboard();
    expect(stub.getBitcornName).toHaveBeenCalled(); // the read happened; absence is not "never asked"
    expect(hasPrompt()).toBe(false);
  });
  it("PAIRED POSITIVE: identical fixture, name unset → prompt", async () => {
    stub.getBitcornName.mockResolvedValue(UNSET);
    await renderDashboard();
    expect(hasPrompt()).toBe(true);
  });

  it("with a channel + named → no prompt", async () => {
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    stub.getBitcornName.mockResolvedValue(NAMED);
    await renderDashboard();
    expect(hasPrompt()).toBe(false);
  });
  it("PAIRED POSITIVE: with a channel, name unset → prompt (the gate is the name, not the channel)", async () => {
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    await renderDashboard();
    expect(host.textContent).toContain("Channel role"); // the hasChannel block really rendered
    expect(hasPrompt()).toBe(true);
  });
});

describe("§9.2 the prompt renders for a CHANNEL-LESS member", () => {
  it("treasury_channel null, no name → prompt, alongside the Connect-to-Hub panel", async () => {
    await renderDashboard();
    // Fixture check: this IS the noChannel state, not stats-failed or loading.
    expect(host.textContent).toContain("Connect to Hub");
    expect(host.textContent).not.toContain("Channel role");
    expect(hasPrompt()).toBe(true);
  });

  it("stats failed to load (statsUnavailable) → prompt still renders", async () => {
    stub.getMemberStats.mockRejectedValue(new Error("down"));
    await renderDashboard();
    expect(host.textContent).toContain("Couldn't load your dashboard");
    expect(hasPrompt()).toBe(true);
  });

  it("stats still loading → prompt still renders", async () => {
    stub.getMemberStats.mockImplementation(never);
    await renderDashboard();
    expect(host.textContent).not.toContain("Connect to Hub");
    expect(hasPrompt()).toBe(true);
  });
});

describe("§9.3 the prompt renders during FRESH GRACE and before any status", () => {
  it("status `current`, never paid, fresh_until in the future → prompt", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(FRESH_GRACE);
    await renderDashboard();
    expect(stub.getSubscriptionStatus).toHaveBeenCalled();
    expect(hasPrompt()).toBe(true);
  });

  it("subStatus null (status never arrives — no token yet) → prompt", async () => {
    stub.getSubscriptionStatus.mockImplementation(never);
    await renderDashboard();
    expect(hasPrompt()).toBe(true);
  });
});

describe("§7.1 a FAILED name read does not render the prompt", () => {
  it("getBitcornName rejects → no prompt", async () => {
    stub.getBitcornName.mockRejectedValue(new Error("network"));
    await renderDashboard();
    expect(stub.getBitcornName).toHaveBeenCalled();
    expect(hasPrompt()).toBe(false);
  });
  it("PAIRED POSITIVE: identical fixture, read succeeds with no name → prompt", async () => {
    stub.getBitcornName.mockResolvedValue(UNSET);
    await renderDashboard();
    expect(hasPrompt()).toBe(true);
  });
});

describe("§7.4 the prompt's action goes to Settings", () => {
  it("clicking the action navigates to /settings", async () => {
    await renderDashboard();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === ACTION);
    expect(btn, "action button").toBeTruthy();
    await act(async () => { btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.textContent).toContain("SETTINGS PAGE");
  });
});
