// The Daybreak Editor is a TREASURY page: its nav entry is in the treasury
// shell's sidebar, never the member shell's (spec §3.4.5, "THE EDITOR SCREEN").
// The page itself checks no role, like every treasury page; assertTreasury
// enforces it server-side on the proxies.
//
// Renders the REAL App, so the real TreasurySidebar / MemberSidebar and the
// real shell Routes are what is asserted on. Stubbed: the API client (every
// call the shells and the page make), RailScope (a pass-through), and the theme
// key, because App.tsx's initTheme() reads window.matchMedia at import, which
// jsdom does not provide. Same harness as App.daybreakNav.test.tsx.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const role = vi.hoisted(() => ({ node_role: "treasury" }));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(async () => ({ node_role: role.node_role, alias: "node", pubkey: "02" + "a".repeat(64), synced_to_chain: true })),
  getMemberLiquidityStatus: vi.fn(async () => ({ classification: { channelRole: "farmer" } })),
  getSubscriptionStatus: vi.fn(() => new Promise<never>(() => {})),
  getAutoPayConfig: vi.fn(() => new Promise<never>(() => {})),
  getAutoBuyAlertBadge: vi.fn(async () => ({ active_count: 0, highest_severity: null })),
  getDaybreakEdition: vi.fn(async () => ({ state: "unavailable" })),
  getDaybreakEditor: vi.fn(() => new Promise<never>(() => {})),
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

async function renderAppAt(path: string, nodeRole: string, memberDaybreakNavVisible?: boolean) {
  vi.resetModules();
  role.node_role = nodeRole;
  // A treasury that has finished setup goes straight to the treasury shell.
  localStorage.setItem("bitcorn_setup_done", "1");
  if (memberDaybreakNavVisible === undefined) vi.doUnmock("./daybreak/launch");
  else vi.doMock("./daybreak/launch", () => ({ SHOW_DAYBREAK_IN_MEMBER_NAV: memberDaybreakNavVisible }));
  const App = (await import("./App")).default;
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(App));
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.doUnmock("./daybreak/launch");
  localStorage.removeItem("bitcorn_setup_done");
});

const nav = (el: Element) => el.querySelector("nav.sidebar");
const navHrefs = (el: Element) => Array.from(nav(el)?.querySelectorAll("a[href]") ?? []).map((a) => a.getAttribute("href"));

describe("the Daybreak Editor nav entry is TREASURY-only", () => {
  it("PERMITS: the treasury sidebar links to /daybreak-editor, and the route renders the editor", async () => {
    const el = await renderAppAt("/daybreak-editor", "treasury");
    expect(navHrefs(el)).toContain("/dashboard"); // anti-vacuity: the treasury nav rendered
    expect(navHrefs(el)).toContain("/daybreak-editor");
    expect(nav(el)!.querySelector('a[href="/daybreak-editor"]')?.textContent).toContain("Daybreak Editor");
    expect(el.querySelector("main.main-content h1")?.textContent).toBe("Daybreak Editor");
    expect(window.location.pathname).toBe("/daybreak-editor");
    expect(stub.getDaybreakEditor).toHaveBeenCalled();
  });

  for (const visible of [undefined, true]) {
    it(`FORBIDS: the member sidebar has NO editor entry (member Daybreak nav ${visible === undefined ? "as committed" : "switched on"})`, async () => {
      const el = await renderAppAt("/dashboard", "node", visible);
      expect(nav(el), "the member sidebar must render").not.toBeNull();
      expect(navHrefs(el)).toContain("/charts"); // anti-vacuity: the member nav's items are readable
      expect(navHrefs(el)).not.toContain("/daybreak-editor");
      expect(nav(el)!.textContent).not.toContain("Daybreak Editor");
    });
  }

  it("FORBIDS: the member shell does not route /daybreak-editor — it redirects to the dashboard", async () => {
    stub.getDaybreakEditor.mockClear();
    await renderAppAt("/daybreak-editor", "node");
    expect(window.location.pathname).toBe("/dashboard");
    expect(stub.getDaybreakEditor).not.toHaveBeenCalled();
  });
});
