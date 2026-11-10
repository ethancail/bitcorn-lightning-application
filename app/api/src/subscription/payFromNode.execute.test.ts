// executePayFromNode against a real (temp-file) database, with LND and the
// treasury status mocked. Covers the pay-from-node guards (specs/2026-11-05-
// pay-from-node-spec.md §2–§4, with the 2026-11-05 rulings): the echo, the
// settlement marker, the price ceiling, and what a refusal leaves behind.
//
// Each control's mutation and red line is recorded in the PR report; the
// assertions that guard a property are "no send" (the LND send spy) or the
// refusal's code, never a setup error.

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-pfn-exec-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const h = vi.hoisted(() => ({
  status: null as unknown,
  statusOk: true,
  balance: 1_000_000,
  feeThrows: null as unknown,
  balanceThrows: null as unknown,
  sendThrows: null as unknown,
  nextTxid: 1,
}));

vi.mock("./memberStatusClient", () => ({
  fetchLocalSubscriptionStatus: async () =>
    h.statusOk
      ? { ok: true, status: h.status }
      : { ok: false, code: "treasury_unreachable", detail: "treasury down" },
}));

// The cap is not under test here (treasury-price-trust's controls test it);
// its shipped value is owed, so inject one that bounds nothing these tests
// send. Not a proposal for SUBSCRIPTION_PRICE_CAP_SATS.
vi.mock("./priceCap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./priceCap")>()),
  SUBSCRIPTION_PRICE_CAP_SATS: Number.MAX_SAFE_INTEGER,
}));

vi.mock("../lightning/lnd", () => ({
  getLndChainFeeRate: vi.fn(async () => {
    if (h.feeThrows) throw h.feeThrows;
    return { tokens_per_vbyte: 2 };
  }),
  getLndChainBalance: vi.fn(async () => {
    if (h.balanceThrows) throw h.balanceThrows;
    return { chain_balance: h.balance };
  }),
  sendLndToChainAddress: vi.fn(async () => {
    if (h.sendThrows) throw h.sendThrows;
    return { id: `tx${h.nextTxid++}` };
  }),
}));

const PUB = "02member";
const ADDR = "bcrt1qdeposit";
const PRICE = 50_000;

function applicable(over: Record<string, unknown> = {}) {
  return {
    applicable: true,
    current_tier: "worker_lapsed",
    price_sats: PRICE,
    deposit_address: ADDR,
    paid_through: 1_000_000,
    last_payment_txid: null,
    ...over,
  };
}

let db: Database.Database;
let execute: typeof import("./payFromNode").executePayFromNode;
let errorHttpStatus: typeof import("./payFromNode").errorHttpStatus;
let lnd: typeof import("../lightning/lnd");
let markers: typeof import("./sendMarker");
let profile: typeof import("../profile/profileStore");
let ENV: typeof import("../config/env").ENV;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ executePayFromNode: execute, errorHttpStatus } = await import("./payFromNode"));
  lnd = await import("../lightning/lnd");
  markers = await import("./sendMarker");
  profile = await import("../profile/profileStore");
  ({ ENV } = await import("../config/env"));
});

beforeEach(() => {
  db.prepare("DELETE FROM subscription_send_marker").run();
  db.prepare("DELETE FROM member_profile").run();
  db.prepare("DELETE FROM subscription_deposit_address_pin").run();
  h.status = applicable();
  h.statusOk = true;
  h.balance = 1_000_000;
  h.feeThrows = null;
  h.balanceThrows = null;
  h.sendThrows = null;
  h.nextTxid = 1;
  vi.mocked(lnd.sendLndToChainAddress).mockClear();
  // Default: the member has acknowledged the current price.
  setAcknowledged(PRICE);
});

