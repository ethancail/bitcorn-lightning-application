// G3 findings 1–3 (treasury-price-trust; ruled by Ethan 2026-11-11): while
// payBlocked(status) holds (paymentTrust.ts), no surface asks for a payment
// the node won't make. Hidden, with no new copy:
//   1. the routing-denied notice's "Renew {price} to restore access." line;
//   2. the dashboard tier banner's sentence asking for payment (every tier),
//      and its Renew/Pay button is disabled; the headline and the S-state
//      alert banners stay;
//   3. the auto-pay section's "your node pays … from its Bitcoin balance" line.
//
// Each test asserts the element ABSENT under blocked statuses — unsigned (the
// signature half of payBlocked) and verified-but-refused (the refusal half) —
// and, in the same test, PRESENT under a verified, unrefused status (the
// anti-vacuity half: a surface that never rendered it would otherwise pass).

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
  payFromNode: vi.fn(),
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RoutingDeniedNotice from "./RoutingDeniedNotice";
import MemberSubscriptionBanner from "./MemberSubscriptionBanner";
import SubscriptionPanel from "./SubscriptionPanel";
import { trustCopy, trustStateOfStatus } from "./paymentTrust";
import { renewalAmount } from "./subscriptionBanner";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const NEW_ADDR = "bc1qtreasurystatedaddress0000000000000yy";
const PRICE = 42_000;

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };
const UNSIGNED = { treasury_signature: "unsigned", treasury_signature_reason: null, treasury_pay_refusal: null };
const CHANGED = {
  treasury_signature: "verified",
  treasury_signature_reason: null,
  treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: ADDR, stated_address: NEW_ADDR },
};
const BLOCKED = { unsigned: UNSIGNED, "verified, address changed": CHANGED };

type Tier = "prepay" | "current" | "worker_lapsed" | "routing_lapsed" | "close_due";
const status = (tier: Tier, labels: Record<string, unknown>, o: { paid_through?: number; worker_until?: number } = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: tier,
  paid_through: o.paid_through ?? NOW - 10 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: labels === CHANGED ? NEW_ADDR : ADDR,
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: o.worker_until ?? NOW - 3 * DAY, routing_until: NOW + 20 * DAY, close_at: NOW + 50 * DAY },
  ...labels,
});

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
  stub.getExchangeRate.mockResolvedValue({ usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" });
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
async function show(el: React.ReactElement) {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, el)); });
  await flush();
}
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

describe("G3 finding 1 — the routing-denied notice asks for no payment while blocked", () => {
  it("the \"Renew {price} to restore access.\" line is absent when blocked, present when verified", async () => {
    const payload = { tier: "routing_lapsed", paid_through: NOW - 10 * DAY, deposit_address: ADDR, price_sats: PRICE };
    const notice = () => React.createElement(RoutingDeniedNotice, { payload, blockedAction: "receive" });
    const ASK = "Renew 42,000 sats to restore access.";

    for (const [name, labels] of Object.entries(BLOCKED)) {
      stub.getSubscriptionStatus.mockResolvedValue(status("routing_lapsed", labels));
      await show(notice());
      expect(text(), `${name}: the notice asked for payment`).not.toContain(ASK);
      expect(text(), `${name}: the standing line stays`).toContain("Services paused since");
      expect(host.querySelector("[data-trust-state]"), `${name}: the S-state shows`).not.toBeNull();
    }

    // Anti-vacuity: verified and unrefused, the line renders.
    stub.getSubscriptionStatus.mockResolvedValue(status("routing_lapsed", VERIFIED));
    await show(notice());
    expect(text()).toContain(ASK);
    expect(host.querySelector("[data-trust-state]")).toBeNull();
  });
});

