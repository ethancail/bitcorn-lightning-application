// Negative controls C1–C7, C10 and C12 of bitcorn-research
// specs/2026-11-10-treasury-price-trust-spec.md §11.1, end to end on the
// member side: a fake treasury behind global fetch, a fake LND signer and
// verifier, the real database, the real executePayFromNode, the real auto-pay
// scheduler tick, the real auto-pay handlers and the real quote route.
//
// Written to load against the PRE-FIX code too (it drives only interfaces that
// existed before this arc), so each FIX control is shown red there first. The
// signed string is built HERE, independently of the production builder in
// challengeGrammar.ts, so a drift in either is a failure, not a tautology.
//
// Every negative case asserts "send not called" FIRST — the property under
// test — and carries an anti-vacuity case in the same test: the same fixture,
// correctly signed (or within the cap, or integer), DOES pay. A setup that
// could never pay would fail the anti-vacuity half.
//
// The test seam (spec §11.1): the fake verifier returns the signer's key only
// for a signature the fake signer made over that exact message, and otherwise
// a different pubkey, as real ECDSA recovery would.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-tpt-controls-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const h = vi.hoisted(() => {
  const TREASURY = "02" + "aa".repeat(32);
  process.env.TREASURY_PUBKEY = TREASURY;
  return {
    TREASURY,
    OTHER_SIGNER: "03" + "bb".repeat(32),
    MEMBER: "02" + "cc".repeat(32),
    OTHER_MEMBER: "02" + "dd".repeat(32),
    FOREIGN: "03" + "ee".repeat(32),
    // A TEST-ONLY cap, injected through the priceCap module. It is not a
    // proposal for SUBSCRIPTION_PRICE_CAP_SATS, whose value is Ethan's.
    TEST_CAP: 54_321,
    sigs: new Map<string, { key: string; message: string }>(),
    mode: "signed" as
      | "signed"
      | "unsigned"
      | "wrong_key"
      | "tamper"
      | "replay"
      | "other_member",
    body: {} as Record<string, unknown>,
    nextTxid: 1,
    fetchCalls: 0,
  };
});

vi.mock("../lightning/lnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lightning/lnd")>()),
  getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 2 })),
  getLndChainBalance: vi.fn(async () => ({ chain_balance: 10_000_000 })),
  sendLndToChainAddress: vi.fn(async () => ({ id: `tx${h.nextTxid++}` })),
  lndVerifyMessage: vi.fn(async (message: string, signature: string) => {
    const made = h.sigs.get(signature);
    return made && made.message === message ? made.key : h.FOREIGN;
  }),
}));

vi.mock("./tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tokenRefresh")>()),
  getCachedToken: () => ({
    member_pubkey: h.MEMBER,
    jwt: "jwt.for.member",
    scope: "payment",
    issued_at: 0,
    expires_at: Date.now() + 3_600_000,
    fetched_at: 0,
  }),
  getResolvedTreasuryBaseUrl: () => "https://treasury.test",
}));

vi.mock("./transitionObserver", () => ({ observeTierForTransition: vi.fn() }));

// Pre-fix nothing imports this module; post-fix every cap check reads it.
vi.mock("./priceCap", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SUBSCRIPTION_PRICE_CAP_SATS: h.TEST_CAP,
}));

const ZB32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
function fakeSign(key: string, message: string): string {
  const bytes = Buffer.concat([
    crypto.createHash("sha512").update(`${key}|${message}`).digest(),
    crypto.createHash("sha512").update(`${message}|${key}`).digest(),
  ]);
  let sig = "";
  for (let i = 0; i < 104; i++) sig += ZB32[bytes[i]! % 32];
  h.sigs.set(sig, { key, message });
  return sig;
}
const sha256hex = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
// Built here, not imported: an independent statement of spec §1.1.
const signedString = (member: string, nonce: string, digest: string) =>
  `bitcorn:treasury-status:v1:${member}:${nonce}:${digest}`;

function headerOf(init: any, name: string): string | undefined {
  const hs = init?.headers;
  if (!hs) return undefined;
  if (typeof hs.get === "function") return hs.get(name) ?? undefined;
  for (const k of Object.keys(hs)) if (k.toLowerCase() === name.toLowerCase()) return hs[k];
  return undefined;
}

