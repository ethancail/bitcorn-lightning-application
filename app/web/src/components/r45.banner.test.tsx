// drive-mode R45 on the dashboard banner (MemberSubscriptionBanner), rendered:
//   A1 (ruling 2) — the Renew/Pay button reads dollars with a rate, sats with
//     none; and under payBlocked it stays disabled and the payment sentence
//     stays hidden with the new dollar labels too (ruling 8: already built by
//     treasury-price-trust; verified and tested here, not rebuilt).
//
// ⚠ PRE-CHANGE RUN: red at 297429d — the button read "Renew 42,000 sats" with
// a rate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getAutoPayConfig: vi.fn(),
  getExchangeRate: vi.fn(),
  getPayFromNodeQuote: vi.fn(),
  getPayFromNodePending: vi.fn(),
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import MemberSubscriptionBanner from "./MemberSubscriptionBanner";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const PRICE = 42_000;
const RATE = 60_000; // 42,000 sats → $25.20

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };
const UNSIGNED = { treasury_signature: "unsigned", treasury_signature_reason: null, treasury_pay_refusal: null };
const CHANGED = {
  treasury_signature: "verified",
  treasury_signature_reason: null,
  treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: ADDR, stated_address: "bc1qother" },
};
const ABSENT = {};
const BLOCKED: Record<string, Record<string, unknown>> = { unsigned: UNSIGNED, "S6 address changed": CHANGED, "labels absent": ABSENT };

type Tier = "prepay" | "current" | "routing_lapsed" | "close_due";
export const r45Status = (tier: Tier, labels: Record<string, unknown>, o: { paid_through?: number; worker_until?: number } = {}) => ({
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
  ...labels,
});

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getAutoPayConfig.mockResolvedValue({
    enabled: false, enabled_at: null, last_acknowledged_price: null, last_acknowledged_price_at: null,
    current_price: PRICE, price_change_pending: false, status_verification: "verified",
    status_verification_reason: null, price_refusal: null, active_alerts: [],
    badge: { active_count: 0, highest_severity: null },
  });
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
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
async function show(s: any, usdRate: number | null) {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(MemberSubscriptionBanner, { status: s, usdRate })));
  });
  await flush();
}
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const action = () => host.querySelector(".member-sub-banner-action") as HTMLButtonElement | null;

const TIERS: Array<{ tier: Tier; o?: { paid_through?: number; worker_until?: number }; dollars: string; sats: string; ask: RegExp }> = [
  { tier: "prepay", dollars: "Pay $25.20", sats: "Pay 42,000 sats", ask: /Pay \$25\.20 \(42,000 sats\) to unlock/ },
  { tier: "current", o: { paid_through: NOW - DAY, worker_until: NOW + 29 * DAY }, dollars: "Renew $25.20", sats: "Renew 42,000 sats",
    ask: /Renew for \$25\.20 \(42,000 sats\) before then/ },
  { tier: "routing_lapsed", dollars: "Renew $25.20", sats: "Renew 42,000 sats", ask: /Pay \$25\.20 \(42,000 sats\) to restore them/ },
  { tier: "close_due", dollars: "Renew $25.20", sats: "Renew 42,000 sats", ask: /Pay \$25\.20 \(42,000 sats\) to restore them/ },
];

describe("R45 A1 — the banner's button, rendered", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it.each(TIERS)("$tier: dollars with a rate, sats with none; enabled when verified", async (t) => {
    await show(r45Status(t.tier, VERIFIED, t.o), RATE);
    expect(action()?.textContent).toBe(t.dollars);
    expect(action()?.disabled).toBe(false);
    expect(text()).toMatch(t.ask);

    await show(r45Status(t.tier, VERIFIED, t.o), null);
    expect(action()?.textContent).toBe(t.sats);
    expect(text()).not.toContain("$");
  });

  it.each(TIERS)("$tier, with a rate: blocked → the button is disabled and the payment sentence hidden (ruling 8)", async (t) => {
    for (const [name, labels] of Object.entries(BLOCKED)) {
      await show(r45Status(t.tier, labels, t.o), RATE);
      expect(action(), `${name}: the tier banner renders`).not.toBeNull();
      expect(action()!.disabled, `${name}: the Renew/Pay button offered a payment the node won't make`).toBe(true);
      expect(text(), `${name}: the banner asked for payment`).not.toMatch(t.ask);
    }
  });
});