describe("G3 finding 2 — the dashboard tier banner asks for no payment while blocked", () => {
  // Every tier that renders a banner, with its body's sentence asking for payment.
  const TIERS: Array<{ name: string; s: (l: Record<string, unknown>) => any; ask: string; context: string | null; headline: string }> = [
    { name: "pre-pause (current, from P)", s: (l) => status("current", l, { paid_through: NOW - DAY, worker_until: NOW + 9 * DAY }),
      ask: "Renew for 42,000 sats before then to keep them running.", context: null, headline: "Hosted services pause on" },
    { name: "prepay", s: (l) => status("prepay", l), ask: "Pay 42,000 sats to unlock Lightning routing.", context: null,
      headline: "Welcome to BitCorn — activate your membership" },
    { name: "worker_lapsed", s: (l) => status("worker_lapsed", l), ask: "Renew for 42,000 sats to restore.",
      context: "Hosted services are paused; your channel and routing still work.", headline: "Action needed: hosted services lapsed" },
    { name: "routing_lapsed", s: (l) => status("routing_lapsed", l), ask: "Pay 42,000 sats to restore them.",
      context: "Hosted services are paused: Auto-Buy, with its Valuation Chart, and Stablecoin settlements.", headline: "Your membership payment is overdue" },
    { name: "close_due", s: (l) => status("close_due", l), ask: "Pay 42,000 sats to restore them.",
      context: "Hosted services are paused: Auto-Buy, with its Valuation Chart, and Stablecoin settlements.", headline: "Your membership payment is overdue" },
  ];
  const banner = (s: any) => React.createElement(MemberSubscriptionBanner, { status: s, usdRate: null });
  const action = () => host.querySelector(".member-sub-banner-action") as HTMLButtonElement | null;
  const tierBanner = () => host.querySelector(".member-sub-banner") as HTMLElement | null;

  it("its pay sentence is absent and its button disabled when blocked, every tier; both present and enabled when verified", async () => {
    // An S-state alert banner, active: it must stay while the tier banner is quieted.
    stub.getAutoPayConfig.mockResolvedValue(autoPay({
      active_alerts: [{ id: 4, member_pubkey: "02" + "c".repeat(64), type: "AUTOPAY_STATUS_UNVERIFIED", severity: "warning",
        status: "active", consecutive_count: 1, context: { verdict: "unsigned" }, created_at: 1, updated_at: 1 }],
    }));
    for (const t of TIERS) {
      for (const [name, labels] of Object.entries(BLOCKED)) {
        await show(banner(t.s(labels)));
        const where = `${t.name}, ${name}`;
        expect(tierBanner(), `${where}: the tier banner renders`).not.toBeNull();
        expect(tierBanner()!.textContent, `${where}: the headline stays`).toContain(t.headline);
        expect(text(), `${where}: the banner asked for payment`).not.toContain(t.ask);
        if (t.context) expect(text(), `${where}: the rest of the body stays`).toContain(t.context);
        expect(action()?.disabled, `${where}: the Renew/Pay button is enabled`).toBe(true);
        expect(text(), `${where}: the S-state alert banner stays`).toContain("Payments are paused.");
      }
      // Anti-vacuity: verified and unrefused, the sentence renders and the button works.
      await show(banner(t.s(VERIFIED)));
      expect(text(), `${t.name}, verified`).toContain(t.ask);
      expect(action()?.disabled, `${t.name}, verified: the button is disabled`).toBe(false);
    }
  });
});

describe("G3 finding 3 — the auto-pay section says nothing about paying while blocked", () => {
  const PAYS = /your node (pays|will pay) .* from its Bitcoin balance/;

  it("the \"your node pays … from its Bitcoin balance\" line is absent when blocked, present when verified", async () => {
    // Both variants of the line: lapsed (past the pause) and not yet lapsed.
    const variants = [
      { name: "lapsed", s: (l: Record<string, unknown>) => status("worker_lapsed", l) },
      { name: "not lapsed", s: (l: Record<string, unknown>) => status("current", l, { paid_through: NOW + 5 * DAY, worker_until: NOW + 35 * DAY }) },
    ];
    for (const v of variants) {
      for (const [name, labels] of Object.entries(BLOCKED)) {
        stub.getSubscriptionStatus.mockResolvedValue(v.s(labels));
        stub.getAutoPayConfig.mockResolvedValue(autoPay({
          enabled: true, enabled_at: 1,
          // As the API reports each: unsigned → no payable price; an address
          // change → still verified with its price.
          ...(labels === UNSIGNED ? { status_verification: "unsigned", current_price: null } : {}),
        }));
        await show(React.createElement(SubscriptionPanel));
        const where = `${v.name}, ${name}`;
        expect(text(), `${where}: auto-pay is on, so its block renders`).toContain("Requires sufficient on-chain BTC");
        expect(text(), `${where}: the section said the node pays`).not.toMatch(PAYS);
      }
      // Anti-vacuity: verified and unrefused, the line renders.
      stub.getSubscriptionStatus.mockResolvedValue(v.s(VERIFIED));
      stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
      await show(React.createElement(SubscriptionPanel));
      expect(text(), `${v.name}, verified`).toMatch(PAYS);
      expect(text()).toContain("42,000 sats from its Bitcoin balance");
    }
  });
});

