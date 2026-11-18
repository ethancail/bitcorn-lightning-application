// member-first-run-ui slice 4 — the simplified Membership panel, by tier.
//
// The ruled design (2026-11-13 §2–§4) and R6 ("recs", 2026-11-18): every state
// is laid out in three tiers —
//   "A"      always visible (outside every row);
//   a row id one tap away, in that closed row (<details data-row=…>);
//   only when it applies (a warning) — asserted present only in its condition.
// And every fact on the panel before this slice stays reachable: the
// INVENTORY below is the recon's list of today's facts, per state, with the
// tier each one has now. It runs across the status labels (verified,
// unsigned, S6 address changed): under a blocked label the payment asks are
// hidden (G3, ruled 2026-11-11) and the C15 deposit block is withheld.
//
// A fact is located by the deepest element whose text holds it; its tier is
// the <details> it sits in, or "A".

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
  setAutoPay: vi.fn(),
  getExchangeRate: vi.fn(),
  getPayFromNodeQuote: vi.fn(),
  getPayFromNodePending: vi.fn(),
  getCoinbaseOnrampUrl: vi.fn(),
}));
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "../SubscriptionPanel";
import { MEMBERSHIP_COPY as C } from "./membershipDescriptor";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const NEW_ADDR = "bc1qtreasurystatedaddress0000000000000yy";
const PUBKEY = "02" + "c".repeat(64);
const PRICE = 42_000;
const USD = 60_000; // → $25.20

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };
const UNSIGNED = { treasury_signature: "unsigned", treasury_signature_reason: null, treasury_pay_refusal: null };
const CHANGED = {
  treasury_signature: "verified",
  treasury_signature_reason: null,
  treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: ADDR, stated_address: NEW_ADDR },
};
const LABELS: Record<string, Record<string, unknown>> = { verified: VERIFIED, unsigned: UNSIGNED, "S6 address changed": CHANGED };

type Tier = "prepay" | "current" | "worker_lapsed" | "routing_lapsed" | "close_due";
const status = (tier: Tier, labels: Record<string, unknown>, o: { paid_through?: number; worker_until?: number; last?: number | null } = {}) => ({
  applicable: true,
  member_pubkey: PUBKEY,
  current_tier: tier,
  paid_through: o.paid_through ?? NOW - 35 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: labels === CHANGED ? NEW_ADDR : ADDR,
  last_payment_at: o.last === undefined ? NOW - 65 * DAY : o.last,
  last_payment_txid: "f".repeat(64),
  grace: { fresh_until: 0, worker_until: o.worker_until ?? NOW - 5 * DAY, routing_until: NOW - 5 * DAY, close_at: NOW + 25 * DAY },
  ...labels,
});
const autoPay = (o: Record<string, unknown> = {}) => ({
  enabled: true, enabled_at: Math.floor((NOW - 3 * DAY) / 1000), last_acknowledged_price: PRICE, last_acknowledged_price_at: null,
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
  stub.getNode.mockResolvedValue({ pubkey: PUBKEY });
  stub.getAutoPayConfig.mockResolvedValue(autoPay());
  stub.getAutoPayHistory.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: USD, source: "coinbase", fetched_at: NOW - 60_000, age_ms: 60_000, state: "fresh" });
  stub.getPayFromNodePending.mockResolvedValue({ pending: null });
  stub.getPayFromNodeQuote.mockResolvedValue({ amount_sats: PRICE, deposit_address: ADDR, estimated_fee_sats: 1_234 });
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
async function mount() {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel))); });
  await flush();
}
async function panel(s: unknown) {
  stub.getSubscriptionStatus.mockResolvedValue(s);
  await mount();
}
const norm = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ");
const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Where a fact is: "A", the id of the row it is in, or null when absent. */
function locate(fact: string): string | null {
  const holders = [...host.querySelectorAll("*")].filter((el) => norm(el.textContent).includes(fact));
  if (holders.length === 0) return null;
  const deepest = holders.find((el) => ![...el.children].some((c) => norm(c.textContent).includes(fact)))!;
  const row = deepest.closest("details");
  return row ? row.getAttribute("data-row") : "A";
}

// ─── The inventory ───────────────────────────────────────────────────────
//
// blocked: "hidden" — a payment ask or the C15 deposit block, absent under
// unsigned and S6; "only" — present only then (the G3 pointers).

type Fact = { fact: string; tier: string; blocked?: "hidden" | "only" };

