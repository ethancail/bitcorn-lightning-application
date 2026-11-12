// drive-mode R45, ruling 1: "payment sent, waiting for confirmation", rendered.
//   Panel — a notice above ACTIONS in every reachable applicable tier; the
//     buttons stay (the pay modal's repeat step already guards a second send).
//   Banner — on a tier that shows a banner, an info strip with NO pay button
//     (Q1), and the "View subscription →" link.
//   Both hide it once a VERIFIED status shows the credit (pendingPaymentView),
//   never on an unverified one. A txid-less marker says "may have sent" (Q2);
//   the amount sent is in sats only (Q9).
//
// ⚠ PRE-CHANGE RUN: red at 297429d — nothing read the marker.

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

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const PRICE = 42_000;
const TXID = "ab".repeat(32);
const PT = NOW - 35 * DAY; // paid_through of the lapsed fixtures

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };
const UNSIGNED = { treasury_signature: "unsigned", treasury_signature_reason: null, treasury_pay_refusal: null };

type Tier = "prepay" | "current" | "routing_lapsed" | "close_due";
const status = (tier: Tier, labels: Record<string, unknown> = VERIFIED, o: Record<string, unknown> = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: tier,
  paid_through: PT,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: ADDR,
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: NOW - 5 * DAY, routing_until: NOW - 5 * DAY, close_at: NOW + 25 * DAY },
  ...labels,
  ...o,
});
const PRE_PAUSE = (labels: Record<string, unknown> = VERIFIED) =>
  status("current", labels, { paid_through: NOW - DAY, grace: { fresh_until: 0, worker_until: NOW + 29 * DAY, routing_until: NOW + 29 * DAY, close_at: NOW + 59 * DAY } });
const PAID_UP = () =>
  status("current", VERIFIED, { paid_through: NOW + 10 * DAY, grace: { fresh_until: 0, worker_until: NOW + 40 * DAY, routing_until: NOW + 40 * DAY, close_at: NOW + 70 * DAY } });

const marker = (o: Record<string, unknown> = {}) => ({
  pending: {
    amount_sats: PRICE,
    txid: TXID,
    sent_at: Math.floor(NOW / 1000) - 12 * 60, // 12 minutes ago
    origin: "manual",
    paid_through_at_write: PT,
    count: 1,
    ...o,
  },
});

const SENT_HEAD = "Payment sent, waiting for confirmation";
const SENT_BODY = "Your node sent 42,000 sats 12 minutes ago. It counts after its first confirmation, usually within an hour.";
const MAYBE_HEAD = "Payment may have been sent";
const MAYBE_BODY = "Your node may have sent 42,000 sats 12 minutes ago. If it did, it counts once it's confirmed.";

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
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: NOW - 60_000, age_ms: 60_000, state: "fresh" });
  stub.getPayFromNodePending.mockResolvedValue(marker());
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
const panel = async (s: any) => {
  stub.getSubscriptionStatus.mockResolvedValue(s);
  await render(React.createElement(SubscriptionPanel));
};
const banner = (s: any) => render(React.createElement(MemberSubscriptionBanner, { status: s, usdRate: 60_000 }));
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const notice = () => host.querySelector("[data-pending-payment]") as HTMLElement | null;
const tierBannerAction = () => host.querySelector(".member-sub-banner .member-sub-banner-action") as HTMLButtonElement | null;