// Before-merge fixes from drive-mode's G3 judgement, accepted by Ethan
// 2026-11-11: one S-state per panel screen, and "Renew now" gated.
describe("one S-state per panel screen", () => {
  // drive-mode's wording, verbatim.
  const DEPOSIT_HIDDEN = "Payment address hidden while payments are paused (see above).";
  const AUTOPAY_PAUSED = "Auto-pay is paused (see above).";
  const STATES: Record<string, Record<string, unknown>> = {
    S1: UNSIGNED,
    S2: { treasury_signature: "invalid", treasury_signature_reason: null, treasury_pay_refusal: null },
    "S3 key_unset": { treasury_signature: "unverifiable", treasury_signature_reason: "key_unset", treasury_pay_refusal: null },
    "S3 lnd_unavailable": { treasury_signature: "unverifiable", treasury_signature_reason: "lnd_unavailable", treasury_pay_refusal: null },
    S4: { ...VERIFIED, treasury_pay_refusal: { code: "price_above_cap", detail: "", price_sats: 100_001 } },
    S5: { ...VERIFIED, treasury_pay_refusal: { code: "price_not_integer", detail: "", price_sats: 42_000.5 } },
    S6: CHANGED,
  };
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  /** The full S-state paragraph for a status, as paymentTrust.ts writes it (no rate: sats). */
  const fullText = (s: any) => {
    const st = trustStateOfStatus(s)!;
    return trustCopy(st, st.state === "S4_price_above_cap" ? renewalAmount(st.price_sats, null).text : undefined).text;
  };
  /** Anti-orphan, on every render: a short string never renders without the full notice. */
  const assertNoOrphan = (where: string) => {
    const t = text();
    if (t.includes(DEPOSIT_HIDDEN) || t.includes(AUTOPAY_PAUSED)) {
      expect(host.querySelector("div.sub-alert[data-trust-state]"), `${where}: a short string rendered without the S-state notice`).not.toBeNull();
    }
  };

  it("every blocked state: the full S-state exactly once, the two pointers verbatim; verified: neither", async () => {
    for (const [name, labels] of Object.entries(STATES)) {
      const s = status("current", labels);
      stub.getSubscriptionStatus.mockResolvedValue(s);
      stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
      await show(React.createElement(SubscriptionPanel));
      assertNoOrphan(name);
      const full = fullText(s);
      expect(count(text(), full), `${name}: the full S-state paragraph must render exactly once`).toBe(1);
      expect(count(text(), DEPOSIT_HIDDEN), `${name}: the deposit block's pointer`).toBe(1);
      expect(count(text(), AUTOPAY_PAUSED), `${name}: the auto-pay section's pointer`).toBe(1);
    }
    // Anti-vacuity: verified and unrefused, no S-state and no pointer; the address shows.
    stub.getSubscriptionStatus.mockResolvedValue(status("current", VERIFIED));
    await show(React.createElement(SubscriptionPanel));
    expect(host.querySelector("[data-trust-state]")).toBeNull();
    expect(text()).not.toContain(DEPOSIT_HIDDEN);
    expect(text()).not.toContain(AUTOPAY_PAUSED);
    expect(host.querySelector(".sub-deposit-address")).not.toBeNull();
    assertNoOrphan("verified");
  });
});

