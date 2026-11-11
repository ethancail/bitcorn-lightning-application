// drive-mode R45 copy, on the Settings subscription panel and the dashboard
// banner, rendered:
//   Q4 (ruling 4) — "Payment is detected within ~15 seconds" was false: the
//     treasury credits at the first confirmation (detector.ts:111, pinned by
//     detector.test.ts "R45 copy pin"). Every reachable tier now says "Your
//     payment counts after its first confirmation on the Bitcoin network,
//     usually within an hour."
//   Q5 (ruling 5) — the paused services by the names a member sees: "Hosted
//     services are paused: Auto-Buy, with its Valuation Chart, and Stablecoin
//     settlements." "Pay {price} to restore them." stays, dollars first.
//   Q6 (ruling 6) — member-facing "channel" → "connection", every reachable
//     state, the non-renewal ones included; the no-connection button matches
//     the dashboard's "Connect to Hub".
//   R49 (ruling 7) — worker_lapsed is unreachable since migration 071; its
//     copy is not edited, and it is excluded from the sweep below.
//
// ⚠ PRE-CHANGE RUN: red at 297429d.

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
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const PRICE = 42_000;
const USD = 60_000; // → $25.20

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };
const UNSIGNED = { treasury_signature: "unsigned", treasury_signature_reason: null, treasury_pay_refusal: null };
const CHANGED = {
  treasury_signature: "verified",
  treasury_signature_reason: null,
  treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: ADDR, stated_address: "bc1qother000000000000" },
};
const LABELS: Record<string, Record<string, unknown>> = { verified: VERIFIED, unsigned: UNSIGNED, "S6 address changed": CHANGED };

type Tier = "prepay" | "current" | "routing_lapsed" | "close_due";
const status = (tier: Tier, labels: Record<string, unknown> = VERIFIED, o: { paid_through?: number; worker_until?: number } = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: tier,
  paid_through: o.paid_through ?? NOW - 35 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: ADDR,
  last_payment_at: NOW - 65 * DAY,
  last_payment_txid: "f".repeat(64),
  grace: { fresh_until: 0, worker_until: o.worker_until ?? NOW - 5 * DAY, routing_until: NOW - 5 * DAY, close_at: NOW + 25 * DAY },
  ...labels,
});

/** Every member-reachable applicable render (ruling 7: no worker_lapsed). */
const REACHABLE: Array<{ name: string; s: (l: Record<string, unknown>) => any }> = [
  { name: "current (paid up)", s: (l) => status("current", l, { paid_through: NOW + 10 * DAY, worker_until: NOW + 40 * DAY }) },
  { name: "current (pre-pause, from P)", s: (l) => status("current", l, { paid_through: NOW - DAY, worker_until: NOW + 29 * DAY }) },
  { name: "prepay", s: (l) => status("prepay", l) },
  { name: "routing_lapsed", s: (l) => status("routing_lapsed", l) },
  { name: "close_due", s: (l) => status("close_due", l) },
];
const NOT_APPLICABLE = [
  { applicable: false, reason: "external_peer" },
  { applicable: false, reason: "unclassified" },
  { applicable: false, reason: "not_yet_allocated", channel_age_seconds: 12 },
  { applicable: false, reason: "missing" },
  { applicable: false, reason: "no_channel" },
];
const ERRORS: Array<{ name: string; arrange: () => void }> = [
  { name: "loading", arrange: () => stub.getSubscriptionStatus.mockReturnValue(new Promise(() => {})) },
  { name: "401", arrange: () => stub.getSubscriptionStatus.mockRejectedValue(Object.assign(new Error("x"), { status: 401 })) },
  { name: "treasury unreachable", arrange: () => stub.getSubscriptionStatus.mockRejectedValue(Object.assign(new Error("x"), { status: 503, code: "treasury_unreachable" })) },
  { name: "infrastructure", arrange: () => stub.getSubscriptionStatus.mockRejectedValue(Object.assign(new Error("x"), { status: 503, code: "no_local_token" })) },
  { name: "network", arrange: () => stub.getSubscriptionStatus.mockRejectedValue(new Error("Failed to fetch")) },
];

