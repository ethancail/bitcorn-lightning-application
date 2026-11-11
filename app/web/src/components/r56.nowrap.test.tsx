// drive-mode R56 (Ethan, "recs", 2026-11-11), from R45's 390 px screenshot gate:
//   (1) "Auto-Buy" in R45's services sentence uses a NON-BREAKING hyphen
//       (U+2011), on the panel's overdue alert and the banner, so it never
//       splits at the hyphen ("Auto- / Buy").
//   (2) every amount on the dashboard banner sits inside the same no-wrap
//       span the panel and the pay modal use (.sub-amount, G3 ruling R2), so
//       "$25.20 (42,000 sats)" never splits ("(42,000 / sats)").
//
// ⚠ PRE-CHANGE RUN: red at cbf0674.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") },
}));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoPayHistory: vi.fn(),
  getExchangeRate: vi.fn(),
  getPayFromNodeQuote: vi.fn(),
  getPayFromNodePending: vi.fn(),
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "./SubscriptionPanel";
import MemberSubscriptionBanner from "./MemberSubscriptionBanner";
import { bannerFor } from "./subscriptionBanner";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const PRICE = 42_000;
const USD = 60_000; // → $25.20
const NBH = "‑"; // NON-BREAKING HYPHEN
const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };

type Tier = "prepay" | "current" | "routing_lapsed" | "close_due";
const status = (tier: Tier, o: Record<string, unknown> = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: tier,
  paid_through: NOW - 35 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: "bc1qpinnedsubscriptionaddr000000000000zz",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: NOW - 5 * DAY, routing_until: NOW - 5 * DAY, close_at: NOW + 25 * DAY },
  ...VERIFIED,
  ...o,
});
const PRE_PAUSE = () =>
  status("current", { paid_through: NOW - DAY, grace: { fresh_until: 0, worker_until: NOW + 29 * DAY, routing_until: NOW + 29 * DAY, close_at: NOW + 59 * DAY } });

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue({
    enabled: false, enabled_at: null, last_acknowledged_price: null, last_acknowledged_price_at: null,
    current_price: PRICE, price_change_pending: false, status_verification: "verified",
    status_verification_reason: null, price_refusal: null, active_alerts: [],
    badge: { active_count: 0, highest_severity: null },
  });
  stub.getAutoPayHistory.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: USD, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" });
  stub.getPayFromNodePending.mockResolvedValue({ pending: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  nowSpy.mockRestore();
});

async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}
async function render(el: React.ReactElement) {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, el)); });
  await flush();
}
const banner = (s: any, usdRate: number | null) => render(React.createElement(MemberSubscriptionBanner, { status: s, usdRate }));
const tierBanner = () => host.querySelector(".member-sub-banner") as HTMLElement;
const amounts = (el: Element | null) => [...(el?.querySelectorAll(".sub-amount") ?? [])].map((e) => e.textContent);
/** The banner's text with every .sub-amount removed: what is left must hold no
 *  amount, so no amount can be split across a line by the browser. */
const outsideAmounts = (el: Element) => {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll(".sub-amount").forEach((e) => e.remove());
  return (c.textContent ?? "").replace(/\s+/g, " ");
};
const MONEY = /\$\d|\d[\d,]* sats/;

describe("R56 (1) — 'Auto‑Buy' never splits at its hyphen", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it.each(["routing_lapsed", "close_due"] as const)("%s banner: U+2011, no ASCII hyphen", (tier) => {
    const d = bannerFor(status(tier) as any, NOW, USD);
    expect(d.context).toContain(`Auto${NBH}Buy`);
    expect(d.body).toContain(`Auto${NBH}Buy`);
    expect(`${d.context} ${d.body}`).not.toContain("Auto-Buy");
  });

  it.each(["routing_lapsed", "close_due"] as const)("%s panel alert: U+2011, no ASCII hyphen", async (tier) => {
    stub.getSubscriptionStatus.mockResolvedValue(status(tier));
    await render(React.createElement(SubscriptionPanel));
    const alert = host.querySelector(".sub-alert")!.textContent ?? "";
    expect(alert).toContain(`hosted services are paused: Auto${NBH}Buy, with its Valuation Chart`);
    expect(alert).not.toContain("Auto-Buy");
  });

  it("the rendered banner too", async () => {
    await banner(status("routing_lapsed"), USD);
    expect(tierBanner().textContent).toContain(`Auto${NBH}Buy`);
    expect(tierBanner().textContent).not.toContain("Auto-Buy");
  });
});