async function fakeTreasury(_url: string, init?: any): Promise<Response> {
  h.fetchCalls++;
  const nonce = headerOf(init, "x-bitcorn-status-nonce") ?? "";
  let bytes = Buffer.from(JSON.stringify(h.body), "utf8");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const sign = (key: string, member: string, n: string, b: Buffer) =>
    fakeSign(key, signedString(member, n, sha256hex(b)));
  switch (h.mode) {
    case "signed":
      headers["X-Bitcorn-Status-Signature"] = sign(h.TREASURY, h.MEMBER, nonce, bytes);
      break;
    case "unsigned":
      break;
    case "wrong_key":
      headers["X-Bitcorn-Status-Signature"] = sign(h.OTHER_SIGNER, h.MEMBER, nonce, bytes);
      break;
    case "replay":
      // Correctly signed by the treasury, for an EARLIER request's nonce.
      headers["X-Bitcorn-Status-Signature"] = sign(h.TREASURY, h.MEMBER, "0".repeat(32), bytes);
      break;
    case "other_member":
      headers["X-Bitcorn-Status-Signature"] = sign(h.TREASURY, h.OTHER_MEMBER, nonce, bytes);
      break;
    case "tamper": {
      headers["X-Bitcorn-Status-Signature"] = sign(h.TREASURY, h.MEMBER, nonce, bytes);
      // Flip ONE byte after signing, inside the member_pubkey value: still
      // valid JSON, a field no payment check reads, so only the signature can
      // catch it.
      const s = bytes.toString("utf8");
      const at = s.indexOf(h.MEMBER) + 10;
      bytes = Buffer.from(s.slice(0, at) + (s[at] === "c" ? "d" : "c") + s.slice(at + 1), "utf8");
      break;
    }
  }
  return new Response(bytes, { status: 200, headers });
}

const ADDR_A = "bcrt1qpinnedaddressaaaa";
const ADDR_B = "bcrt1qnewaddressbbbbbbb";
const PRICE = 50_000;

function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicable: true,
    member_pubkey: h.MEMBER,
    current_tier: "worker_lapsed",
    paid_through: 1_000_000,
    price_sats: PRICE,
    period_days: 30,
    deposit_address: ADDR_A,
    last_payment_at: null,
    last_payment_txid: null,
    ...over,
  };
}

