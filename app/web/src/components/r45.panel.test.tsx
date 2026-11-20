// drive-mode R45 on the Settings subscription panel, rendered.
//   A2 (ruling 3) — dollars first, ONE price format on the panel.
//
// Slice 4 (member-first-run-ui, the simplified Membership panel, R1–R9): the
// amount rule — dollars with the sats under them for the big amount ("Renew
// for" / "Renews for" / "Activate for", slice 1's Amount at hero size), and
// "$X (N sats)" in a sentence (the restore ask, the button's line, the auto-pay
// line). The ruled design's "send exactly N sats" is the one sentence in sats
// alone: the QR / BIP-21 amount, which is exact. The rate's lines are placed
// once, by the big amount: "Price as of …" when stale, and slice 1's
// NoRateNote, never while the rate loads. The rate is undefined while it
// loads and null when the read failed; R8: one failed poll keeps the last good
// rate until it is genuinely stale (membership/heldRate.ts).
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
import { holdRate, HELD_RATE_FRESH_MS, HELD_RATE_NONE_AFTER_MS } from "./membership/heldRate";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const PRICE = 42_000;
const USD = 60_000; // 42,000 sats → $25.20

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };

type Tier = "prepay" | "current" | "worker_lapsed" | "routing_lapsed" | "close_due";
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
  vi.useRealTimers();
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
/** The big amount: its two lines (slice 1's Amount, hero). */
const big = () => {
  const a = host.querySelector(".membership-amount .amount-hero");
  return {
    usd: a?.querySelector('[data-line="usd"]')?.textContent ?? null,
    sats: a?.querySelector('[data-line="sats"]')?.textContent ?? null,
    label: host.querySelector(".membership-amount-label")?.textContent ?? null,
  };
};
const button = () => host.querySelector(".membership-button") as HTMLButtonElement | null;
const buttonLine = () => host.querySelector(".membership-button-line")?.textContent ?? null;
/** Every "42,000 sats" on the panel, outside the big amount's sats line and
 *  the ruled "Send exactly 42,000 sats" sentence, sits in "$X (42,000 sats)":
 *  the one price format (ruling 3). */
const bareSats = () => {
  const c = host.cloneNode(true) as HTMLElement;
  c.querySelectorAll(".amount-hero").forEach((e) => e.remove());
  const t = (c.textContent ?? "").replace(/\s+/g, " ").split("Send exactly 42,000 sats").join("");
  return t.split("42,000 sats").length - 1 - (t.split("(42,000 sats)").length - 1);
};