const OTHER_WAYS_COMMON: Fact[] = [
  { fact: C.copyAddress, tier: "other-ways", blocked: "hidden" },
  { fact: "ADDRESS", tier: "other-ways", blocked: "hidden" },
  { fact: C.addressHidden, tier: "other-ways", blocked: "only" },
  { fact: C.onramp, tier: "other-ways" },
  { fact: C.checkAgain, tier: "other-ways" },
];
const ABOUT_ON: Fact[] = [
  { fact: C.aboutRequires, tier: "about" },
  { fact: C.aboutNeverMore, tier: "about" },
  { fact: C.aboutOptOut, tier: "about" },
  { fact: "Enabled 3 days ago", tier: "about" },
  { fact: C.historyShow, tier: "about" },
];
const SWITCH_ON: Fact[] = [
  { fact: C.switchLabel, tier: "A" },
  { fact: C.switchOn, tier: "A", blocked: "hidden" },
  { fact: C.autoPayPaused, tier: "A", blocked: "only" },
];
const HISTORY: Fact[] = [
  { fact: C.lastPayment(date(NOW - 65 * DAY)), tier: "history" },
  { fact: C.seeAll, tier: "history" },
];
const USES: Fact = { fact: C.uses("$25.20 (42,000 sats)"), tier: "A", blocked: "hidden" };

const overdueFacts = (mark: string): Fact[] => [
  { fact: C.heading, tier: "A" },
  { fact: mark, tier: "A" },
  { fact: C.overdueLead, tier: "A" },
  { fact: C.stillOpen, tier: "A" },
  { fact: C.renewFor, tier: "A" },
  { fact: C.cadencePast(30, date(NOW - 35 * DAY), 35), tier: "A" },
  { fact: C.renewButton, tier: "A" },
  USES,
  ...SWITCH_ON,
  { fact: C.sendExactly(PRICE, 30), tier: "other-ways", blocked: "hidden" },
  { fact: C.fineprintLapsed, tier: "other-ways", blocked: "hidden" },
  ...OTHER_WAYS_COMMON,
  { fact: C.services, tier: "paused" },
  { fact: C.restoreAsk("$25.20 (42,000 sats)"), tier: "paused", blocked: "hidden" },
  { fact: C.stillUse, tier: "paused" },
  { fact: C.ifRenew(30), tier: "next" },
  { fact: C.ifNotRenew, tier: "next" },
  { fact: C.rightNow, tier: "next" },
  { fact: C.aboutLapsedNow("$25.20 (42,000 sats)"), tier: "about", blocked: "hidden" },
  ...ABOUT_ON,
  ...HISTORY,
];

const currentFacts = (o: { mark: string; lead: Fact[]; label: string; cadence: string }): Fact[] => [
  { fact: C.heading, tier: "A" },
  { fact: o.mark, tier: "A" },
  ...o.lead,
  { fact: o.label, tier: "A" },
  { fact: o.cadence, tier: "A" },
  { fact: C.renewButton, tier: "A" },
  USES,
  ...SWITCH_ON,
  { fact: C.sendExactly(PRICE, 30), tier: "other-ways", blocked: "hidden" },
  { fact: C.fineprintCurrent, tier: "other-ways", blocked: "hidden" },
  ...OTHER_WAYS_COMMON,
  { fact: C.renewCounts(30), tier: "next" },
  { fact: C.pausesOn(date(NOW + 40 * DAY)), tier: "next" },
  ...ABOUT_ON,
  ...HISTORY,
];

type State = { name: string; s: (l: Record<string, unknown>) => unknown; facts: Fact[]; rows: string[] };