describe("R45 waiting state — the Settings panel", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  const TIERS: Array<[string, () => any]> = [
    ["routing_lapsed", () => status("routing_lapsed")],
    ["close_due", () => status("close_due")],
    ["prepay", () => status("prepay")],
    ["current (pre-pause)", () => PRE_PAUSE()],
    ["current (paid up)", () => PAID_UP()],
  ];

  it.each(TIERS)("%s: the notice, above ACTIONS, and the buttons stay", async (_n, s) => {
    // The marker records the paid_through it was written at: this status's.
    stub.getPayFromNodePending.mockResolvedValue(marker({ paid_through_at_write: s().paid_through }));
    await panel(s());
    const n = notice();
    expect(n, "the notice renders").not.toBeNull();
    expect(n!.textContent?.replace(/\s+/g, " ")).toContain(SENT_HEAD);
    expect(n!.textContent?.replace(/\s+/g, " ")).toContain(SENT_BODY);
    // Placed directly above the ACTIONS heading.
    const actionsHeading = [...host.querySelectorAll(".sub-bracket-heading")].find((h) => h.textContent?.includes("ACTIONS"))!;
    expect(n!.nextElementSibling).toBe(actionsHeading);
    // The buttons stay: the pay button is still there and enabled.
    const pay = [...host.querySelectorAll("button")].find((b) => /^(I have BTC|Renew now)/.test(b.textContent ?? ""));
    expect(pay, "a pay button renders").toBeDefined();
    expect(pay!.disabled).toBe(false);
  });

  it("a txid-less marker says 'may have sent', never 'sent'", async () => {
    stub.getPayFromNodePending.mockResolvedValue(marker({ txid: null }));
    await panel(status("routing_lapsed"));
    expect(notice()?.textContent?.replace(/\s+/g, " ")).toContain(`${MAYBE_HEAD}${MAYBE_BODY}`);
    expect(text()).not.toContain(SENT_HEAD);
  });

  it("no marker → no notice", async () => {
    stub.getPayFromNodePending.mockResolvedValue({ pending: null });
    await panel(status("routing_lapsed"));
    expect(notice()).toBeNull();
  });

  it("a verified status showing the credit hides it — by txid, and by a later paid_through", async () => {
    await panel(status("current", VERIFIED, { last_payment_txid: TXID, paid_through: NOW + 29 * DAY }));
    expect(notice()).toBeNull();
    await panel(status("routing_lapsed", VERIFIED, { paid_through: PT + 1 }));
    expect(notice()).toBeNull();
  });

  it("an unsigned status claiming the credit does NOT hide it", async () => {
    await panel(status("current", UNSIGNED, { last_payment_txid: TXID, paid_through: NOW + 29 * DAY }));
    expect(notice()).not.toBeNull();
  });

  it("the route failing shows nothing and breaks nothing", async () => {
    stub.getPayFromNodePending.mockRejectedValue(new Error("Failed to fetch"));
    await panel(status("routing_lapsed"));
    expect(notice()).toBeNull();
    expect(text()).toContain("Your membership payment is overdue");
  });

  it("the waiting copy has no dollars, no 'channel', no '15 seconds'", async () => {
    for (const m of [marker(), marker({ txid: null })]) {
      stub.getPayFromNodePending.mockResolvedValue(m);
      await panel(status("routing_lapsed"));
      const t = notice()!.textContent ?? "";
      expect(t).not.toContain("$");
      expect(t).not.toMatch(/\bchannel\b/i);
      expect(t).not.toMatch(/15 seconds/);
    }
  });

  it("not-applicable states never ask for the marker", async () => {
    await panel({ applicable: false, reason: "no_channel" });
    expect(stub.getPayFromNodePending).not.toHaveBeenCalled();
  });
});

describe("R45 waiting state — the dashboard banner", () => {
  const TIERS: Array<[string, () => any]> = [
    ["routing_lapsed", () => status("routing_lapsed")],
    ["close_due", () => status("close_due")],
    ["prepay", () => status("prepay")],
    ["current (pre-pause)", () => PRE_PAUSE()],
  ];

  it.each(TIERS)("%s: an info strip, the link, and NO pay button", async (_n, s) => {
    stub.getPayFromNodePending.mockResolvedValue(marker({ paid_through_at_write: s().paid_through }));
    await banner(s());
    const strip = host.querySelector(".member-sub-banner") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.className).toContain("info");
    expect(strip.querySelector(".member-sub-banner-headline")?.textContent).toBe(SENT_HEAD);
    expect(strip.textContent?.replace(/\s+/g, " ")).toContain(SENT_BODY);
    expect(strip.querySelector("a")?.getAttribute("href")).toBe("/settings");
    expect(tierBannerAction(), "the strip offers no payment").toBeNull();
    expect(strip.querySelector("button")).toBeNull();
    expect(text()).not.toMatch(/Renew \$|Pay \$/);
  });

  it("txid-less: 'may have sent'", async () => {
    stub.getPayFromNodePending.mockResolvedValue(marker({ txid: null }));
    await banner(status("routing_lapsed"));
    expect(host.querySelector(".member-sub-banner-headline")?.textContent).toBe(MAYBE_HEAD);
    expect(text()).toContain(MAYBE_BODY);
  });

  it("credited under a verified status → the tier banner, with its button, again", async () => {
    await banner(status("routing_lapsed", VERIFIED, { paid_through: PT + 1 }));
    expect(text()).not.toContain(SENT_HEAD);
    expect(tierBannerAction()?.textContent).toBe("Renew $25.20");
  });

  it("an unsigned status claiming the credit keeps the strip", async () => {
    await banner(status("routing_lapsed", UNSIGNED, { paid_through: PT + 1, last_payment_txid: TXID }));
    expect(text()).toContain(SENT_HEAD);
    expect(tierBannerAction()).toBeNull();
  });

  it("no marker → the tier banner as before", async () => {
    stub.getPayFromNodePending.mockResolvedValue({ pending: null });
    await banner(status("routing_lapsed"));
    expect(tierBannerAction()?.textContent).toBe("Renew $25.20");
  });

  it("a healthy member's dashboard stays silent and asks for nothing", async () => {
    await banner(PAID_UP());
    expect(host.querySelector(".member-sub-banner")).toBeNull();
    expect(stub.getPayFromNodePending).not.toHaveBeenCalled();
  });
});