let db: import("better-sqlite3").Database;
let execute: typeof import("./payFromNode").executePayFromNode;
let errorHttpStatus: typeof import("./payFromNode").errorHttpStatus;
let runOnce: typeof import("./autoPayScheduler").runOnce;
let handlers: typeof import("./autoPayHandler");
let profile: typeof import("../profile/profileStore");
let markers: typeof import("./sendMarker");
let lnd: typeof import("../lightning/lnd");
let ENV: typeof import("../config/env").ENV;
let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(fakeTreasury));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ executePayFromNode: execute, errorHttpStatus } = await import("./payFromNode"));
  ({ runOnce } = await import("./autoPayScheduler"));
  handlers = await import("./autoPayHandler");
  profile = await import("../profile/profileStore");
  markers = await import("./sendMarker");
  lnd = await import("../lightning/lnd");
  ({ ENV } = await import("../config/env"));
  ({ handleRequest } = await import("../index"));
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, network, node_role, updated_at)
     VALUES (1, ?, 'regtest', 'member', 0)`,
  ).run(h.MEMBER);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function hasTable(name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

beforeEach(() => {
  db.prepare("DELETE FROM subscription_send_marker").run();
  db.prepare("DELETE FROM subscription_autopay_alerts").run();
  db.prepare("DELETE FROM member_profile").run();
  if (hasTable("subscription_deposit_address_pin")) {
    db.prepare("DELETE FROM subscription_deposit_address_pin").run();
  }
  h.mode = "signed";
  h.body = status();
  h.nextTxid = 1;
  ENV.treasuryPubkey = h.TREASURY;
  vi.mocked(lnd.sendLndToChainAddress).mockClear();
  // The member has accepted the current price (the D3 ceiling is not what
  // these controls test).
  profile.acknowledgePrice(h.MEMBER, PRICE, 1);
});

const sends = () => vi.mocked(lnd.sendLndToChainAddress).mock.calls;
const activeMarkers = () => markers.listActiveMarkers(db, h.MEMBER);

function manual(o: { amount?: number; address?: string; priceAck?: boolean } = {}) {
  return execute({
    origin: "manual",
    memberPubkey: h.MEMBER,
    expected: {
      amount_sats: o.amount ?? (h.body.price_sats as number),
      deposit_address: o.address ?? (h.body.deposit_address as string),
    },
    repeatAcknowledged: false,
    priceAcknowledged: o.priceAck ?? false,
  });
}

async function autoTick(): Promise<void> {
  profile.setAutoPayEnabled(h.MEMBER, true, 1, profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price ?? null);
  await runOnce();
}

function alertsOfType(type: string) {
  return db
    .prepare("SELECT * FROM subscription_autopay_alerts WHERE member_pubkey = ? AND type = ?")
    .all(h.MEMBER, type) as Array<{ status: string; context_json: string }>;
}

function getQuote(): Promise<{ status: number; body: any }> {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = "GET";
  (req as any).url = "/api/subscription/pay-from-node/quote";
  (req as any).headers = {};
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let code = 0;
    let chunks = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) { code = s; return res; },
      end(c?: any) {
        if (c) chunks += c.toString();
        let body: any = null;
        try { body = chunks ? JSON.parse(chunks) : null; } catch { body = chunks; }
        resolve({ status: code, body });
      },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => stream.end());
  });
}

/** The anti-vacuity half: the same fixture, signed, within the cap, pays. */
async function expectSignedManualPays(): Promise<void> {
  db.prepare("DELETE FROM subscription_send_marker").run();
  vi.mocked(lnd.sendLndToChainAddress).mockClear();
  h.mode = "signed";
  const r = await manual();
  expect(r.ok, `anti-vacuity: a correctly signed response must pay (${JSON.stringify(r)})`).toBe(true);
  expect(sends()).toHaveLength(1);
}

describe("C1 — tampered body byte", () => {
  it("one flipped byte → invalid; manual and auto refuse; nothing sent", async () => {
    h.mode = "tamper";
    const m = await manual();
    expect(sends(), "C1: a tampered body was paid (manual)").toHaveLength(0);
    expect(activeMarkers()).toHaveLength(0);
    expect(m.ok === false && m.code).toBe("status_unverified");
    expect((m as any).reason).toBe("invalid");

    await autoTick();
    expect(sends(), "C1: a tampered body was paid (auto)").toHaveLength(0);

    await expectSignedManualPays();
  });
});

describe("C2 — wrong signing key", () => {
  it("signed by a non-TREASURY_PUBKEY key → invalid; refuse; nothing sent", async () => {
    h.mode = "wrong_key";
    const m = await manual();
    expect(sends(), "C2: a foreign-signed body was paid (manual)").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("status_unverified");
    expect((m as any).reason).toBe("invalid");

    await autoTick();
    expect(sends(), "C2: a foreign-signed body was paid (auto)").toHaveLength(0);

    await expectSignedManualPays();
  });
});

describe("C3 — replayed old response", () => {
  it("signed for an earlier nonce → invalid; refuse; nothing sent", async () => {
    h.mode = "replay";
    const m = await manual();
    expect(sends(), "C3: a replayed response was paid").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("status_unverified");
    expect((m as any).reason).toBe("invalid");
    await expectSignedManualPays();
  });
});

describe("C3b — another member's response", () => {
  it("signed for another member's pubkey → invalid; refuse; nothing sent", async () => {
    h.mode = "other_member";
    const m = await manual();
    expect(sends(), "C3b: another member's response was paid").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("status_unverified");
    expect((m as any).reason).toBe("invalid");
    await expectSignedManualPays();
  });
});

describe("C4 — unsigned response", () => {
  it("manual 503 status_unverified (reason unsigned); auto raises AUTOPAY_STATUS_UNVERIFIED; quote refuses; ceiling not seeded; nothing sent", async () => {
    h.mode = "unsigned";
    const m = await manual();
    expect(sends(), "C4: an unsigned body was paid (manual)").toHaveLength(0);
    expect(activeMarkers()).toHaveLength(0);
    expect(m.ok === false && m.code).toBe("status_unverified");
    expect((m as any).reason).toBe("unsigned");
    expect(errorHttpStatus("status_unverified" as any)).toBe(503);

    await autoTick();
    expect(sends(), "C4: an unsigned body was paid (auto)").toHaveLength(0);
    const raised = alertsOfType("AUTOPAY_STATUS_UNVERIFIED").filter((a) => a.status === "active");
    expect(raised).toHaveLength(1);
    expect(JSON.parse(raised[0]!.context_json).verdict).toBe("unsigned");

    const q = await getQuote();
    expect(q.status, "C4: the quote served an unsigned target").toBe(503);
    expect(q.body.error).toBe("status_unverified");
    expect(q.body.reason).toBe("unsigned");

    db.prepare("DELETE FROM member_profile").run();
    await handlers.setAutoPay(h.MEMBER, true);
    expect(profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price ?? null, "C4: the ceiling was seeded from an unsigned body").toBeNull();

    // Anti-vacuity: signed, the same calls quote, seed and pay — and the
    // unverified alert resolves on the next verified status.
    h.mode = "signed";
    const q2 = await getQuote();
    expect(q2.status).toBe(200);
    db.prepare("DELETE FROM member_profile").run();
    await handlers.setAutoPay(h.MEMBER, true);
    expect(profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price).toBe(PRICE);
    h.body = status({ current_tier: "current" });
    await runOnce();
    expect(alertsOfType("AUTOPAY_STATUS_UNVERIFIED").filter((a) => a.status === "active")).toHaveLength(0);
    h.body = status();
    await expectSignedManualPays();
  });
});

describe("C5 — address change under auto-pay", () => {
  it("pin A; a verified response states B → auto refuses deposit_address_changed, alert raised, no pin row for B; nothing sent", async () => {
    // First sight of A (a verified read in a tier that does not fire).
    h.body = status({ current_tier: "current", deposit_address: ADDR_A });
    await autoTick();
    expect(sends()).toHaveLength(0);

    h.body = status({ deposit_address: ADDR_B });
    await autoTick();
    expect(sends(), "C5: auto-pay paid a changed address").toHaveLength(0);
    const raised = alertsOfType("AUTOPAY_PAY_TARGET_REFUSED").filter((a) => a.status === "active");
    expect(raised).toHaveLength(1);
    expect(JSON.parse(raised[0]!.context_json).reason).toBe("deposit_address_changed");
    const forB = db
      .prepare("SELECT COUNT(*) AS c FROM subscription_deposit_address_pin WHERE deposit_address = ?")
      .get(ADDR_B) as { c: number };
    expect(forB.c).toBe(0);

    // Anti-vacuity: the pinned address, verified, pays under auto.
    h.body = status({ deposit_address: ADDR_A });
    db.prepare("DELETE FROM subscription_autopay_alerts").run();
    await autoTick();
    expect(sends(), "anti-vacuity: auto must pay the pinned address").toHaveLength(1);
    expect(sends()[0]![0]).toBe(ADDR_A);
  });

  it("the manual send refuses deposit_address_changed too (409), and the quote carries both addresses", async () => {
    h.body = status({ current_tier: "current", deposit_address: ADDR_A });
    await runOnce();
    h.body = status({ deposit_address: ADDR_B });
    const m = await manual();
    expect(sends(), "a manual send paid a changed address").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("deposit_address_changed");
    expect(errorHttpStatus("deposit_address_changed" as any)).toBe(409);
    const q = await getQuote();
    expect(q.status).toBe(409);
    expect(q.body).toMatchObject({ error: "deposit_address_changed", pinned_address: ADDR_A, stated_address: ADDR_B });

    h.body = status({ deposit_address: ADDR_A });
    await expectSignedManualPays();
  });
});

describe("C6 — over-cap price", () => {
  it("verified price_sats = cap + 1 → manual, auto, quote, acknowledge and opt-in all refuse; nothing sent", async () => {
    const over = h.TEST_CAP + 1;
    h.body = status({ price_sats: over });
    profile.acknowledgePrice(h.MEMBER, over, 1); // so the D3 ceiling is not what refuses

    const m = await manual();
    expect(sends(), "C6: an over-cap price was paid (manual)").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("price_above_cap");
    expect(errorHttpStatus("price_above_cap" as any)).toBe(409);

    await autoTick();
    expect(sends(), "C6: an over-cap price was paid (auto)").toHaveLength(0);
    expect(alertsOfType("AUTOPAY_PAY_TARGET_REFUSED").some((a) => JSON.parse(a.context_json).reason === "price_above_cap")).toBe(true);

    const q = await getQuote();
    expect(q.status).toBe(409);
    expect(q.body).toMatchObject({ error: "price_above_cap", price_sats: over });

    db.prepare("DELETE FROM member_profile").run();
    const ack = await handlers.acknowledgePriceChange(h.MEMBER, over);
    expect(ack.ok).toBe(false);
    expect((ack as any).code).toBe("price_above_cap");
    expect(profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price ?? null, "C6: an over-cap price was acknowledged").toBeNull();

    await handlers.setAutoPay(h.MEMBER, true);
    expect(profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price ?? null, "C6: an over-cap price seeded the ceiling").toBeNull();

    // Anti-vacuity: exactly the cap pays.
    h.body = status({ price_sats: h.TEST_CAP });
    profile.acknowledgePrice(h.MEMBER, h.TEST_CAP, 1);
    await expectSignedManualPays();
  });
});

describe("C6b — the price acknowledgement does not lift the cap", () => {
  it("price_acknowledged: true with an over-cap price → still price_above_cap", async () => {
    h.body = status({ price_sats: h.TEST_CAP + 1 });
    const m = await manual({ priceAck: true });
    expect(sends(), "C6b: price_acknowledged lifted the cap").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("price_above_cap");

    h.body = status({ price_sats: h.TEST_CAP });
    const ok = await manual({ priceAck: true });
    expect(ok.ok, "anti-vacuity: price_acknowledged at the cap pays").toBe(true);
    expect(sends()).toHaveLength(1);
  });
});

describe("C7 — fractional price", () => {
  it("verified price_sats = 50000.5 → price_not_integer wherever C6 checks; nothing sent", async () => {
    const frac = PRICE + 0.5;
    h.body = status({ price_sats: frac });
    profile.acknowledgePrice(h.MEMBER, PRICE + 1, 1);

    const m = await manual();
    expect(sends(), "C7: a fractional price was paid (manual)").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("price_not_integer");

    await autoTick();
    expect(sends(), "C7: a fractional price was paid (auto)").toHaveLength(0);

    const q = await getQuote();
    expect(q.status).toBe(409);
    expect(q.body.error).toBe("price_not_integer");

    db.prepare("DELETE FROM member_profile").run();
    const ack = await handlers.acknowledgePriceChange(h.MEMBER, frac);
    expect((ack as any).code).toBe("price_not_integer");
    expect(profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price ?? null).toBeNull();
    await handlers.setAutoPay(h.MEMBER, true);
    expect(profile.getMemberProfile(h.MEMBER)?.last_acknowledged_price ?? null, "C7: a fractional price seeded the ceiling").toBeNull();

    h.body = status();
    profile.acknowledgePrice(h.MEMBER, PRICE, 1);
    await expectSignedManualPays();
  });
});

describe("C10 — an unverified status clears no marker", () => {
  it("a forged credit on an unsigned status leaves the marker active (scheduler and send path)", async () => {
    const id = markers.writeMarker(db, {
      member_pubkey: h.MEMBER,
      origin: "manual",
      amount_sats: PRICE,
      deposit_address: ADDR_A,
      paid_through_at_write: 1_000_000,
      last_payment_txid_at_write: null,
      created_at: Math.floor(Date.now() / 1000),
    });
    h.mode = "unsigned";
    h.body = status({ paid_through: 9_999_999 }); // a credit past the marker
    await autoTick();
    await manual();
    expect(activeMarkers().map((m) => m.id), "C10: an unsigned credit cleared the guard").toEqual([id]);
    expect(sends()).toHaveLength(0);

    // Anti-vacuity: the same credit, signed, clears it.
    h.mode = "signed";
    h.body = status({ current_tier: "current", paid_through: 9_999_999 });
    await runOnce();
    expect(activeMarkers(), "anti-vacuity: a verified credit must clear the marker").toHaveLength(0);
  });
});

describe("C12 — TREASURY_PUBKEY unset", () => {
  it("→ unverifiable (key_unset); refuse; nothing sent", async () => {
    ENV.treasuryPubkey = "";
    const m = await manual();
    expect(sends(), "C12: paid with no pinned treasury key").toHaveLength(0);
    expect(m.ok === false && m.code).toBe("status_unverified");
    expect((m as any).reason).toBe("unverifiable");
    expect((m as any).verification_reason).toBe("key_unset");

    ENV.treasuryPubkey = h.TREASURY;
    await expectSignedManualPays();
  });
});