const APPLICABLE: State[] = [
  { name: "routing_lapsed (overdue)", s: (l) => status("routing_lapsed", l), facts: overdueFacts(C.mark.overdue), rows: ["other-ways", "paused", "next", "about", "history"] },
  { name: "close_due (overdue)", s: (l) => status("close_due", l), facts: overdueFacts(C.mark.overdue), rows: ["other-ways", "paused", "next", "about", "history"] },
  { name: "worker_lapsed (services paused)", s: (l) => status("worker_lapsed", l), facts: overdueFacts(C.mark.servicesPaused), rows: ["other-ways", "paused", "next", "about", "history"] },
  {
    name: "current, paid up",
    s: (l) => status("current", l, { paid_through: NOW + 10 * DAY, worker_until: NOW + 40 * DAY }),
    facts: [
      ...currentFacts({ mark: C.mark.paidUp, lead: [{ fact: C.paidUpLead, tier: "A" }], label: C.renewsFor, cadence: C.cadenceAhead(30, date(NOW + 10 * DAY), 10) }),
      { fact: C.aboutIfLapses("$25.20 (42,000 sats)", date(NOW + 40 * DAY)), tier: "about", blocked: "hidden" },
    ],
    rows: ["other-ways", "next", "about", "history"],
  },
  {
    name: "current, due soon (pre-pause)",
    s: (l) => status("current", l, { paid_through: NOW - 2 * DAY, worker_until: NOW + 40 * DAY }),
    facts: [
      ...currentFacts({
        mark: C.mark.due,
        lead: [{ fact: C.dueLead(date(NOW + 40 * DAY)), tier: "A" }, { fact: C.dueAsk, tier: "A", blocked: "hidden" }],
        label: C.renewFor,
        cadence: C.cadencePast(30, date(NOW - 2 * DAY), 2),
      }),
      { fact: C.aboutIfLapses("$25.20 (42,000 sats)", date(NOW + 40 * DAY)), tier: "about", blocked: "hidden" },
    ],
    rows: ["other-ways", "next", "about", "history"],
  },
  {
    name: "prepay (never paid)",
    s: (l) => status("prepay", l, { last: null }),
    facts: [
      { fact: C.heading, tier: "A" },
      { fact: C.mark.notActive, tier: "A" },
      { fact: C.prepayLead, tier: "A" },
      { fact: C.prepayAsk("$25.20 (42,000 sats)"), tier: "A", blocked: "hidden" },
      { fact: C.activateFor, tier: "A" },
      { fact: C.cadencePrepay(30), tier: "A" },
      { fact: C.payButton, tier: "A" },
      USES,
      ...SWITCH_ON,
      { fact: C.sendExactlyActivate(PRICE), tier: "other-ways", blocked: "hidden" },
      { fact: C.fineprintPrepay, tier: "other-ways", blocked: "hidden" },
      ...OTHER_WAYS_COMMON,
      { fact: C.availableNow, tier: "included", blocked: "hidden" },
      { fact: C.activatesOnFirst, tier: "included" },
      { fact: C.aboutLapsedNow("$25.20 (42,000 sats)"), tier: "about", blocked: "hidden" },
      ...ABOUT_ON,
      { fact: C.noPayment, tier: "history" },
      { fact: C.seeAll, tier: "history" },
    ],
    rows: ["other-ways", "included", "about", "history"],
  },
];

const ROW_TITLES: Record<string, string> = {
  "other-ways": C.row.otherWays, paused: C.row.paused, included: C.row.included, next: C.row.next,
  about: C.row.about, history: C.row.history, details: C.row.details, price: C.row.price,
};

function checkRows(where: string, rows: string[]) {
  const found = [...host.querySelectorAll("details")];
  expect(found.map((d) => d.getAttribute("data-row")), `${where}: the rows, in order`).toEqual(rows);
  for (const d of found) {
    expect(d.open, `${where}: row "${d.getAttribute("data-row")}" is open by default`).toBe(false);
    expect(d.querySelector("summary")?.textContent, `${where}: row title`).toBe(ROW_TITLES[d.getAttribute("data-row")!]);
  }
}

describe("slice 4 — every applicable state, in its tiers, across the status labels", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  for (const st of APPLICABLE) {
    it(`${st.name}: every fact in its tier; the rows closed; the asks only while payable`, async () => {
      for (const [label, labels] of Object.entries(LABELS)) {
        const blocked = label !== "verified";
        await panel(st.s(labels));
        const where = `${st.name}, ${label}`;
        checkRows(where, st.rows);
        for (const f of st.facts) {
          const expected = (f.blocked === "hidden" && blocked) || (f.blocked === "only" && !blocked) ? null : f.tier;
          expect(locate(f.fact), `${where}: "${f.fact}"`).toBe(expected);
        }
        // The big amount, dollars over sats, always visible.
        const hero = host.querySelector(".membership-amount .amount-hero");
        expect(hero?.closest("details"), `${where}: the big amount is always visible`).toBeNull();
        expect(hero?.querySelector('[data-line="usd"]')?.textContent).toBe("$25.20");
        expect(hero?.querySelector('[data-line="sats"]')?.textContent).toBe("42,000 sats");
        // The trust notice: only when it applies.
        expect(document.querySelector("[data-trust-state]") !== null, `${where}: the trust notice`).toBe(blocked);
      }
    });
  }
});

// ─── Not applicable, loading, errors ─────────────────────────────────────

