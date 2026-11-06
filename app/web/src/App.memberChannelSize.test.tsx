// Drive-mode P3 (R40(2); R16(6), R17(3)): on a MEMBER's My Channels page, the
// hub channel is "Too small" only below the one formula's minimum for the
// member's strategy, and "Recommended" names that size — not a fixed
// 2,000,000 with 5,000,000 recommended. The treasury's branch is unchanged.
//
// Harness: App.channelRemote.test.tsx's (the REAL App; the API client and
// RailScope stubbed; fetch stubbed for the page's raw /api/channels read).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getBitcornName: vi.fn(),
  getProfileAlias: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoBuyAlertBadge: vi.fn(),
  getDaybreakEdition: vi.fn(),
  getContacts: vi.fn(),
  getPendingChannels: vi.fn(),
  getTransferSettings: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  const { getTransferSettings, ...rest } = stub;
  return {
    ...actual,
    api: { ...(actual as any).api, ...rest },
    transfersApi: { ...(actual as any).transfersApi, getTransferSettings },
  };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

const TREASURY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
const MEMBER_PEER = "02" + "c".repeat(64);
let channels: unknown[] = [];

const settings = (strategy: string) => ({
  settings: { strategy, fee_limit_pct_bps: 200, fee_limit_usd_cents: 300, daily_fee_budget_usd_cents: 1_000, max_moved_per_day_usd_cents: 50_000 },
  member: { role: "farmer", capacity_sats: 500_000, hub_active: true, save: { sats: 406_055 }, open: { sats: 499_002 } },
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getContacts.mockResolvedValue([]);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getTransferSettings.mockResolvedValue(settings("save"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith("/api/channels") ? channels : []),
  })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

async function channelsPage(nodeRole: string, ch: Array<{ peer: string; capacity: number }>) {
  channels = ch.map((c, i) => ({
    channel_id: String(i + 1), peer_pubkey: c.peer, capacity_sat: c.capacity,
    local_balance_sat: c.capacity / 2, remote_balance_sat: c.capacity / 2, active: 1,
  }));
  stub.getNode.mockResolvedValue({ node_role: nodeRole, alias: "lnd-alias", pubkey: "02" + "a".repeat(64), synced_to_chain: true });
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/channels");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const text = () => (host?.textContent ?? "").replace(/\s+/g, " ");

describe("a member's hub channel is measured against the formula's size", () => {
  it("500,000 on Save on fees (needs 406,055): not too small — the old 2,000,000 rule would say it was", async () => {
    await channelsPage("member", [{ peer: TREASURY, capacity: 500_000 }]);
    expect(text()).not.toContain("Too small");
    expect(text()).not.toContain("Upgrade recommended");
  });

  it("400,000: too small, and the upgrade names 406,055, not 5,000,000", async () => {
    await channelsPage("member", [{ peer: TREASURY, capacity: 400_000 }]);
    expect(text()).toContain("Too small");
    expect(text()).toContain("Upgrade recommended → 406,055 sats");
    expect(text()).not.toContain("5,000,000");
  });

  it("R19(6): on Keep room open the size is Keep room open's (499,002)", async () => {
    stub.getTransferSettings.mockResolvedValue(settings("open"));
    await channelsPage("member", [{ peer: TREASURY, capacity: 450_000 }]);
    expect(text()).toContain("Upgrade recommended → 499,002 sats");
  });
});

describe("the treasury's branch is unchanged", () => {
  it("the treasury node never reads the member's transfer settings", async () => {
    await channelsPage("treasury", [{ peer: MEMBER_PEER, capacity: 500_000 }]);
    expect(stub.getTransferSettings).not.toHaveBeenCalled();
  });
});
