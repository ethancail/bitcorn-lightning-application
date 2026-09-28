// The Daybreak member-nav entry is HIDDEN until launch, and the door stays open:
// the /daybreak route is still registered and renders the page (the "hide the
// entry, keep the door" pattern, App.tsx's Stablecoin entry).
//
// Renders the REAL App at /daybreak, so the real MemberSidebar and the real
// member-shell Routes are what is asserted on. Stubbed: the API client (every
// call the shell and the page make), RailScope (a pass-through — wagmi is not
// what is under test), and the theme key, because App.tsx's initTheme() reads
// window.matchMedia at import, which jsdom does not provide.
//
// The constant is read from the real module for the "off" case — so the
// committed value is what is tested — and replaced with vi.doMock for "on".
//
// Harness: react-dom/client createRoot inside act(), no Testing Library.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const stub = vi.hoisted(() => ({
  getNode: vi.fn(async () => ({ node_role: "node", alias: "member", pubkey: "02" + "a".repeat(64), synced_to_chain: true })),
  getMemberLiquidityStatus: vi.fn(async () => ({ classification: { channelRole: "farmer" } })),
  getSubscriptionStatus: vi.fn(() => new Promise<never>(() => {})),
  getAutoPayConfig: vi.fn(() => new Promise<never>(() => {})),
  getAutoBuyAlertBadge: vi.fn(async () => ({ active_count: 0, highest_severity: null })),
  getDaybreakEdition: vi.fn(async () => ({ state: "unavailable" })),
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

async function renderAppAt(path: string, navVisible?: boolean) {
  vi.resetModules();
  if (navVisible === undefined) vi.doUnmock("./daybreak/launch");
  else vi.doMock("./daybreak/launch", () => ({ SHOW_DAYBREAK_IN_MEMBER_NAV: navVisible }));
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
});

const nav = (el: Element) => el.querySelector("nav.sidebar");
const navHrefs = (el: Element) => Array.from(nav(el)?.querySelectorAll("a[href]") ?? []).map((a) => a.getAttribute("href"));

describe("the Daybreak nav entry is hidden until launch; the route stays registered", () => {
  it("OFF (the committed value): the member nav has NO Daybreak item", async () => {
    const el = await renderAppAt("/daybreak");
    expect(nav(el), "the member sidebar must render").not.toBeNull();
    expect(navHrefs(el)).toContain("/charts"); // anti-vacuity: the nav's items are readable
    expect(navHrefs(el)).not.toContain("/daybreak");
    expect(nav(el)!.textContent).not.toContain("Daybreak");
  });

  it("OFF: the /daybreak route still renders the page — reachable directly", async () => {
    const el = await renderAppAt("/daybreak");
    const main = el.querySelector("main.main-content");
    expect(main?.querySelector("h1")?.textContent).toBe("BitCorn Daybreak");
    expect(main?.querySelector('[data-testid="daybreak-no-edition"]')).not.toBeNull();
    expect(window.location.pathname).toBe("/daybreak"); // not redirected to /dashboard
    expect(stub.getDaybreakEdition).toHaveBeenCalled();
  });

  it("ON: the member nav shows the Daybreak item, linking to /daybreak", async () => {
    const el = await renderAppAt("/daybreak", true);
    expect(navHrefs(el)).toContain("/daybreak");
    const link = nav(el)!.querySelector('a[href="/daybreak"]');
    expect(link?.textContent).toContain("Daybreak");
  });
});