type Plain = { name: string; arrange: () => void; facts: Fact[]; rows: string[] };
const reject = (e: Record<string, unknown>) => () => stub.getSubscriptionStatus.mockRejectedValue(Object.assign(new Error("boom detail"), e));
const OTHER: Plain[] = [
  { name: "external_peer", arrange: () => stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason: "external_peer" }),
    facts: [{ fact: C.heading, tier: "A" }, { fact: C.externalPeer, tier: "A" }], rows: [] },
  { name: "unclassified", arrange: () => stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason: "unclassified" }),
    facts: [{ fact: C.mark.unclassified, tier: "A" }, { fact: C.unclassified, tier: "A" }, { fact: C.priceIs("$25.20 (42,000 sats)"), tier: "price" }],
    rows: ["price"] },
  { name: "not_yet_allocated", arrange: () => stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason: "not_yet_allocated", channel_age_seconds: 12 }),
    facts: [
      { fact: C.mark.settingUp, tier: "A" }, { fact: C.settingUpHeadline, tier: "A" }, { fact: C.settingUpBody, tier: "A" },
      { fact: C.connectionAge(12), tier: "A" }, { fact: C.priceIs("$25.20 (42,000 sats)"), tier: "price" },
    ],
    rows: ["price"] },
  { name: "missing (the pubkey always visible)", arrange: () => stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason: "missing" }),
    facts: [
      { fact: C.mark.unavailable, tier: "A" }, { fact: C.missing, tier: "A" }, { fact: C.memberIdLabel, tier: "A" },
      { fact: PUBKEY, tier: "A" }, { fact: C.copyPubkey, tier: "A" }, { fact: C.shareWithSupport, tier: "A" }, { fact: C.tryNow, tier: "A" },
      { fact: C.checkingEvery("0 seconds"), tier: "details" }, { fact: C.missingFooter, tier: "details" },
    ],
    rows: ["details"] },
  { name: "no_channel", arrange: () => stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason: "no_channel" }),
    facts: [{ fact: C.noChannel, tier: "A" }, { fact: C.connect, tier: "A" }], rows: [] },
  { name: "loading", arrange: () => stub.getSubscriptionStatus.mockReturnValue(new Promise(() => {})),
    facts: [{ fact: C.heading, tier: "A" }], rows: [] },
  { name: "401", arrange: reject({ status: 401 }), facts: [{ fact: C.heading, tier: "A" }], rows: [] },
  { name: "infrastructure 503", arrange: reject({ status: 503, code: "no_local_token" }),
    facts: [
      { fact: C.mark.couldntLoad, tier: "A" }, { fact: C.infraError, tier: "A" }, { fact: C.refreshNow, tier: "A" },
      { fact: "(boom detail)", tier: "details" }, { fact: C.inStateFor("0 seconds"), tier: "details" },
    ],
    rows: ["details"] },
  { name: "network error", arrange: reject({}),
    facts: [
      { fact: C.mark.couldntLoad, tier: "A" }, { fact: C.networkError, tier: "A" }, { fact: C.refreshNow, tier: "A" },
      { fact: "(boom detail)", tier: "details" }, { fact: C.inStateFor("0 seconds"), tier: "details" },
    ],
    rows: ["details"] },
  { name: "treasury unreachable", arrange: reject({ status: 503, code: "treasury_unreachable" }),
    facts: [
      { fact: C.mark.unreachable, tier: "A" }, { fact: C.unreachable, tier: "A" }, { fact: C.refreshNow, tier: "A" },
      { fact: "(boom detail)", tier: "details" }, { fact: C.checkingEvery("0 seconds"), tier: "details" },
    ],
    rows: ["details"] },
];

describe("slice 4 — the other states, in their tiers", () => {
  for (const st of OTHER) {
    it(`${st.name}: every fact in its tier; the rows closed`, async () => {
      st.arrange();
      await mount();
      checkRows(st.name, st.rows);
      for (const f of st.facts) expect(locate(f.fact), `${st.name}: "${f.fact}"`).toBe(f.tier);
      // No state but the applicable ones has the switch or the button.
      expect(host.querySelector(".membership-button")).toBeNull();
      expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    });
  }
});

// ─── Only when it applies ─────────────────────────────────────────────────