const ALERT_TYPES = [
  ["AUTOPAY_SETTLEMENT_OVERDUE", {}],
  ["AUTOPAY_PRICE_NOT_ACKNOWLEDGED", { reason: "never_acknowledged" }],
  ["AUTOPAY_PRICE_NOT_ACKNOWLEDGED", { reason: "price_increased" }],
  ["AUTOPAY_STATUS_UNVERIFIED", { verdict: "unsigned" }],
  ["AUTOPAY_PAY_TARGET_REFUSED", { code: "deposit_address_changed", pinned_address: ADDR, stated_address: "bc1qother" }],
  ["AUTOPAY_INSUFFICIENT_FUNDS", {}],
  ["AUTOPAY_LND_UNAVAILABLE", {}],
  ["AUTOPAY_PAYMENT_FAILED", {}],
  ["AUTOPAY_FEE_ESTIMATE_FAILED", {}],
  ["AUTOPAY_SUCCEEDED", {}],
] as const;

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
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue(autoPay());
  stub.getAutoPayHistory.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: USD, source: "coinbase", fetched_at: NOW - 60_000, age_ms: 60_000, state: "fresh" });
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
async function panel(s?: any) {
  if (s !== undefined) stub.getSubscriptionStatus.mockResolvedValue(s);
  await render(React.createElement(SubscriptionPanel));
}
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
/** What a member can read: the text, and the attributes a screen reader or
 *  hover shows. */
const memberText = () => {
  const attrs = [...host.querySelectorAll("*")]
    .flatMap((el) => ["title", "aria-label", "alt", "placeholder"].map((a) => el.getAttribute(a)))
    .filter(Boolean)
    .join(" ");
  return `${text()} ${attrs}`;
};

const RENEW_ROW =
  "If you renew — recovery is fully in-app. Your payment counts after its first confirmation on the Bitcoin network, " +
  "usually within an hour. Then all paused services come back online, and your paid-through date advances by 30 days.";
const SERVICES = "Hosted services are paused: Auto-Buy, with its Valuation Chart, and Stablecoin settlements.";