function setAcknowledged(price: number | null): void {
  db.prepare("DELETE FROM member_profile").run();
  if (price != null) profile.acknowledgePrice(PUB, price, 1);
}
function acknowledged(): number | null {
  return profile.getMemberProfile(PUB)?.last_acknowledged_price ?? null;
}
function active() {
  return markers.listActiveMarkers(db, PUB);
}
function manual(o: {
  amount_sats?: number;
  deposit_address?: string;
  repeatAcknowledged?: boolean;
  priceAcknowledged?: boolean;
} = {}) {
  return execute({
    origin: "manual",
    memberPubkey: PUB,
    expected: { amount_sats: o.amount_sats ?? PRICE, deposit_address: o.deposit_address ?? ADDR },
    repeatAcknowledged: o.repeatAcknowledged ?? false,
    priceAcknowledged: o.priceAcknowledged ?? false,
  });
}
function auto() {
  return execute({ origin: "auto", memberPubkey: PUB });
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function insertMarker(ageSec: number, txid: string | null = null): number {
  const id = markers.writeMarker(db, {
    member_pubkey: PUB,
    origin: "manual",
    amount_sats: PRICE,
    deposit_address: ADDR,
    paid_through_at_write: 1_000_000,
    last_payment_txid_at_write: null,
    created_at: nowSec() - ageSec,
  });
  if (txid) markers.setMarkerTxid(db, id, txid);
  return id;
}

describe("permitting control: an ordinary manual send", () => {
  it("sends the SERVER-derived amount to the SERVER-derived address and writes one marker with the txid", async () => {
    const r = await manual();
    expect(r).toMatchObject({ ok: true, txid: "tx1" });
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledWith(ADDR, PRICE, 6);
    expect(active()).toHaveLength(1);
    expect(active()[0]).toMatchObject({ origin: "manual", amount_sats: PRICE, txid: "tx1" });
  });
});

describe("C1 — the echo (D1): a mismatch refuses before anything else happens", () => {
  it("amount alone moved → 409 pay_target_changed, no send, no marker", async () => {
    const r = await manual({ amount_sats: PRICE - 1 });
    expect(r).toMatchObject({ ok: false, code: "pay_target_changed" });
    expect(r.ok === false && r.detail).toContain("amount_sats");
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    expect(active()).toHaveLength(0);
  });

  it("address alone moved → 409 pay_target_changed, no send, no marker", async () => {
    const r = await manual({ deposit_address: "bcrt1qsomeoneelse" });
    expect(r).toMatchObject({ ok: false, code: "pay_target_changed" });
    expect(r.ok === false && r.detail).toContain("deposit_address");
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    expect(active()).toHaveLength(0);
  });

  it("ruling D: the echo is checked BEFORE the marker — a moved target with an active marker is pay_target_changed, not repeat_unacknowledged", async () => {
    insertMarker(60, "tx0");
    const r = await manual({ amount_sats: PRICE + 1 });
    expect(r).toMatchObject({ ok: false, code: "pay_target_changed" });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });
});

describe("C2 — a manual repeat needs the deliberate acknowledgement (D2)", () => {
  it("second send without repeat_acknowledged → 409 repeat_unacknowledged naming the earlier payment; one send only", async () => {
    expect(await manual()).toMatchObject({ ok: true });
    const r = await manual();
    expect(r).toMatchObject({
      ok: false,
      code: "repeat_unacknowledged",
      marker: { amount_sats: PRICE, txid: "tx1" },
    });
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(1);
  });

  it("permitting control: with repeat_acknowledged the second send goes, and writes its own marker", async () => {
    expect(await manual()).toMatchObject({ ok: true });
    expect(await manual({ repeatAcknowledged: true })).toMatchObject({ ok: true, txid: "tx2" });
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(2);
    expect(active()).toHaveLength(2);
  });
});

describe("C3 — auto-pay with an active marker defers (D2)", () => {
  it("→ settlement_pending, no send", async () => {
    insertMarker(60, "tx0");
    const r = await auto();
    expect(r).toMatchObject({ ok: false, code: "settlement_pending" });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });
});

describe("C5 — the marker is committed before the send is called", () => {
  it("a failure at the send call leaves an active marker that a fresh connection to the same file reads, and the next auto tick holds", async () => {
    h.sendThrows = new Error("the process died mid-send");
    const r = await manual();
    expect(r.ok).toBe(false);
    const reopened = new Database(path.join(process.env.DB_DIR!, "bitcorn.sqlite"), { readonly: true });
    const n = (reopened
      .prepare("SELECT COUNT(*) AS n FROM subscription_send_marker WHERE member_pubkey = ? AND cleared_at IS NULL")
      .get(PUB) as { n: number }).n;
    reopened.close();
    expect(n).toBe(1);
    h.sendThrows = null;
    vi.mocked(lnd.sendLndToChainAddress).mockClear();
    expect(await auto()).toMatchObject({ ok: false, code: "settlement_pending" });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });
});

describe("C6 — the manual price ceiling (D3, ruling 1)", () => {
  it("C6a: price above the acknowledged one, no price_acknowledged → 409 price_above_acknowledged with both prices; no send; nothing recorded", async () => {
    setAcknowledged(40_000);
    const r = await manual();
    expect(r).toMatchObject({
      ok: false,
      code: "price_above_acknowledged",
      price_sats: PRICE,
      acknowledged_price_sats: 40_000,
    });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    expect(acknowledged()).toBe(40_000);
  });

  it("C6b permitting: with price_acknowledged it sends and records the new price", async () => {
    setAcknowledged(40_000);
    expect(await manual({ priceAcknowledged: true })).toMatchObject({ ok: true });
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(1);
    expect(acknowledged()).toBe(PRICE);
  });

  it("ruling 6: at or below the ceiling the flag is ignored — the ceiling is never lowered", async () => {
    setAcknowledged(60_000);
    expect(await manual({ priceAcknowledged: true })).toMatchObject({ ok: true });
    expect(acknowledged()).toBe(60_000);
  });

  it("ruling 5: a flagged send refused before broadcast records nothing", async () => {
    setAcknowledged(40_000);
    h.balance = 0;
    const r = await manual({ priceAcknowledged: true });
    expect(r).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect(acknowledged()).toBe(40_000);
    expect(active()).toHaveLength(0);
  });

  it("ruling A: a price recorded with a marker stays when a send-call error keeps that marker", async () => {
    setAcknowledged(40_000);
    h.sendThrows = new Error("connection reset by peer mid-call");
    const r = await manual({ priceAcknowledged: true });
    expect(r.ok).toBe(false);
    expect(active()).toHaveLength(1);
    expect(acknowledged()).toBe(PRICE);
  });

  it("§6 Q2: a confirmed manual send with NO acknowledged price sends, and records the echoed price", async () => {
    setAcknowledged(null);
    expect(await manual()).toMatchObject({ ok: true });
    expect(acknowledged()).toBe(PRICE);
  });
});

describe("C7, C8 — the auto-pay price ceiling (D3)", () => {
  it("C7: auto, price above the acknowledged one → price_above_acknowledged, no send", async () => {
    setAcknowledged(40_000);
    const r = await auto();
    expect(r).toMatchObject({ ok: false, code: "price_above_acknowledged", acknowledged_price_sats: 40_000 });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });

  it("C8: auto, NO acknowledged price → price_unacknowledged, no send", async () => {
    setAcknowledged(null);
    const r = await auto();
    expect(r).toMatchObject({ ok: false, code: "price_unacknowledged", acknowledged_price_sats: null });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });

  it("permitting control: auto at the acknowledged price sends", async () => {
    expect(await auto()).toMatchObject({ ok: true });
  });
});

describe("C9 — the hold time (ruling 2: 48 hours, an env setting)", () => {
  it("defaults to 172800000 ms", () => {
    expect(ENV.autoPaySettlementAlertMs).toBe(172_800_000);
  });

  it("an active marker 49 hours old → settlement_overdue naming it; 47 hours old → settlement_pending", async () => {
    const old = insertMarker(49 * 3600);
    expect(await auto()).toMatchObject({ ok: false, code: "settlement_overdue", marker: { id: old } });
    db.prepare("DELETE FROM subscription_send_marker").run();
    insertMarker(47 * 3600);
    expect(await auto()).toMatchObject({ ok: false, code: "settlement_pending" });
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });
});

describe("C13 — ruling 3: what clears or keeps a marker is WHERE the error arose", () => {
  // One case per refusal, each asserting no marker directly: a marker left by
  // one refusal must not be able to show up as a different refusal later.
  it("status unavailable → no active marker", async () => {
    h.statusOk = false;
    expect(await manual()).toMatchObject({ code: "status_unavailable" });
    expect(active()).toHaveLength(0);
  });
  it("fee estimate failed → no active marker", async () => {
    h.feeThrows = new Error("unable to estimate fee");
    expect(await manual()).toMatchObject({ code: "fee_estimate_failed" });
    expect(active()).toHaveLength(0);
  });
  it("balance read failed → no active marker", async () => {
    h.balanceThrows = new Error("wallet locked");
    expect(await manual()).toMatchObject({ code: "send_failed" });
    expect(active()).toHaveLength(0);
  });
  it("balance below price + fee → no active marker, and the send is never called", async () => {
    h.balance = 0;
    expect(await manual()).toMatchObject({ code: "insufficient_funds" });
    expect(active()).toHaveLength(0);
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
  });

  it("an error from the send call keeps the marker active", async () => {
    h.sendThrows = new Error("rpc error: something unexpected");
    expect(await manual()).toMatchObject({ ok: false, code: "send_failed" });
    expect(active()).toHaveLength(1);
  });

  it("ruling 4: an 'insufficient funds' from the send call keeps the marker too — never decided by error text", async () => {
    h.sendThrows = new Error("insufficient funds available to construct transaction");
    expect(await manual()).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect(active()).toHaveLength(1);
  });
});

describe("C18 — a status without a numeric paid_through is refused before any marker (ruled 2026-11-09)", () => {
  // One assertion over three facts, so the control's red line shows them all:
  // the refusal's code, whether the send was called, and whether a marker is
  // still active after a LATER payment is credited (paid_through moves, and
  // last_payment_txid names that later payment, not this one). A marker
  // written with paid_through_at_write NULL survives that credit: the
  // paid_through clause needs a non-NULL value, and the txid clause needs
  // this payment's own txid.
  async function attemptThenLaterCredit(send: () => ReturnType<typeof execute>) {
    const r = await send();
    const sends = vi.mocked(lnd.sendLndToChainAddress).mock.calls.length;
    markers.clearMarkersOnCredit(db, PUB, { paid_through: 9_000_000, last_payment_txid: "txlater" }, nowSec());
    return { code: r.ok ? "sent" : r.code, sends, activeAfterLaterCredit: active().length };
  }
  const REFUSED = { code: "status_incomplete", sends: 0, activeAfterLaterCredit: 0 };

  it("manual, paid_through missing → status_incomplete, no send, no marker", async () => {
    const { paid_through: _omit, ...rest } = applicable();
    h.status = rest;
    expect(await attemptThenLaterCredit(() => manual())).toEqual(REFUSED);
  });

  it("manual, paid_through null → status_incomplete, no send, no marker", async () => {
    h.status = applicable({ paid_through: null });
    expect(await attemptThenLaterCredit(() => manual())).toEqual(REFUSED);
  });

  it("manual, paid_through not a number → status_incomplete, no send, no marker", async () => {
    h.status = applicable({ paid_through: "1000000" });
    expect(await attemptThenLaterCredit(() => manual())).toEqual(REFUSED);
  });

  it("auto, paid_through null → status_incomplete, no send, no marker", async () => {
    h.status = applicable({ paid_through: null });
    expect(await attemptThenLaterCredit(() => auto())).toEqual(REFUSED);
  });

  it("the refusal maps to HTTP 503 and carries the price for context", async () => {
    h.status = applicable({ paid_through: null });
    const r = await manual();
    expect(r).toMatchObject({ ok: false, code: "status_incomplete", price_sats: PRICE });
    expect(errorHttpStatus("status_incomplete")).toBe(503);
  });

  it("permitting control: the same send with a numeric paid_through goes, and its marker clears on the later credit", async () => {
    expect(await attemptThenLaterCredit(() => manual())).toEqual({
      code: "sent",
      sends: 1,
      activeAfterLaterCredit: 0,
    });
  });
});

describe("clearing on credit (§6 Q1(a)) — runs before the marker check", () => {
  it("a marker whose txid the status now shows as last_payment_txid clears, and auto-pay proceeds", async () => {
    insertMarker(60, "txpaid");
    h.status = applicable({ last_payment_txid: "txpaid" });
    expect(await auto()).toMatchObject({ ok: true });
  });

  it("a txid-less marker clears once paid_through moves past the one it recorded", async () => {
    insertMarker(60, null);
    h.status = applicable({ paid_through: 2_000_000 });
    expect(await auto()).toMatchObject({ ok: true });
  });

  it("no credit → the marker holds", async () => {
    insertMarker(60, "txpending");
    expect(await auto()).toMatchObject({ ok: false, code: "settlement_pending" });
  });
});
