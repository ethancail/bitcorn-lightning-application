// drive-mode R45 on the Settings subscription panel, rendered.
//   A2 (ruling 3) — dollars first: MONTHLY, the overdue alert's "Pay $X (N
//     sats) to restore them.", every helper, "I have BTC — renew ($X)", and
//     the auto-pay "your node pays …" line, so the panel shows ONE price
//     format. The deposit helper keeps the sats beside the dollars, and the
//     QR / BIP-21 amount stays sats. The rate's sentence renders once per
//     panel, never while loading, in rate.ts's format; a failed rate fetch
//     counts as no rate.
//
// ⚠ PRE-CHANGE RUN: red at 297429d — the panel fetched no rate and showed
// sats only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const qr = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock("qrcode", () => ({ default: qr }));

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
import { RATE_NONE_SENTENCE, rateNote } from "../api/rate";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const PRICE = 42_000;
const USD = 60_000; // 42,000 sats → $25.20

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };

type Tier = "prepay" | "current" | "routing_lapsed" | "close_due";
const status = (tier: Tier, o: { paid_through?: number; worker_until?: number } = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: tier,
  paid_through: o.paid_through ?? NOW - 35 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: ADDR,
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: o.worker_until ?? NOW - 5 * DAY, routing_until: NOW - 5 * DAY, close_at: NOW + 25 * DAY },
  ...VERIFIED,
});
const CURRENT = () => status("current", { paid_through: NOW + 10 * DAY, worker_until: NOW + 40 * DAY });

const FRESH = { usd: USD, source: "coinbase", fetched_at: NOW - 60_000, age_ms: 60_000, state: "fresh" };
const STALE = { usd: USD, source: "coinbase", fetched_at: NOW - DAY, age_ms: DAY, state: "stale" };
const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };

const autoPay = (o: Record<string, unknown> = {}) => ({
  enabled: false, enabled_at: null, last_acknowledged_price: null, last_acknowledged_price_at: null,
  current_price: PRICE, price_change_pending: false, status_verification: "verified",
  status_verification_reason: null, price_refusal: null, active_alerts: [],
  badge: { active_count: 0, highest_severity: null },
  ...o,
});

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  qr.toDataURL.mockResolvedValue("data:image/png;base64,AA==");
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue(autoPay());
  stub.getAutoPayHistory.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue(FRESH);
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
async function show(s: any) {
  stub.getSubscriptionStatus.mockResolvedValue(s);
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel))); });
  await flush();
}
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const monthly = () => {
  const cell = [...host.querySelectorAll(".sub-stat")].find((c) => c.querySelector(".sub-stat-label")?.textContent === "MONTHLY");
  return {
    value: cell?.querySelector(".sub-stat-value")?.textContent,
    suffix: cell?.querySelector(".sub-stat-suffix")?.textContent,
  };
};
const iHaveBtc = () =>
  [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("I have BTC"))?.textContent?.trim();
/** Every "42,000 sats" on the panel outside the MONTHLY suffix sits in
 *  "$X (42,000 sats)": the one price format (ruling 3). */
const bareSats = () => {
  const t = text();
  const m = monthly();
  const withoutMonthly = m.suffix ? t.replace(`MONTHLY${m.value}${m.suffix}`, "MONTHLY") : t;
  return withoutMonthly.split("42,000 sats").length - 1 - (withoutMonthly.split("(42,000 sats)").length - 1);
};