describe("R45 copy", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  describe("Q4 — when a payment counts", () => {
    it.each(["routing_lapsed", "close_due"] as const)("%s: the If-you-renew row says first confirmation, usually within an hour", async (tier) => {
      await panel(status(tier));
      expect(text()).toContain(RENEW_ROW);
    });

    it("no reachable tier claims ~15 seconds, verified or blocked", async () => {
      for (const r of REACHABLE) {
        for (const [name, labels] of Object.entries(LABELS)) {
          stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
          await panel(r.s(labels));
          expect(text(), `${r.name}, ${name}: panel`).not.toMatch(/15 seconds|15–30 seconds/);
          await render(React.createElement(MemberSubscriptionBanner, { status: r.s(labels), usdRate: USD }));
          expect(text(), `${r.name}, ${name}: banner`).not.toMatch(/15 seconds/);
        }
      }
    });
  });

  describe("Q5 — the paused services, by their names on a member's screens", () => {
    it.each(["routing_lapsed", "close_due"] as const)("%s panel alert: the services, then the dollar ask", async (tier) => {
      await panel(status(tier));
      expect(text()).toContain(
        "Your membership payment is overdue, so hosted services are paused: Auto-Buy, with its Valuation Chart, and Stablecoin settlements. " +
          "Pay $25.20 (42,000 sats) to restore them.",
      );
      expect(text()).not.toMatch(/valuation, Auto-Buy and stablecoin settlement data/);
    });

    it.each(["routing_lapsed", "close_due"] as const)("%s banner: the ruled sentence, then the dollar ask", (tier) => {
      const d = bannerFor(status(tier) as any, NOW, USD);
      expect(d.context).toBe(SERVICES);
      expect(d.body).toBe(`${SERVICES} Pay $25.20 (42,000 sats) to restore them.`);
    });
  });

  describe("Q6 — 'connection', not 'channel'", () => {
    it("current (paid up): the tagline", async () => {
      await panel(REACHABLE[0].s(VERIFIED));
      expect(text()).toContain("Your connection to Bitcorn and your hosted services are paid up.");
    });

    it.each(["routing_lapsed", "close_due"] as const)("%s: the reassure line", async (tier) => {
      await panel(status(tier));
      expect(text()).toContain("You can still use Coinbase Onramp to buy BTC and renew, and check your connection from this dashboard.");
    });

    it("unclassified, setting up, no connection: the non-renewal states", async () => {
      await panel({ applicable: false, reason: "unclassified" });
      expect(text()).toContain("Subscription doesn't activate until your connection is classified as farmer or merchant.");
      await panel({ applicable: false, reason: "not_yet_allocated", channel_age_seconds: 12 });
      expect(text()).toContain("connection detected 12s ago");
      await panel({ applicable: false, reason: "no_channel" });
      // Ethan, 2026-11-11 ("recs" 3 + NEW): on a member node the farmer IS the
      // operator (C6), so the body points to Bitcorn, and the button names it.
      expect(text()).toContain(
        "You don't have a connection to Bitcorn yet. Connect from your dashboard to enroll in the subscription system. " +
          "If you believe you should have a connection, contact Bitcorn.",
      );
      expect(memberText()).not.toMatch(/\boperator\b/i);
      const btn = [...host.querySelectorAll("a")].find((a) => (a.textContent ?? "").includes("Connect to"));
      expect(btn?.textContent?.replace(/\s+/g, " ").trim()).toBe("Connect to Bitcorn →");
      expect(btn?.getAttribute("href")).toBe("/dashboard");
      expect(memberText()).not.toMatch(/\bHub\b/);
    });

    // Ethan, 2026-11-11 ("recs" (2)): on a member node the farmer IS the
    // operator (C6), so the panel points to Bitcorn; the dead
    // mailto:operator@example.com button is removed.
    it("operator → Bitcorn: each ruled sentence, exactly", async () => {
      await panel({ applicable: false, reason: "external_peer" });
      expect(text()).toContain("If you believe this is incorrect, contact Bitcorn.");
      await panel({ applicable: false, reason: "unclassified" });
      expect(text()).toContain(
        "Subscription doesn't activate until your connection is classified as farmer or merchant. Contact Bitcorn if this lasts more than a few minutes.",
      );
      await panel({ applicable: false, reason: "missing" });
      expect(text()).toContain("Share this with Bitcorn if you contact support.");
      expect(text()).toContain("If this persists for more than a few minutes, contact Bitcorn with the pubkey above.");
    });

    it("unclassified: no 'Contact operator' button, no mailto, no empty ACTIONS section", async () => {
      await panel({ applicable: false, reason: "unclassified" });
      expect(text()).not.toMatch(/Contact operator/);
      expect(host.querySelector('a[href^="mailto:"]')).toBeNull();
      expect(text()).not.toContain("[ ACTIONS ]");
      expect(host.querySelector(".sub-actions")).toBeNull();
    });

    it("SWEEP: no member text on the panel, in any reachable state, says 'operator'", async () => {
      const states: Array<[string, () => void]> = [
        ...REACHABLE.map((r) => [r.name, () => stub.getSubscriptionStatus.mockResolvedValue(r.s(VERIFIED))] as [string, () => void]),
        ...NOT_APPLICABLE.map((s) => [s.reason, () => stub.getSubscriptionStatus.mockResolvedValue(s)] as [string, () => void]),
        ...ERRORS.map((e) => [e.name, e.arrange] as [string, () => void]),
      ];
      for (const [name, arrange] of states) {
        arrange();
        await panel();
        const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").join(" ");
        expect(`${memberText()} ${hrefs}`, name).not.toMatch(/\boperator\b/i);
      }
      expect(states.length).toBe(REACHABLE.length + NOT_APPLICABLE.length + ERRORS.length);
    });

    it("SWEEP: no member text on the panel, in any reachable state, says 'channel'", async () => {
      const seen: string[] = [];
      for (const r of REACHABLE) {
        for (const [name, labels] of Object.entries(LABELS)) {
          for (const enabled of [true, false]) {
            stub.getAutoPayConfig.mockResolvedValue(autoPay(enabled ? { enabled: true, enabled_at: 1 } : {}));
            await panel(r.s(labels));
            const where = `${r.name}, ${name}, auto-pay ${enabled ? "on" : "off"}`;
            seen.push(where);
            expect(memberText(), where).not.toMatch(/\bchannel\b/i);
          }
        }
      }
      for (const s of NOT_APPLICABLE) {
        await panel(s);
        seen.push(s.reason);
        expect(memberText(), s.reason).not.toMatch(/\bchannel\b/i);
      }
      for (const e of ERRORS) {
        e.arrange();
        await panel();
        seen.push(e.name);
        expect(memberText(), e.name).not.toMatch(/\bchannel\b/i);
      }
      expect(seen.length).toBe(REACHABLE.length * 3 * 2 + NOT_APPLICABLE.length + ERRORS.length);
    });

    it("SWEEP: no member text on the banner, in any reachable tier, with every auto-pay alert, says 'channel'", async () => {
      stub.getAutoPayConfig.mockResolvedValue(autoPay({
        enabled: true, enabled_at: 1, price_change_pending: true, last_acknowledged_price: 40_000,
        active_alerts: ALERT_TYPES.map(([type, context], i) => ({
          id: i + 1, member_pubkey: "02" + "c".repeat(64), type, severity: type === "AUTOPAY_SUCCEEDED" ? "info" : "warning",
          status: "active", consecutive_count: 1, context, created_at: 1, updated_at: 1,
        })),
      }));
      for (const r of REACHABLE) {
        for (const [name, labels] of Object.entries(LABELS)) {
          for (const usdRate of [USD, null]) {
            await render(React.createElement(MemberSubscriptionBanner, { status: r.s(labels), usdRate }));
            const where = `${r.name}, ${name}, rate ${usdRate ?? "none"}`;
            expect(host.querySelectorAll(".member-sub-banner").length, `${where}: the alerts render`).toBeGreaterThan(ALERT_TYPES.length);
            expect(memberText(), where).not.toMatch(/\bchannel\b/i);
          }
        }
      }
    });
  });
});
