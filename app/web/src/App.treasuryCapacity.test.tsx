// D3 on the treasury's capacity (PR3-1) and the "Too small" badge (PR3-5):
// never red. The treasury's lanes keep their own states; the tier that was red
// turns amber with the other warnings. PR3-7: amber on the bar and the badge's
// dot only — the percentage and the badge's word stay in --text.
//
// Harness: App.declaredRole.test.tsx's (the REAL App), with fetch stubbed for
// the Channels page's raw /api/channels read.

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
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

const pk = (c: string) => "02" + c.repeat(64);
const MERCHANT = pk("b"), FARMER = pk("c"), EXTERNAL = pk("d"), SMALL = pk("e");

/** Treasury-local %s that land each lane in its formerly-red tier. */
const CHANNELS = [
  { channel_id: "1", peer_pubkey: MERCHANT, capacity_sat: 2_000_000, local_balance_sat: 1_800_000, remote_balance_sat: 200_000, active: 1 }, // 90% → exhausted
  { channel_id: "2", peer_pubkey: FARMER, capacity_sat: 2_000_000, local_balance_sat: 200_000, remote_balance_sat: 1_800_000, active: 1 }, // 10% → full_needs_withdrawal
  { channel_id: "3", peer_pubkey: EXTERNAL, capacity_sat: 2_000_000, local_balance_sat: 100_000, remote_balance_sat: 1_900_000, active: 1 }, // 5% → critical
];
const CONTACTS = [
  { pubkey: MERCHANT, name: "Merchant1", tags: ["merchant"] },
  { pubkey: FARMER, name: "Farmer1", tags: ["farmer"] },
  { pubkey: EXTERNAL, name: "Ext1", tags: ["external"] },
];

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let channels: unknown[] = CHANNELS;

beforeEach(() => {
  vi.clearAllMocks();
  channels = CHANNELS;
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getContacts.mockResolvedValue(CONTACTS);
  stub.getPendingChannels.mockResolvedValue([]);
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

async function renderAppAt(path: string, nodeRole: string) {
  stub.getNode.mockResolvedValue({ node_role: nodeRole, alias: "lnd-alias", pubkey: pk("a"), synced_to_chain: true });
  const App = (await import("./App")).default;
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const style = (el: Element) => el.getAttribute("style") ?? "";
const rowOf = (el: Element, name: string) =>
  [...el.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(name));

describe("PR3-1: the treasury's lanes — the red tier turns amber, its words stay --text", () => {
  for (const [name, label] of [["Merchant1", "Exhausted"], ["Farmer1", "Needs withdrawal"], ["Ext1", "Critical"]]) {
    it(`${name}: ${label} → amber bar, a caution badge, the % in --text`, async () => {
      const el = await renderAppAt("/channels", "treasury");
      const row = rowOf(el, name);
      expect(row, `${name}'s lane row renders`).toBeDefined();
      expect(style(row!.querySelector('[data-testid="capacity-bar"]')!)).toContain("var(--amber)");
      const badge = [...row!.querySelectorAll(".badge")].find((b) => b.textContent === label);
      expect(badge, `the ${label} badge renders`).toBeDefined();
      expect(badge!.className).toContain("badge-caution");
      expect(row!.innerHTML).not.toMatch(/badge-red|badge-amber|var\(--red\)/);
      const pct = [...row!.querySelectorAll('[data-testid="capacity-text"]')].filter((t) => !t.classList.contains("badge"));
      expect(pct.length).toBe(1);
      expect(style(pct[0])).toContain("color: var(--text)");
    });
  }

  it("PERMITTING: a fresh merchant lane stays green", async () => {
    channels = [{ ...CHANNELS[0], local_balance_sat: 200_000, remote_balance_sat: 1_800_000 }]; // 10% → fresh
    const el = await renderAppAt("/channels", "treasury");
    const row = rowOf(el, "Merchant1")!;
    expect(style(row.querySelector('[data-testid="capacity-bar"]')!)).toContain("var(--green)");
    expect(row.querySelector(".badge-green")?.textContent).toBe("Fresh");
  });
});

describe("PR3-5: \"Too small\" flags a size, not an error", () => {
  it("an undersized channel's badge is a caution badge, never red", async () => {
    channels = [{ channel_id: "9", peer_pubkey: SMALL, capacity_sat: 500_000, local_balance_sat: 250_000, remote_balance_sat: 250_000, active: 1 }];
    const el = await renderAppAt("/channels", "node");
    const badge = [...el.querySelectorAll(".badge")].find((b) => b.textContent === "Too small");
    expect(badge, "the Too small badge renders").toBeDefined();
    expect(badge!.className).toContain("badge-caution");
    expect(badge!.className).not.toMatch(/badge-red|badge-amber/);
  });
});

describe("R3 (PR 7): lane state badges in sentence case; the action buttons unchanged", () => {
  // Treasury-local %s chosen for each multi-word state.
  const lane = (id: string, peer: string, localPct: number) => ({
    channel_id: id, peer_pubkey: peer, capacity_sat: 2_000_000,
    local_balance_sat: localPct * 20_000, remote_balance_sat: (100 - localPct) * 20_000, active: 1,
  });

  it("Renew soon, Getting full, Needs withdrawal — and the Renew Soon / Renew Now buttons", async () => {
    const M2 = pk("f"), F2 = pk("9");
    channels = [lane("1", MERCHANT, 80), lane("2", FARMER, 20), lane("4", M2, 90), lane("5", F2, 10)];
    stub.getContacts.mockResolvedValue([
      ...CONTACTS,
      { pubkey: M2, name: "Merchant2", tags: ["merchant"] },
      { pubkey: F2, name: "Farmer2", tags: ["farmer"] },
    ]);
    const el = await renderAppAt("/channels", "treasury");
    const badgeIn = (name: string) => rowOf(el, name)!.querySelector('.badge[data-testid="capacity-text"]')!.textContent;
    expect(badgeIn("Merchant1")).toBe("Renew soon");
    expect(badgeIn("Farmer1")).toBe("Getting full");
    expect(badgeIn("Farmer2")).toBe("Needs withdrawal");
    const button = (name: string) => rowOf(el, name)!.querySelector("button")!.textContent;
    expect(button("Merchant1")).toBe("Renew Soon");
    expect(button("Merchant2")).toBe("Renew Now");
  });
});

describe("PR 7 cleanup: the Channels page reads no liquidity health", () => {
  // The health list was fetched on load and on refresh, and read only by a
  // local nothing used; healthColor had no reader at all.
  it("loading /channels as the treasury never requests /api/treasury/liquidity-health", async () => {
    const el = await renderAppAt("/channels", "treasury");
    expect(rowOf(el, "Merchant1"), "the lanes rendered, so the page's reads ran").toBeDefined();
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api/channels")), "the fetch stub saw the page's reads").toBe(true);
    expect(urls.filter((u) => u.includes("liquidity-health"))).toEqual([]);
  });

  it("the client method and healthColor are gone", async () => {
    const { api } = await vi.importActual<typeof import("./api/client")>("./api/client");
    expect("getLiquidityHealth" in api).toBe(false);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "App.tsx"), "utf8");
    expect(src, "the scan reads ChannelsPage").toContain("function ChannelsPage()");
    expect(src).not.toMatch(/healthColor|getLiquidityHealth/);
  });
});