describe("the auto-pay pointer shows only while auto-pay is on", () => {
  // drive-mode, accepted by Ethan 2026-11-11: blocked + ON → the pointer;
  // auto-pay OFF → the normal off-state line, blocked or not.
  const POINTER = "Auto-pay is paused (see above).";
  const OFF_LINE = "When on, your node renews from its Bitcoin balance once your subscription has lapsed.";
  const at = (labels: Record<string, unknown>) => status("current", labels, { paid_through: NOW + 5 * DAY, worker_until: NOW + 35 * DAY });

  it("blocked: ON shows the pointer, OFF the off-state line; verified: never the pointer", async () => {
    for (const [name, labels] of Object.entries(BLOCKED)) {
      stub.getSubscriptionStatus.mockResolvedValue(at(labels));
      stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, enabled_at: 1 }));
      await show(React.createElement(SubscriptionPanel));
      expect(text(), `${name}, ON: the pointer`).toContain(POINTER);
      expect(text(), `${name}, ON: no off-state line`).not.toContain(OFF_LINE);

      stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: false }));
      await show(React.createElement(SubscriptionPanel));
      expect(text(), `${name}, OFF: the pointer showed while auto-pay is off`).not.toContain(POINTER);
      expect(text(), `${name}, OFF: the off-state line, verbatim`).toContain(OFF_LINE);
    }
    for (const enabled of [true, false]) {
      stub.getSubscriptionStatus.mockResolvedValue(at(VERIFIED));
      stub.getAutoPayConfig.mockResolvedValue(autoPay(enabled ? { enabled: true, enabled_at: 1 } : { enabled: false }));
      await show(React.createElement(SubscriptionPanel));
      expect(text(), `verified, ${enabled ? "ON" : "OFF"}: no pointer`).not.toContain(POINTER);
      if (!enabled) expect(text()).toContain(OFF_LINE);
    }
  });
});

