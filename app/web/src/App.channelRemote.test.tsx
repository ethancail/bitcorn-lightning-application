// D3: the remote side of a channel's balance bar is a neutral track, not red.
// The bar's track is .channel-balance-bar's background (styles.css); "Their
// side"'s legend dot on the member Channels page matches it. The network
// graph's "Remote:" line loses its red too.
//
// Harness: App.treasuryCapacity.test.tsx's (the REAL App, member shell).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { cssRules } from "./styleRules.testutil";

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
  getLiquidityHealth: vi.fn(),
  getPendingChannels: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

import NetworkGraph from "./components/NetworkGraph";

const PEER = "02" + "b".repeat(64);
const CHANNELS = [
  { channel_id: "1", peer_pubkey: PEER, capacity_sat: 2_000_000, local_balance_sat: 600_000, remote_balance_sat: 1_400_000, active: 1 },
];

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getNode.mockResolvedValue({ node_role: "node", alias: "lnd-alias", pubkey: "02" + "a".repeat(64), synced_to_chain: true });
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getContacts.mockResolvedValue([{ pubkey: PEER, name: "Treasury", tags: [] }]);
  stub.getLiquidityHealth.mockResolvedValue([]);
  stub.getPendingChannels.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith("/api/channels") ? CHANNELS : []),
  })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

async function mount(el: React.ReactElement, path = "/") {
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const trackBackground = () => {
  const rule = cssRules().find((r) => r.media === null && r.selectors.includes(".channel-balance-bar"));
  expect(rule, ".channel-balance-bar is defined").toBeDefined();
  return rule!.decls["background"];
};

describe("D3: the remote side of a channel bar is neutral", () => {
  it("the track (.channel-balance-bar) is --text-3, not red", () => {
    expect(trackBackground()).toBe("var(--text-3)");
  });

  it("\"Their side\"'s legend dot matches the track; \"Your side\" stays green", async () => {
    const App = (await import("./App")).default;
    const el = await mount(React.createElement(App), "/channels");
    const remote = el.querySelector(".channel-label-remote .channel-dot");
    const local = el.querySelector(".channel-label-local .channel-dot");
    expect(remote, "the remote legend renders").not.toBeNull();
    expect(remote!.getAttribute("style")).toBe(`background: ${trackBackground()};`);
    expect(local!.getAttribute("style")).toBe("background: var(--green);");
  });

  it("the network graph's \"Remote:\" line is not red", async () => {
    const el = await mount(React.createElement(NetworkGraph));
    const node = [...el.querySelectorAll("g")].find((g) => g.getAttribute("style")?.includes("cursor: pointer"));
    expect(node, "a peer node renders").toBeDefined();
    await act(async () => { node!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const remote = [...el.querySelectorAll("span")].find((s) => s.textContent?.startsWith("Remote:"));
    expect(remote, "the hover card shows Remote:").toBeDefined();
    expect(remote!.getAttribute("style") ?? "").not.toContain("red");
  });
});
