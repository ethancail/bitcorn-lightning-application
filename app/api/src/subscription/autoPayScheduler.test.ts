// The auto-pay scheduler tick against a real (temp-file) database, with LND
// and the treasury status mocked: how the pay-from-node guards surface as
// auto-pay alerts (specs/2026-11-05-pay-from-node-spec.md §3.6, §4.2, §4.3,
// with the 2026-11-05 rulings).

import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-autopay-tick-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const h = vi.hoisted(() => ({ status: null as unknown, nextTxid: 1 }));

vi.mock("./memberStatusClient", () => ({
  fetchLocalSubscriptionStatus: async () => ({ ok: true, status: h.status }),
}));

// The cap is not under test here (treasury-price-trust's controls test it);
// its shipped value is owed, so inject one that bounds nothing these tests
// send. Not a proposal for SUBSCRIPTION_PRICE_CAP_SATS.
vi.mock("./priceCap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./priceCap")>()),
  SUBSCRIPTION_PRICE_CAP_SATS: Number.MAX_SAFE_INTEGER,
}));

vi.mock("../lightning/lnd", () => ({
  getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 2 })),
  getLndChainBalance: vi.fn(async () => ({ chain_balance: 1_000_000 })),
  sendLndToChainAddress: vi.fn(async () => ({ id: `tx${h.nextTxid++}` })),
}));

const PUB = "02member";
const ADDR = "bcrt1qdeposit";
const PRICE = 50_000;
const HOUR = 3600;

