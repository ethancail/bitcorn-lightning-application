// The member top bar shows the Bitcorn-level name, else the public alias.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §9.1, §12 P11. Decision D8 call 7.
//
// Renders the REAL App, so the real Topbar, MemberShell and TreasuryShell are
// what is asserted on — the harness of App.daybreakNav.test.tsx. Stubbed: the
// API client, RailScope (a pass-through), and the theme key (initTheme() reads
// window.matchMedia at import, which jsdom lacks).
//
// ⚠ THE PERMITTING CONTROL LEADS: a set name SHOWS. Every fallback case below
// (alias, "—", a failed read, the treasury) is something a top bar that never
// reads the name would also produce.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const PUBKEY = "02" + "a".repeat(64);

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getBitcornName: vi.fn(),
  getMemberLiquidityStatus: vi.fn(async () => ({ classification: { channelRole: "farmer" } })),
  getSubscriptionStatus: vi.fn(() => new Promise<never>(() => {})),
  getAutoPayConfig: vi.fn(() => new Promise<never>(() => {})),
  getAutoBuyAlertBadge: vi.fn(async () => ({ active_count: 0, highest_severity: null })),
  getDaybreakEdition: vi.fn(async () => ({ state: "unavailable" })),
  // Treasury shell at /admin/members — the roster's reads never settle, so the
  // page stays in its loading state and only the shell is under test.
  getAdminMembers: vi.fn(() => new Promise<never>(() => {})),
  getContacts: vi.fn(() => new Promise<never>(() => {})),
  getAdminSubscriptionRevenue: vi.fn(() => new Promise<never>(() => {})),
  getAdminPublicAliases: vi.fn(() => new Promise<never>(() => {})),
  getAdminPrivateNames: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const memberNode = (alias: string | null) => ({ node_role: "node", alias, pubkey: PUBKEY, synced_to_chain: true });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getNode.mockResolvedValue(memberNode("lnd-alias"));
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function renderAppAt(path: string) {
  const App = (await import("./App")).default;
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return host;
}

/** The node label in the top bar: the span right after the sync dot. */
function topbarLabel(el: Element): string {
  const node = el.querySelector("header.topbar .topbar-node");
  if (!node) throw new Error("no .topbar-node rendered");
  const spans = Array.from(node.children).filter((c) => c.tagName === "SPAN");
  // [pulse-dot, label, pubkey]
  return (spans[1]?.textContent ?? "").trim();
}

describe("P11 — the member top bar", () => {
  it("PERMITTING: shows the Bitcorn-level name when set, in place of the alias", async () => {
    const el = await renderAppAt("/daybreak");
    expect(el.querySelector("header.topbar")?.textContent).toContain("MEMBER");
    expect(topbarLabel(el)).toBe("Green Acres");
    expect(topbarLabel(el)).not.toContain("lnd-alias");
  });

  it("no name set → the public alias", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
    const el = await renderAppAt("/daybreak");
    expect(topbarLabel(el)).toBe("lnd-alias");
  });

  it("neither name nor alias → '—'", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
    stub.getNode.mockResolvedValue(memberNode(null));
    const el = await renderAppAt("/daybreak");
    expect(topbarLabel(el)).toBe("—");
  });

  it("a FAILED name read falls back to the alias, silently", async () => {
    stub.getBitcornName.mockRejectedValue(Object.assign(new Error("unreachable"), { status: 500 }));
    const el = await renderAppAt("/daybreak");
    expect(topbarLabel(el)).toBe("lnd-alias");
  });

  it("re-reads on bitcorn:name-changed (the Settings save), with no poll", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
    const el = await renderAppAt("/daybreak");
    expect(topbarLabel(el)).toBe("lnd-alias");
    const reads = stub.getBitcornName.mock.calls.length;

    stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Prairie Mill", bitcorn_name_set_at: 2 });
    await act(async () => { window.dispatchEvent(new CustomEvent("bitcorn:name-changed")); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(stub.getBitcornName.mock.calls.length).toBe(reads + 1);
    expect(topbarLabel(el)).toBe("Prairie Mill");
  });
});

describe("P11 — the treasury top bar is unchanged", () => {
  it("shows the alias, and never reads the member name", async () => {
    localStorage.setItem("bitcorn_setup_done", "1");
    stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "BitCorn1", pubkey: PUBKEY, synced_to_chain: true });
    const el = await renderAppAt("/admin/members");
    expect(el.querySelector("header.topbar")?.textContent).toContain("TREASURY");
    expect(topbarLabel(el)).toBe("BitCorn1");
    expect(stub.getBitcornName).not.toHaveBeenCalled();
  });
});
