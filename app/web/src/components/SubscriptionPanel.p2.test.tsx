// drive-mode P2, the renewal panel:
//   item 10 (R6(b)(a), D2.5) — the live price in place of the hard-coded
//     50,000 sats: the applicable panel reads status.price_sats; the two
//     not-applicable states with a MONTHLY figure read auto-pay's
//     current_price (R27(8)), "—" without one.
//   item 11 — the panel's "paid up" line is not shown from P to the pause.
//   item 13 (R6(b)(b)) — auto-pay's copy says what it does today: it pays
//     once a lapse has begun (autoPayTrigger.ts), after hosted services pause,
//     so it never "never lapses".
//
// Harness: SubscriptionPanel.copy.test.tsx's.

import fs from "fs";
import path from "path";
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
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "./SubscriptionPanel";

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

const applicable = (o: { paid_through?: number; worker_until?: number; price?: number } = {}) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: "current",
  paid_through: o.paid_through ?? NOW + 20 * DAY,
  price_sats: o.price ?? 42_000,
  period_days: 30,
  deposit_address: "bc1q" + "d".repeat(38),
  last_payment_at: NOW - 10 * DAY,
  last_payment_txid: "f".repeat(64),
  grace: { fresh_until: 0, worker_until: o.worker_until ?? NOW + 27 * DAY, routing_until: NOW + 50 * DAY, close_at: NOW + 80 * DAY },
});

const autoPay = (o: { enabled?: boolean; current_price?: number | null } = {}) => ({
  enabled: o.enabled ?? false,
  enabled_at: null,
  last_acknowledged_price: null,
  last_acknowledged_price_at: null,
  current_price: o.current_price === undefined ? 42_000 : o.current_price,
  price_change_pending: false,
  active_alerts: [],
  badge: { active_count: 0, highest_severity: null },
});

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue(autoPay());
  stub.getAutoPayHistory.mockResolvedValue({ alerts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  nowSpy.mockRestore();
});

async function mount() {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel))); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The MONTHLY stat's value. */
function monthly(): string | null {
  const stat = [...host.querySelectorAll(".sub-stats > *")].find((s) => s.textContent?.includes("MONTHLY"));
  return stat ? (stat.textContent ?? "").replace("MONTHLY", "").trim() : null;
}

describe("item 10, D2.5: the live price, never the literal 50,000", () => {
  it("the renewal helper reads the status's price (42,000)", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(applicable({ price: 42_000 }));
    await mount();
    expect(text()).toContain("Send 42,000 sats to renew for one month.");
    expect(text()).not.toContain("50,000");
  });

  for (const reason of ["unclassified", "not_yet_allocated"] as const) {
    it(`${reason}: MONTHLY shows auto-pay's current_price`, async () => {
      stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason, channel_age_seconds: 10 });
      await mount();
      expect(monthly()).toMatch(/^42,000\s*sats/);
      expect(text()).not.toContain("50,000");
    });

    it(`${reason}: no current_price → "—", not a guessed price`, async () => {
      stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason, channel_age_seconds: 10 });
      stub.getAutoPayConfig.mockResolvedValue(autoPay({ current_price: null }));
      await mount();
      expect(monthly()).toMatch(/^—/);
    });
  }

  it("no renewal file carries the literal 50,000-sat price", () => {
    const files = ["SubscriptionPanel.tsx", "subscriptionBanner.ts", "MemberSubscriptionBanner.tsx", "AutoPaySection.tsx", "PayFromNodeModal.tsx"];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(src.length, f).toBeGreaterThan(100);
      expect(src, f).not.toMatch(/50_000|50,000|\b50000\b/);
    }
  });
});

describe("item 11: the panel says when services pause, from P", () => {
  it("before P: \"paid up\"", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(applicable({ paid_through: NOW + DAY }));
    await mount();
    expect(text()).toContain("is paid up.");
  });

  it("at P: not \"paid up\" — the pause date, read from the status", async () => {
    const workerUntil = NOW + 9 * DAY;
    stub.getSubscriptionStatus.mockResolvedValue(applicable({ paid_through: NOW, worker_until: workerUntil }));
    await mount();
    expect(text()).not.toContain("is paid up.");
    expect(text()).toContain(`Hosted services pause on ${date(workerUntil)}. Renew before then to keep them running.`);
  });
});

describe("item 13: auto-pay says what it does today", () => {
  it("on: it pays after hosted services pause, dated, so it doesn't prevent the pause", async () => {
    const workerUntil = NOW + 27 * DAY;
    stub.getSubscriptionStatus.mockResolvedValue(applicable({ worker_until: workerUntil }));
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true }));
    await mount();
    expect(text()).toContain(
      "If your subscription lapses, your node pays 42,000 sats from its Bitcoin balance to renew it. " +
      `That happens after hosted services pause on ${date(workerUntil)}, so turning this on doesn't prevent the pause.`,
    );
    expect(text()).not.toMatch(/never lapses|would otherwise lapse/);
  });

  it("off: what turning it on would do", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(applicable());
    await mount();
    expect(text()).toContain("When on, your node renews from its Bitcoin balance once your subscription has lapsed.");
    expect(text()).not.toMatch(/never lapses/);
  });
});