function status(over: Record<string, unknown> = {}) {
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
let tick: () => Promise<void>;
let lnd: typeof import("../lightning/lnd");
let markers: typeof import("./sendMarker");
let profile: typeof import("../profile/profileStore");
let alerts: typeof import("./autoPayAlertStore");

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, network, node_role, updated_at)
     VALUES (1, ?, 'regtest', 'member', 0)`,
  ).run(PUB);
  ({ runOnce: tick } = await import("./autoPayScheduler"));
  lnd = await import("../lightning/lnd");
  markers = await import("./sendMarker");
  profile = await import("../profile/profileStore");
  alerts = await import("./autoPayAlertStore");
});

beforeEach(() => {
  db.prepare("DELETE FROM subscription_send_marker").run();
  db.prepare("DELETE FROM subscription_autopay_alerts").run();
  db.prepare("DELETE FROM member_profile").run();
  db.prepare("DELETE FROM subscription_deposit_address_pin").run();
  h.status = status();
  h.nextTxid = 1;
  vi.mocked(lnd.sendLndToChainAddress).mockClear();
  optIn(PRICE);
});

function optIn(ackPrice: number | null): void {
  profile.setAutoPayEnabled(PUB, true, 1, ackPrice);
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
function rows(type?: string) {
  return (alerts.getAlertHistory(db, PUB) as Array<{ type: string; status: string; context: any; id: number }>)
    .filter((a) => !type || a.type === type);
}

describe("C3 — a young marker holds auto-pay silently", () => {
  it("no send and no alert row", async () => {
    insertMarker(HOUR, "tx0");
    await tick();
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
});

describe("C18 — a status without a numeric paid_through (ruled 2026-11-09)", () => {
  it("refuses: no send, no marker, no alert row, and one warning naming status_incomplete", async () => {
    h.status = status({ paid_through: null });
    vi.mocked(console.warn).mockClear();
    await tick();
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    expect(markers.listActiveMarkers(db, PUB)).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.filter((w) => w.includes("status_incomplete"))).toHaveLength(1);
  });
});

describe("C4 — dismissing the success alert does not lift the guard", () => {
  it("after a success, dismissing AUTOPAY_SUCCEEDED and ticking again sends nothing", async () => {
    await tick();
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(1);
    const [succeeded] = rows("AUTOPAY_SUCCEEDED");
    alerts.dismissAlert(db, PUB, succeeded!.id);
    await tick(); // still lapsed, cooldown lifted by the dismissal
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(1);
  });
});

describe("C8 — no acknowledged price: auto-pay refuses and raises the price alert with its own reason", () => {
  it("one AUTOPAY_PRICE_NOT_ACKNOWLEDGED row, reason no_acknowledged_price; no send", async () => {
    optIn(null);
    await tick();
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    const r = rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED");
    expect(r).toHaveLength(1);
    expect(r[0]!.context.reason).toBe("no_acknowledged_price");
  });
});

describe("C9 — the stale-marker alert", () => {
  it("a marker 49 hours old raises one AUTOPAY_SETTLEMENT_OVERDUE row naming it, and still no send", async () => {
    const id = insertMarker(49 * HOUR, "txstuck");
    await tick();
    await tick();
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    const r = rows("AUTOPAY_SETTLEMENT_OVERDUE");
    expect(r).toHaveLength(1);
    expect(r[0]!.context).toMatchObject({ marker_id: id, txid: "txstuck" });
  });

  it("a marker 47 hours old raises no row", async () => {
    insertMarker(47 * HOUR, "txstuck");
    await tick();
    expect(rows("AUTOPAY_SETTLEMENT_OVERDUE")).toHaveLength(0);
  });
});

describe("C10 — the price above the acknowledged one: auto-pay refuses and alerts", () => {
  it("one AUTOPAY_PRICE_NOT_ACKNOWLEDGED row, reason price_above_acknowledged; no send", async () => {
    optIn(40_000);
    await tick();
    expect(lnd.sendLndToChainAddress).not.toHaveBeenCalled();
    const r = rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED");
    expect(r).toHaveLength(1);
    expect(r[0]!.context).toMatchObject({ reason: "price_above_acknowledged", price_sats: PRICE, acknowledged_price_sats: 40_000 });
  });
});

describe("C14 — ruling 4: with auto-pay off, a stale marker raises no alert", () => {
  it("auto-pay off: no row", async () => {
    insertMarker(49 * HOUR, "txstuck");
    profile.setAutoPayEnabled(PUB, false, 1);
    await tick();
    expect(rows("AUTOPAY_SETTLEMENT_OVERDUE")).toHaveLength(0);
  });

  it("permitting control: auto-pay on, same marker → one row", async () => {
    insertMarker(49 * HOUR, "txstuck");
    await tick();
    expect(rows("AUTOPAY_SETTLEMENT_OVERDUE")).toHaveLength(1);
  });
});

describe("C16 — raised once per cause, through the tick", () => {
  it("a dismissed price alert is not re-raised on the next tick while its cause holds", async () => {
    optIn(40_000);
    await tick();
    const [row] = rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED");
    alerts.dismissAlert(db, PUB, row!.id);
    await tick();
    expect(rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED")).toHaveLength(1);
  });

  it("a further price rise is a new cause and raises a new row", async () => {
    optIn(40_000);
    await tick();
    h.status = status({ price_sats: 60_000 });
    await tick();
    expect(rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED")).toHaveLength(2);
  });
});

describe("C17 and C15 — each resolves when its cause clears, and then auto-pay sends", () => {
  it("the marker credited → the overdue row resolves, and the same tick sends", async () => {
    insertMarker(49 * HOUR, "txstuck");
    await tick();
    expect(rows("AUTOPAY_SETTLEMENT_OVERDUE")[0]!.status).toBe("active");
    h.status = status({ last_payment_txid: "txstuck" });
    await tick();
    expect(rows("AUTOPAY_SETTLEMENT_OVERDUE")[0]!.status).toBe("resolved");
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(1);
  });

  it("the price acknowledged → the price row resolves, and the next due tick sends", async () => {
    optIn(40_000);
    await tick();
    expect(rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED")[0]!.status).toBe("active");
    profile.acknowledgePrice(PUB, PRICE, nowSec());
    await tick();
    expect(rows("AUTOPAY_PRICE_NOT_ACKNOWLEDGED")[0]!.status).toBe("resolved");
    expect(lnd.sendLndToChainAddress).toHaveBeenCalledTimes(1);
  });
});
