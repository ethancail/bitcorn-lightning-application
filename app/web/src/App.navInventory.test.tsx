// PR 5's nav merge: a CHARACTERIZATION test, committed against the two
// sidebars as they stood before the merge (TreasurySidebar and MemberSidebar,
// two copies of one loop). It pins, in order, every child of nav.sidebar —
// the mobile header, the label, each item (tag, href, text, badge) and the
// spacer — for each shell and each declared role. The merge must keep it green
// with NO edit to this file.
//
// Also pinned: the treasury shell never reads the subscription or auto-pay
// status. Both hooks poll; a merged sidebar that called them unconditionally
// would start two member-only polls on the treasury.
//
// Harness: App.daybreakNav.test.tsx's (the REAL App; the API client and
// RailScope stubbed; the theme key set because initTheme() reads matchMedia).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const ctl = vi.hoisted(() => ({
  nodeRole: "node",
  // What getMemberLiquidityStatus resolves to; "reject" makes it fail.
  liquidity: { classification: { channelRole: "farmer" } } as unknown,
  // What getSubscriptionStatus resolves to; null = never resolves.
  subscription: null as unknown,
}));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(async () => ({ node_role: ctl.nodeRole, alias: "node", pubkey: "02" + "a".repeat(64), synced_to_chain: true })),
  getBitcornName: vi.fn(async () => ({ bitcorn_name: null, bitcorn_name_set_at: null })),
  getMemberLiquidityStatus: vi.fn(async () => {
    if (ctl.liquidity === "reject") throw new Error("down");
    return ctl.liquidity;
  }),
  getSubscriptionStatus: vi.fn(() => (ctl.subscription === null ? new Promise<never>(() => {}) : Promise.resolve(ctl.subscription))),
  getAutoPayConfig: vi.fn(() => new Promise<never>(() => {})),
  getAutoBuyAlertBadge: vi.fn(async () => ({ active_count: 2, highest_severity: "warning" })),
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

async function renderShell(opts: {
  treasury?: boolean;
  liquidity?: unknown;
  subscription?: unknown;
  daybreakNav?: boolean;
}) {
  vi.resetModules();
  vi.clearAllMocks();
  ctl.nodeRole = opts.treasury ? "treasury" : "node";
  ctl.liquidity = opts.liquidity ?? { classification: { channelRole: "farmer" } };
  ctl.subscription = opts.subscription ?? null;
  if (opts.treasury) localStorage.setItem("bitcorn_setup_done", "1");
  if (opts.daybreakNav === undefined) vi.doUnmock("./daybreak/launch");
  else vi.doMock("./daybreak/launch", () => ({ SHOW_DAYBREAK_IN_MEMBER_NAV: opts.daybreakNav }));
  const App = (await import("./App")).default;
  // Pages whose reads are stubbed: Daybreak for the member, the editor for the treasury.
  window.history.pushState({}, "", opts.treasury ? "/daybreak-editor" : "/daybreak");
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

/** nav.sidebar's direct children, in order, as readable strings. */
function inventory(el: Element): string[] {
  const nav = el.querySelector("nav.sidebar");
  expect(nav, "the sidebar must render").not.toBeNull();
  return Array.from(nav!.children).map((child) => {
    if (child.classList.contains("sidebar-mobile-header")) return `header ${child.textContent}`;
    if (child.classList.contains("sidebar-label")) return `label ${child.textContent}`;
    if (child.classList.contains("sidebar-section")) {
      const item = child.firstElementChild!;
      const badge = item.querySelector(".badge");
      const clone = item.cloneNode(true) as Element;
      clone.querySelector(".badge")?.remove();
      const where = item.tagName === "A" ? ` ${item.getAttribute("href")}` : "";
      const b = badge ? ` [${badge.className} ${badge.textContent}]` : "";
      return `${item.tagName.toLowerCase()}${where} "${clone.textContent}"${b}`;
    }
    if ((child as HTMLElement).style.flexGrow === "1" && child.childElementCount === 0) return "spacer";
    return `?? ${child.outerHTML.slice(0, 60)}`;
  });
}

const HEAD = ["header Menu✕", "label Navigate"];
const AUTOBUY_BADGE = "[badge badge-amber 2]";

const TREASURY = [
  ...HEAD,
  'a /dashboard "▤Dashboard"',
  'button "₿Buy Bitcoin"',
  'a /deposit "↙Deposit Bitcoin"',
  'a /charts "⟠Charts"',
  'a /contacts "☰Contacts"',
  'a /peers "⟐Peers"',
  'a /channels "◈Channels"',
  'a /payments "↗Payments"',
  'a /liquidity "≋Liquidity"',
  'a /swaps "⟲Swaps"',
  `a /auto-buy "📈Auto-Buy" ${AUTOBUY_BADGE}`,
  'a /valuation-input "◐Valuation Inputs"',
  'a /daybreak-editor "☀Daybreak Editor"',
  'a /admin/members "◆Members"',
  "spacer",
  'a /settings "⚙Settings"',
];

function member(opts: { liquidity: string; daybreak?: boolean; stablecoin?: boolean; settingsBadge?: string }) {
  return [
    ...HEAD,
    'a /dashboard "▤My Dashboard"',
    'button "₿Buy Bitcoin"',
    'a /deposit "↙Deposit Bitcoin"',
    opts.liquidity,
    'a /charts "⟠Charts"',
    ...(opts.daybreak === false ? [] : ['a /daybreak "☀Daybreak"']),
    'a /contacts "☰Contacts"',
    'a /channels "◈My Channels"',
    `a /auto-buy "📈Auto-Buy" ${AUTOBUY_BADGE}`,
    'a /payments "↗My Payments"',
    ...(opts.stablecoin === false ? [] : ['a /stablecoin "◇Stablecoin"']),
    "spacer",
    `a /settings "⚙Settings"${opts.settingsBadge ?? ""}`,
  ];
}

const WITHDRAW = 'a /cashout "↗Withdraw"';
const TOP_UP = 'a /refill "↙Top Up"';

// A gated (routing_lapsed) subscription: hides the Stablecoin entry and shows
// the orange "!" on Settings.
const LAPSED = {
  applicable: true,
  member_pubkey: "02".padEnd(66, "a"),
  current_tier: "routing_lapsed",
  paid_through: 1_700_000_000_000,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bcrt1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 1_700_000_000_000, worker_until: 1_700_000_000_000, routing_until: 1_700_000_000_000, close_at: 1_700_000_000_000 },
};