describe("R45 A2 — the panel's amounts, dollars first", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it.each(["routing_lapsed", "close_due"] as const)("%s, fresh rate: MONTHLY, the alert, the helper and the button", async (tier) => {
    await show(status(tier));
    expect(monthly()).toEqual({ value: "$25.20", suffix: "42,000 sats" });
    expect(text()).toContain("Pay $25.20 (42,000 sats) to restore them.");
    expect(text()).toContain("Send $25.20 (42,000 sats) to renew for 30 days.");
    expect(iHaveBtc()).toBe("I have BTC — renew ($25.20)");
    expect(bareSats()).toBe(0);
  });

  it("current, fresh rate: MONTHLY and the helper", async () => {
    await show(CURRENT());
    expect(monthly()).toEqual({ value: "$25.20", suffix: "42,000 sats" });
    expect(text()).toContain("Send $25.20 (42,000 sats) to renew for one month.");
    expect(bareSats()).toBe(0);
  });

  it("prepay, fresh rate: MONTHLY, the tagline, the helper and the button", async () => {
    await show(status("prepay"));
    expect(monthly()).toEqual({ value: "$25.20", suffix: "42,000 sats" });
    expect(text()).toContain("Send $25.20 (42,000 sats) to activate full membership.");
    expect(text()).toContain("Send $25.20 (42,000 sats) to activate.");
    expect(iHaveBtc()).toBe("I have BTC — pay $25.20");
    expect(bareSats()).toBe(0);
  });

  it("the QR / BIP-21 amount stays in sats with a rate", async () => {
    await show(status("routing_lapsed"));
    const uris = qr.toDataURL.mock.calls.map((c) => String(c[0]));
    expect(uris).toContain(`BITCOIN:${ADDR.toUpperCase()}?AMOUNT=0.00042000`);
  });

  it("the auto-pay line, both variants, dollars first (one price format)", async () => {
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
    await show(status("routing_lapsed"));
    expect(text()).toContain("so your node will pay $25.20 (42,000 sats) from its Bitcoin balance");
    expect(bareSats()).toBe(0);
    await show(CURRENT());
    expect(text()).toContain("your node pays $25.20 (42,000 sats) from its Bitcoin balance");
    expect(bareSats()).toBe(0);
  });

  it("fresh: no rate sentence at all", async () => {
    await show(status("routing_lapsed"));
    expect(text()).not.toContain("Price as of");
    expect(text()).not.toContain(RATE_NONE_SENTENCE);
  });

  it("stale: dollars, and rate.ts's dated line exactly once — auto-pay on, so two cards", async () => {
    stub.getExchangeRate.mockResolvedValue(STALE);
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
    await show(status("routing_lapsed"));
    const line = rateNote(STALE as any, NOW)!;
    expect(line).toMatch(/^Price as of .+ on [A-Z][a-z]{2} \d{1,2}$/); // "10:42 AM on Nov 3" (Q8)
    expect(count(text(), line)).toBe(1);
    expect(count(text(), "Price as of")).toBe(1);
    expect(monthly().value).toBe("$25.20");
  });

  it.each([
    ["none", () => stub.getExchangeRate.mockResolvedValue(NONE)],
    ["a failed fetch", () => stub.getExchangeRate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }))],
  ])("%s: sats everywhere, no dollar sign, and the no-rate sentence exactly once", async (_name, arrange) => {
    arrange();
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
    await show(status("routing_lapsed"));
    expect(monthly()).toEqual({ value: "42,000", suffix: "sats" });
    expect(text()).toContain("Pay 42,000 sats to restore them.");
    expect(iHaveBtc()).toBe("I have BTC — renew (42,000 sats)");
    expect(text()).not.toContain("$");
    expect(count(text(), RATE_NONE_SENTENCE)).toBe(1);
  });

  it("loading (the rate not back yet): sats, and no sentence of either kind", async () => {
    stub.getExchangeRate.mockReturnValue(new Promise(() => {}));
    await show(status("routing_lapsed"));
    expect(monthly()).toEqual({ value: "42,000", suffix: "sats" });
    expect(text()).not.toContain("$");
    expect(text()).not.toContain(RATE_NONE_SENTENCE);
    expect(text()).not.toContain("Price as of");
  });

  it("unclassified: MONTHLY dollars first from auto-pay's price, and the sentence once on no rate", async () => {
    await show({ applicable: false, reason: "unclassified" });
    expect(monthly()).toEqual({ value: "$25.20", suffix: "42,000 sats" });
    stub.getExchangeRate.mockResolvedValue(NONE);
    await show({ applicable: false, reason: "unclassified" });
    expect(monthly()).toEqual({ value: "42,000", suffix: "sats" });
    expect(count(text(), RATE_NONE_SENTENCE)).toBe(1);
  });
});