describe("the panel's \"Renew now\" is gated", () => {
  const renewNow = () =>
    [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Renew now")) as HTMLButtonElement | undefined;

  it("disabled under unsigned and S6, enabled under verified and unrefused", async () => {
    for (const [name, labels] of Object.entries(BLOCKED)) {
      stub.getSubscriptionStatus.mockResolvedValue(status("current", labels, { paid_through: NOW + 5 * DAY, worker_until: NOW + 35 * DAY }));
      await show(React.createElement(SubscriptionPanel));
      expect(renewNow(), `${name}: the Renew now button renders (setup)`).toBeDefined();
      expect(renewNow()!.disabled, `${name}: Renew now offered a payment the node won't make`).toBe(true);
    }
    stub.getSubscriptionStatus.mockResolvedValue(status("current", VERIFIED, { paid_through: NOW + 5 * DAY, worker_until: NOW + 35 * DAY }));
    await show(React.createElement(SubscriptionPanel));
    expect(renewNow()!.disabled).toBe(false);
  });
});

describe("G3 extension 2 — the Settings panel's remaining payment asks are hidden while blocked", () => {
  // Ruled 2026-11-11: the routing_lapsed/close_due alert's "Pay {price} to
  // restore them." and the current tier's pre-pause "Renew before then to keep
  // them running.". The surrounding sentences stay, with their spacing.
  const OVERDUE_LEAD = "Your membership payment is overdue, so hosted services are paused: Auto-Buy, with its Valuation Chart, and Stablecoin settlements.";
  const STILL_OPEN = " Your connection to Bitcorn is still open and its balance is unchanged.";
  const SITES = [
    { where: "routing_lapsed alert", s: (l: Record<string, unknown>) => status("routing_lapsed", l),
      present: `${OVERDUE_LEAD} Pay 42,000 sats to restore them.${STILL_OPEN}`, absent: /Pay 42,000 sats to restore them/,
      blocked: `${OVERDUE_LEAD}${STILL_OPEN}` },
    { where: "close_due alert", s: (l: Record<string, unknown>) => status("close_due", l),
      present: `${OVERDUE_LEAD} Pay 42,000 sats to restore them.${STILL_OPEN}`, absent: /Pay 42,000 sats to restore them/,
      blocked: `${OVERDUE_LEAD}${STILL_OPEN}` },
    { where: "current pre-pause line", s: (l: Record<string, unknown>) => status("current", l, { paid_through: NOW - DAY, worker_until: NOW + 9 * DAY }),
      present: /Hosted services pause on [A-Z][a-z]{2} \d{1,2}, \d{4}\. Renew before then to keep them running\./,
      absent: /Renew before then/, blocked: /Hosted services pause on [A-Z][a-z]{2} \d{1,2}, \d{4}\.MONTHLY/ },
  ];
  const has = (t: string, p: string | RegExp) => (typeof p === "string" ? t.includes(p) : p.test(t));

  it("each ask is absent under unsigned and S6, and present under verified and unrefused", async () => {
    for (const s of SITES) {
      for (const [name, labels] of Object.entries(BLOCKED)) {
        stub.getSubscriptionStatus.mockResolvedValue(s.s(labels));
        await show(React.createElement(SubscriptionPanel));
        const where = `${s.where}, ${name}`;
        expect(text(), `${where}: the panel asked for payment`).not.toMatch(s.absent);
        expect(has(text(), s.blocked), `${where}: the surrounding sentences stay, spaced: ${text().slice(0, 400)}`).toBe(true);
      }
      // Anti-vacuity: verified and unrefused, the ask renders in place.
      stub.getSubscriptionStatus.mockResolvedValue(s.s(VERIFIED));
      await show(React.createElement(SubscriptionPanel));
      expect(has(text(), s.present), `${s.where}, verified: ${text().slice(0, 400)}`).toBe(true);
    }
  });
});

describe("G3 extension — the Settings panel invites no payment from another wallet while blocked", () => {
  // Every tier with such a sentence (ruled 2026-11-11). The deposit block's own
  // helper and fineprint are already withheld by C15 while blocked.
  const SITES = [
    { tier: "prepay" as Tier, where: "prepay tagline", ask: "until your first payment. Send 42,000 sats to activate full membership.",
      blockedText: "You have payment access until your first payment." },
    { tier: "prepay" as Tier, where: "prepay \"Available now\" bullet",
      ask: "Available now — Coinbase Onramp for buying BTC, BTC/USD price reads, and the address below for receiving your first payment.",
      blockedText: "Activates on first payment" },
    { tier: "worker_lapsed" as Tier, where: "worker_lapsed \"If you renew\" row",
      ask: "recovery is fully in-app. Buy BTC via Onramp or send from a wallet you already have. Payment is detected within ~15 seconds;",
      blockedText: "recovery is fully in-app. Payment is detected within ~15 seconds;" },
  ];
  const ANY = /wallet you already have|to activate full membership|address below for receiving your first payment/;
  const iHaveBtc = () =>
    [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("I have BTC")) as HTMLButtonElement | undefined;

  it("each site is absent under unsigned and S6, and present under verified and unrefused", async () => {
    for (const s of SITES) {
      for (const [name, labels] of Object.entries(BLOCKED)) {
        stub.getSubscriptionStatus.mockResolvedValue(status(s.tier, labels));
        await show(React.createElement(SubscriptionPanel));
        const where = `${s.where}, ${name}`;
        expect(text(), `${where}: the panel invited payment from another wallet`).not.toContain(s.ask);
        expect(text(), `${where}: no such sentence anywhere`).not.toMatch(ANY);
        expect(text(), `${where}: the rest stays`).toContain(s.blockedText);
        expect(iHaveBtc()?.disabled, `${where}: "I have BTC" stays disabled`).toBe(true);
      }
      // Anti-vacuity: verified and unrefused, the sentence renders.
      stub.getSubscriptionStatus.mockResolvedValue(status(s.tier, VERIFIED));
      await show(React.createElement(SubscriptionPanel));
      expect(text(), `${s.where}, verified`).toContain(s.ask);
      expect(iHaveBtc()?.disabled, `${s.where}, verified: "I have BTC" is enabled`).toBe(false);
    }
  });
});