describe("R45 A2 / slice 4 — the panel's amounts, dollars first", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it.each(["worker_lapsed", "routing_lapsed", "close_due"] as const)("%s, fresh rate: the big amount, the ask, the button's line", async (tier) => {
    await show(status(tier));
    expect(big()).toEqual({ usd: "$25.20", sats: "42,000 sats", label: "Renew for" });
    expect(text()).toContain("Pay $25.20 (42,000 sats) to restore them.");
    expect(button()?.textContent).toBe("Renew from your node");
    expect(buttonLine()).toBe("Uses $25.20 (42,000 sats) of your node's bitcoin, plus a small network fee.");
    expect(bareSats()).toBe(0);
  });

  it("worker_lapsed (R8): dollars first like the rest — no sats-only helper", async () => {
    await show(status("worker_lapsed"));
    expect(text()).not.toContain("Send 42,000 sats to renew");
    expect(bareSats()).toBe(0);
  });

  it("current (paid up), fresh rate: 'Renews for', and the button's line", async () => {
    await show(CURRENT());
    expect(big()).toEqual({ usd: "$25.20", sats: "42,000 sats", label: "Renews for" });
    expect(buttonLine()).toBe("Uses $25.20 (42,000 sats) of your node's bitcoin, plus a small network fee.");
    expect(bareSats()).toBe(0);
  });

  it("prepay, fresh rate: 'Activate for', the lead's ask, 'Pay from your node'", async () => {
    await show(status("prepay"));
    expect(big()).toEqual({ usd: "$25.20", sats: "42,000 sats", label: "Activate for" });
    // Ruled 2026-11-20 ("recs", 2): the never-paid lead, verbatim.
    expect(text()).toContain("Your membership isn't active yet. Pay $25.20 (42,000 sats) to start it.");
    expect(text()).toContain("Send exactly 42,000 sats to activate.");
    expect(button()?.textContent).toBe("Pay from your node");
    expect(bareSats()).toBe(0);
  });

  it("'Other ways to pay': send exactly the sats, the QR / BIP-21 amount in sats", async () => {
    await show(status("routing_lapsed"));
    const row = host.querySelector('details[data-row="other-ways"]')!;
    expect(row.textContent).toContain("Send exactly 42,000 sats to renew for 30 days.");
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

  it("stale: dollars, and rate.ts's dated line exactly once, by the big amount", async () => {
    stub.getExchangeRate.mockResolvedValue(STALE);
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
    await show(status("routing_lapsed"));
    const line = rateNote(STALE as any, NOW)!;
    expect(line).toMatch(/^Price as of .+ on [A-Z][a-z]{2} \d{1,2}$/); // "10:42 AM on Nov 3" (Q8)
    expect(count(text(), line)).toBe(1);
    expect(count(text(), "Price as of")).toBe(1);
    expect(host.querySelector(".membership-amount")!.textContent).toContain(line);
    expect(big().usd).toBe("$25.20");
  });

  it.each([
    ["none", () => stub.getExchangeRate.mockResolvedValue(NONE)],
    ["a failed fetch", () => stub.getExchangeRate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }))],
  ])("%s: sats everywhere, no dollar sign, and NoRateNote exactly once, by the big amount", async (_name, arrange) => {
    arrange();
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
    await show(status("routing_lapsed"));
    expect(big()).toEqual({ usd: null, sats: "42,000 sats", label: "Renew for" });
    expect(text()).toContain("Pay 42,000 sats to restore them.");
    expect(buttonLine()).toBe("Uses 42,000 sats of your node's bitcoin, plus a small network fee.");
    expect(text()).not.toContain("$");
    expect(count(text(), RATE_NONE_SENTENCE)).toBe(1);
    expect(host.querySelectorAll(".amount-page-note").length).toBe(1);
    expect(host.querySelector(".membership-amount .amount-page-note")).not.toBeNull();
  });

  it("loading (the rate not back yet): sats, and no sentence of either kind", async () => {
    stub.getExchangeRate.mockReturnValue(new Promise(() => {}));
    await show(status("routing_lapsed"));
    expect(big()).toEqual({ usd: null, sats: "42,000 sats", label: "Renew for" });
    expect(text()).not.toContain("$");
    expect(text()).not.toContain(RATE_NONE_SENTENCE);
    expect(text()).not.toContain("Price as of");
  });

  it("unclassified: the price row, dollars first from auto-pay's price, and the sentence once on no rate", async () => {
    await show({ applicable: false, reason: "unclassified" });
    const row = () => host.querySelector('details[data-row="price"]')!;
    expect(row().textContent).toContain("Membership costs $25.20 (42,000 sats) a month.");
    stub.getExchangeRate.mockResolvedValue(NONE);
    await show({ applicable: false, reason: "unclassified" });
    expect(row().textContent).toContain("Membership costs 42,000 sats a month.");
    expect(count(text(), RATE_NONE_SENTENCE)).toBe(1);
  });
});

describe("R8 — one failed 15 s rate poll keeps the last good rate until it is genuinely stale", () => {
  it("holdRate: fresh is held fresh; past 10 min it is stale; past 6 h, or with nothing good, none", () => {
    expect(holdRate(undefined, NOW)).toBeNull();
    expect(holdRate(null, NOW)).toBeNull();
    expect(holdRate(NONE as any, NOW)).toBeNull();
    const at = NOW - 60_000;
    const good = { ...FRESH, fetched_at: at } as any;
    expect(holdRate(good, NOW)).toMatchObject({ usd: USD, state: "fresh" });
    expect(holdRate(good, at + HELD_RATE_FRESH_MS + 1)).toMatchObject({ usd: USD, state: "stale" });
    expect(holdRate(good, at + HELD_RATE_NONE_AFTER_MS)).toMatchObject({ usd: USD, state: "stale" });
    expect(holdRate(good, at + HELD_RATE_NONE_AFTER_MS + 1)).toBeNull();
  });

  it("rendered: good, then one failed poll — the dollars stay and no no-price line appears", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    stub.getExchangeRate.mockResolvedValueOnce(FRESH).mockRejectedValue(new Error("Failed to fetch"));
    await show(status("routing_lapsed"));
    expect(big().usd).toBe("$25.20");
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(stub.getExchangeRate.mock.calls.length, "the second poll ran (setup)").toBeGreaterThanOrEqual(2);
    expect(big().usd, "one failed poll dropped a good rate").toBe("$25.20");
    expect(text()).not.toContain(RATE_NONE_SENTENCE);
    expect(text()).not.toContain("Price as of");
  });

  it("rendered: the held rate ages — dated after 10 minutes, and the sentence after 6 hours", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    stub.getExchangeRate.mockResolvedValueOnce(FRESH).mockRejectedValue(new Error("Failed to fetch"));
    await show(status("routing_lapsed"));
    nowSpy.mockReturnValue(FRESH.fetched_at + HELD_RATE_FRESH_MS + 60_000);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(big().usd).toBe("$25.20");
    expect(count(text(), "Price as of")).toBe(1);
    nowSpy.mockReturnValue(FRESH.fetched_at + HELD_RATE_NONE_AFTER_MS + 60_000);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(big().usd).toBeNull();
    expect(count(text(), RATE_NONE_SENTENCE)).toBe(1);
  });
});