describe("slice 4 — warnings show only when they apply", () => {
  const S = () => status("routing_lapsed", VERIFIED);

  it("the waiting notice: only with a marker", async () => {
    await panel(S());
    expect(host.querySelector("[data-pending-payment]")).toBeNull();
    stub.getPayFromNodePending.mockResolvedValue({
      pending: { amount_sats: PRICE, txid: "ab".repeat(32), sent_at: Math.floor(NOW / 1000) - 12 * 60, origin: "manual", paid_through_at_write: NOW - 35 * DAY, count: 1 },
    });
    await panel(S());
    const notice = host.querySelector("[data-pending-payment]");
    expect(notice, "the notice shows with a marker").not.toBeNull();
    expect(notice!.closest("details"), "the notice is not behind a row").toBeNull();
  });

  it("the auto-pay load failure: only when the read fails", async () => {
    await panel(S());
    expect(host.textContent).not.toContain(C.autoPayLoadFailed);
    stub.getAutoPayConfig.mockRejectedValue(new Error("Failed to fetch"));
    await panel(S());
    expect(locate(C.autoPayLoadFailed)).toBe("A");
  });

  it("the Onramp error: only after a failed open, in 'Other ways to pay' by its button", async () => {
    stub.getCoinbaseOnrampUrl.mockRejectedValue(Object.assign(new Error("nope"), { status: 503, code: "onramp_not_configured" }));
    await panel(S());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(C.onramp))!;
    await act(async () => { btn.click(); });
    await flush();
    const alert = host.querySelector('[role="alert"]');
    expect(alert, "the error shows").not.toBeNull();
    expect(alert!.closest("details")?.getAttribute("data-row")).toBe("other-ways");
  });
});

// ─── The button (R1) ──────────────────────────────────────────────────────

describe("slice 4, R1 — the button opens the pay modal at \"Pay from this node\"", () => {
  const title = () => document.querySelector('[role="dialog"] .dialog-title')?.textContent ?? null;
  const named = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

  it.each([
    ["routing_lapsed", () => status("routing_lapsed", VERIFIED), C.renewButton],
    ["current", () => status("current", VERIFIED, { paid_through: NOW + 10 * DAY, worker_until: NOW + 40 * DAY }), C.renewButton],
    ["prepay", () => status("prepay", VERIFIED), C.payButton],
  ] as const)("%s: straight to \"Pay from this node\"; Back reaches the chooser", async (_n, s, label) => {
    await panel(s());
    const button = host.querySelector(".membership-button") as HTMLButtonElement;
    expect(button.textContent).toBe(label);
    await act(async () => { button.click(); });
    await flush();
    expect(title(), "the modal opened at the chooser, not at Pay from this node").toBe("Pay from this node");
    expect(named("Confirm send")).toBeDefined();
    await act(async () => { named("Back")!.click(); });
    await flush();
    expect(title()).toBe("Where is your BTC?");
    expect(named("I have BTC elsewhere")).toBeDefined();
  });
});

// ─── R8 ───────────────────────────────────────────────────────────────────

describe("slice 4, R8 fixes", () => {
  it("\"Check again\" (was \"Refresh token\") reads the status again", async () => {
    await panel(status("current", VERIFIED, { paid_through: NOW + 10 * DAY, worker_until: NOW + 40 * DAY }));
    expect(host.textContent).not.toContain("Refresh token");
    const before = stub.getSubscriptionStatus.mock.calls.length;
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === C.checkAgain)!;
    await act(async () => { btn.click(); });
    await flush();
    expect(stub.getSubscriptionStatus.mock.calls.length).toBe(before + 1);
  });

  it("the auto-pay settings are read once for the panel, the switch and the row together", async () => {
    await panel(status("routing_lapsed", VERIFIED));
    expect(host.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(locate(C.aboutRequires)).toBe("about");
    expect(stub.getAutoPayConfig).toHaveBeenCalledTimes(1);
  });

  it("the switch turns auto-pay off and reads the settings again, once", async () => {
    stub.setAutoPay.mockResolvedValue({});
    await panel(status("routing_lapsed", VERIFIED));
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: false, enabled_at: null }));
    const toggle = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); });
    await flush();
    expect(stub.setAutoPay).toHaveBeenCalledWith(false);
    expect(stub.getAutoPayConfig).toHaveBeenCalledTimes(2);
    expect(locate(C.switchOff)).toBe("A");
    expect(locate(C.aboutOffLine)).toBe("about");
  });

  it("the S4 auto-pay text is \"$X (N sats)\", not sats alone", async () => {
    stub.getAutoPayConfig.mockResolvedValue(autoPay({
      enabled: false, status_verification: "verified",
      price_refusal: { code: "price_above_cap", detail: "", price_sats: 90_000 },
    }));
    await panel(status("routing_lapsed", VERIFIED));
    const line = host.querySelector('.membership-switch [data-trust-state="S4_price_above_cap"]');
    expect(line, "setup: the S4 line renders").not.toBeNull();
    expect(norm(line!.textContent)).toContain("The subscription price, $54.00 (90,000 sats), is above the limit");
  });
});
