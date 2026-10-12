// The Daybreak member-nav entry is SHOWN — launched 2026-10-12 (daybreak/launch.ts).
// The treasury shell never carries the member entry; its own "Daybreak Editor"
// entry is untouched by the flag.
//
// Renders the REAL App, so the real MemberSidebar / TreasurySidebar and the
// real shell Routes are what is asserted on. Stubbed: the API client (every
// call the shells and the pages make), RailScope (a pass-through — wagmi is not
// what is under test), and the theme key, because App.tsx's initTheme() reads
// window.matchMedia at import, which jsdom does not provide.
//
// The constant is read from the real module for the committed case — so the
// committed value is what is tested — and replaced with vi.doMock for the
// "off" override, which proves the flag still reaches the app.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const role = vi.hoisted(() => ({ node_role: "node" }));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(async () => ({ node_role: role.node_role, alias: "member", pubkey: "02" + "a".repeat(64), synced_to_chain: true })),
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

async function renderAppAt(path: string, navVisible?: boolean, nodeRole = "node") {
  vi.resetModules();
  role.node_role = nodeRole;
  // A treasury that has finished setup goes straight to the treasury shell.
  if (nodeRole === "treasury") localStorage.setItem("bitcorn_setup_done", "1");
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
  localStorage.removeItem("bitcorn_setup_done");
});

const nav = (el: Element) => el.querySelector("nav.sidebar");
const navHrefs = (el: Element) => Array.from(nav(el)?.querySelectorAll("a[href]") ?? []).map((a) => a.getAttribute("href"));

describe("the Daybreak member-nav entry is launched; the treasury nav is unchanged", () => {
  it("PERMITS (the committed value): the member nav has a Daybreak link to /daybreak", async () => {
    const el = await renderAppAt("/daybreak");
    expect(nav(el), "the member sidebar must render").not.toBeNull();
    expect(navHrefs(el)).toContain("/charts"); // anti-vacuity: the nav's items are readable
    expect(navHrefs(el)).toContain("/daybreak");
    const link = nav(el)!.querySelector('a[href="/daybreak"]');
    expect(link?.textContent).toContain("Daybreak");
  });

  it("the /daybreak route renders the page", async () => {
    const el = await renderAppAt("/daybreak");
    const main = el.querySelector("main.main-content");
    expect(main?.querySelector("h1")?.textContent).toBe("BitCorn Daybreak");
    expect(main?.querySelector('[data-testid="daybreak-no-edition"]')).not.toBeNull();
    expect(window.location.pathname).toBe("/daybreak"); // not redirected to /dashboard
    expect(stub.getDaybreakEdition).toHaveBeenCalled();
  });

  it("FORBIDS (the committed value): the treasury nav has no member Daybreak entry; its Daybreak Editor entry is unchanged", async () => {
    const el = await renderAppAt("/daybreak-editor", undefined, "treasury");
    expect(el.querySelector(".topbar-tag")?.textContent).toBe("TREASURY"); // anti-vacuity: the treasury shell rendered
    expect(navHrefs(el)).toContain("/dashboard"); // anti-vacuity: the nav's items are readable
    expect(navHrefs(el)).not.toContain("/daybreak");
    const daybreakLinks = Array.from(nav(el)!.querySelectorAll("a[href]")).filter((a) => a.textContent?.includes("Daybreak"));
    expect(daybreakLinks.map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["/daybreak-editor", "☀Daybreak Editor"]]);
  });

  it("TOGGLE: overriding the value to false hides the member link — the flag still reaches the app", async () => {
    const el = await renderAppAt("/daybreak", false);
    expect(nav(el), "the member sidebar must render").not.toBeNull();
    expect(navHrefs(el)).toContain("/charts"); // anti-vacuity: the nav's items are readable
    expect(navHrefs(el)).not.toContain("/daybreak");
    expect(nav(el)!.textContent).not.toContain("Daybreak");
  });
});