describe("R56 (2) — every amount on the dashboard banner is one unbreakable unit", () => {
  const CASES: Array<{ name: string; s: () => any; body: string; label: string }> = [
    { name: "prepay", s: () => status("prepay"), body: "$25.20 (42,000 sats)", label: "$25.20" },
    { name: "current (pre-pause)", s: PRE_PAUSE, body: "$25.20 (42,000 sats)", label: "$25.20" },
    { name: "routing_lapsed", s: () => status("routing_lapsed"), body: "$25.20 (42,000 sats)", label: "$25.20" },
    { name: "close_due", s: () => status("close_due"), body: "$25.20 (42,000 sats)", label: "$25.20" },
  ];

  /** The button is `.btn` — inline-flex with a 6px gap — so a label split into
   *  text + span becomes two flex items and gains a visible gap ("Renew␣␣$X",
   *  seen at the c2 re-shoot). The whole label is ONE .sub-amount child. */
  const buttonIsOneUnit = (btn: Element | null, label: string) => {
    expect(btn).not.toBeNull();
    expect(btn!.childNodes.length, "the label is split into several flex items").toBe(1);
    expect(amounts(btn)).toEqual([label]);
  };

  it.each(CASES)("$name, with a rate: the body's amount and the button's are each in .sub-amount", async (c) => {
    await banner(c.s(), USD);
    const b = tierBanner();
    const body = b.querySelector(".member-sub-banner-body")!;
    expect(amounts(body)).toContain(c.body);
    buttonIsOneUnit(b.querySelector(".member-sub-banner-action"), `${c.name === "prepay" ? "Pay" : "Renew"} ${c.label}`);
    expect(outsideAmounts(b), "an amount sits outside the no-wrap span").not.toMatch(MONEY);
  });

  it.each(CASES)("$name, no rate: the sats are in .sub-amount", async (c) => {
    await banner(c.s(), null);
    const b = tierBanner();
    expect(amounts(b.querySelector(".member-sub-banner-body"))).toContain("42,000 sats");
    buttonIsOneUnit(b.querySelector(".member-sub-banner-action"), `${c.name === "prepay" ? "Pay" : "Renew"} 42,000 sats`);
    expect(outsideAmounts(b)).not.toMatch(MONEY);
  });

  it("the waiting strip's amount sent is in .sub-amount", async () => {
    stub.getPayFromNodePending.mockResolvedValue({ pending: {
      amount_sats: PRICE, txid: "ab".repeat(32), sent_at: Math.floor(NOW / 1000) - 720, origin: "manual",
      paid_through_at_write: NOW - 35 * DAY, count: 1,
    } });
    await banner(status("routing_lapsed"), USD);
    const b = tierBanner();
    expect(b.hasAttribute("data-pending-payment")).toBe(true);
    expect(amounts(b)).toEqual(["42,000 sats"]);
    expect(outsideAmounts(b)).not.toMatch(MONEY);
  });

  it("the words are unchanged: the banner's text still reads as before", async () => {
    await banner(status("routing_lapsed"), USD);
    expect(tierBanner().querySelector(".member-sub-banner-body")!.textContent).toContain(
      `Hosted services are paused: Auto${NBH}Buy, with its Valuation Chart, and Stablecoin settlements. Pay $25.20 (42,000 sats) to restore them.`,
    );
    expect(tierBanner().querySelector(".member-sub-banner-action")!.textContent).toBe("Renew $25.20");
  });
});