describe("nav inventory, per shell and declared role (characterization, before the merge)", () => {
  it("treasury", async () => {
    const el = await renderShell({ treasury: true });
    expect(el.querySelector(".topbar-tag")?.textContent).toBe("TREASURY");
    expect(inventory(el)).toEqual(TREASURY);
  });

  it("treasury never reads the subscription or auto-pay status (no member-only polls)", async () => {
    await renderShell({ treasury: true });
    expect(stub.getAutoBuyAlertBadge, "anti-vacuity: the sidebar's own read ran").toHaveBeenCalled();
    expect(stub.getSubscriptionStatus).not.toHaveBeenCalled();
    expect(stub.getAutoPayConfig).not.toHaveBeenCalled();
  });

  it("member, farmer → Withdraw", async () => {
    const el = await renderShell({ liquidity: { classification: { channelRole: "farmer" } } });
    expect(inventory(el)).toEqual(member({ liquidity: WITHDRAW }));
  });

  it("member, merchant → Top Up", async () => {
    const el = await renderShell({ liquidity: { classification: { channelRole: "merchant" } } });
    expect(inventory(el)).toEqual(member({ liquidity: TOP_UP }));
  });

  it("member, merchant declared with the channel inactive (SH9's top-level channelRole) → Top Up", async () => {
    const el = await renderShell({ liquidity: { channelRole: "merchant", classification: null } });
    expect(inventory(el)).toEqual(member({ liquidity: TOP_UP }));
  });

  it("member, role unknown → Withdraw", async () => {
    const el = await renderShell({ liquidity: { classification: { channelRole: "unknown" } } });
    expect(inventory(el)).toEqual(member({ liquidity: WITHDRAW }));
  });

  it("member, role never declared (no classification) → Withdraw", async () => {
    const el = await renderShell({ liquidity: { classification: null } });
    expect(inventory(el)).toEqual(member({ liquidity: WITHDRAW }));
  });

  it("member, role read fails → Withdraw", async () => {
    const el = await renderShell({ liquidity: "reject" });
    expect(inventory(el)).toEqual(member({ liquidity: WITHDRAW }));
  });

  it("member, Daybreak's nav flag off → no Daybreak entry", async () => {
    const el = await renderShell({ daybreakNav: false });
    expect(inventory(el)).toEqual(member({ liquidity: WITHDRAW, daybreak: false }));
  });

  it("member, merchant with a lapsed subscription → no Stablecoin entry; Settings carries the orange '!'", async () => {
    const el = await renderShell({ liquidity: { classification: { channelRole: "merchant" } }, subscription: LAPSED });
    expect(stub.getSubscriptionStatus, "anti-vacuity: the member shell read the status").toHaveBeenCalled();
    expect(inventory(el)).toEqual(member({ liquidity: TOP_UP, stablecoin: false, settingsBadge: " [badge badge-orange !]" }));
  });
});
