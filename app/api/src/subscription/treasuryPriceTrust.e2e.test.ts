// treasury-price-trust, end to end through BOTH real ends (bitcorn-research
// specs/2026-11-10-treasury-price-trust-spec.md §1–§3; controls C1, C2, C3,
// C3b, C4 as the spec's mutations define them).
//
// treasuryPriceTrust.controls.test.ts uses an independent fake treasury, so a
// change to the shared builder (challengeGrammar.ts) breaks it at the
// anti-vacuity half. The spec's C1/C3/C3b mutations change the builder at BOTH
// ends; to see them fail for the right reason ("the tampered body now
// verifies") both ends must use it. Here they do: the member's real verifying
// fetch calls the REAL treasury handler — node role switched to treasury for
// the handler and back — through a fetch that can tamper, replay, swap the
// member, strip the nonce or change the treasury's LND key in transit.
//
// LND is faked at lnd.ts: the fake verifier returns the signer's key only for a
// signature the fake signer made over that exact message, else another key.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-tpt-e2e-"));
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
    sigs: new Map<string, { key: string; message: string }>(),
    treasuryLndKey: "",
    mode: "honest" as "honest" | "tamper" | "replay" | "other_member" | "old_treasury",
    stored: null as null | { status: number; headers: Record<string, string>; bytes: Buffer },
    nextTxid: 1,
  };
});

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

vi.mock("../lightning/lnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lightning/lnd")>()),
  lndSignMessage: vi.fn(async (message: string) => fakeSign(h.treasuryLndKey, message)),
  lndVerifyMessage: vi.fn(async (message: string, signature: string) => {
    const made = h.sigs.get(signature);
    return made && made.message === message ? made.key : h.FOREIGN;
  }),
  getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 2 })),
  getLndChainBalance: vi.fn(async () => ({ chain_balance: 10_000_000 })),
  sendLndToChainAddress: vi.fn(async () => ({ id: `tx${h.nextTxid++}` })),
}));
vi.mock("./jwtVerify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jwtVerify")>()),
  verifyEntitlementToken: vi.fn(async (bearer: string) => ({ sub: bearer.slice(4), scope: "payment", iat: 0, exp: 0 })),
}));
vi.mock("./tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tokenRefresh")>()),
  getCachedToken: () => ({ member_pubkey: h.MEMBER, jwt: `jwt.${h.MEMBER}`, scope: "payment", issued_at: 0, expires_at: 0, fetched_at: 0 }),
  getResolvedTreasuryBaseUrl: () => "https://treasury.test",
}));
vi.mock("./transitionObserver", () => ({ observeTierForTransition: vi.fn() }));
// The cap is not under test here; the shipped value is owed.
vi.mock("./priceCap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./priceCap")>()),
  SUBSCRIPTION_PRICE_CAP_SATS: Number.MAX_SAFE_INTEGER,
}));

let db: import("better-sqlite3").Database;
let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let execute: typeof import("./payFromNode").executePayFromNode;
let lnd: typeof import("../lightning/lnd");
let PRICE: number;
const ADDR = "bcrt1qmembersownaddress";
const ADDR_OTHER = "bcrt1qanothermembersaddr";

function asNode(pubkey: string, role: "member" | "treasury") {
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, network, node_role, updated_at) VALUES (1, ?, 'regtest', ?, 0)`,
  ).run(pubkey, role);
}

/** The REAL treasury handler, called as the treasury node. */
function callTreasury(headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> {
  asNode(h.TREASURY, "treasury");
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = "GET";
  (req as any).url = "/api/subscription/status";
  (req as any).headers = headers;
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let out: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number, hs?: Record<string, string>) { status = s; out = { ...(hs ?? {}) }; return res; },
      write(c: any) { if (c) chunks.push(Buffer.from(c)); return true; },
      end(c?: any) {
        if (c) chunks.push(Buffer.from(c));
        asNode(h.MEMBER, "member");
        resolve({ status, headers: out, bytes: Buffer.concat(chunks) });
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => stream.end());
  });
}

/** The wire between the member and the treasury. */
async function wire(_url: string, init?: any): Promise<Response> {
  const sent = { ...(init?.headers ?? {}) } as Record<string, string>;
  const toTreasury: Record<string, string> = {
    authorization: sent.Authorization ?? sent.authorization ?? "",
    "x-bitcorn-status-nonce": sent["x-bitcorn-status-nonce"] ?? "",
  };
  if (h.mode === "old_treasury") delete toTreasury["x-bitcorn-status-nonce"];
  if (h.mode === "other_member") toTreasury.authorization = `Bearer jwt.${h.OTHER_MEMBER}`;
  let r = h.mode === "replay" && h.stored ? h.stored : await callTreasury(toTreasury);
  if (h.mode === "replay" && !h.stored) h.stored = r;
  if (h.mode === "tamper") {
    const s = r.bytes.toString("utf8");
    const at = s.indexOf(h.MEMBER) + 10;
    r = { ...r, bytes: Buffer.from(s.slice(0, at) + (s[at] === "c" ? "d" : "c") + s.slice(at + 1), "utf8") };
  }
  return new Response(r.bytes, { status: r.status, headers: r.headers });
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(wire));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ handleRequest } = await import("../index"));
  ({ executePayFromNode: execute } = await import("./payFromNode"));
  lnd = await import("../lightning/lnd");
  PRICE = (db.prepare("SELECT price_sats FROM subscription_policy WHERE id = 1").get() as { price_sats: number }).price_sats;
  for (const [pk, addr] of [[h.MEMBER, ADDR], [h.OTHER_MEMBER, ADDR_OTHER]]) {
    db.prepare(
      `INSERT OR REPLACE INTO subscription (member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier)
       VALUES (?, ?, 'bitcorn:subscription:e2e', 1000, 0, 'worker_lapsed')`,
    ).run(pk, addr);
  }
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  db.prepare("DELETE FROM subscription_send_marker").run();
  // Guarded so this file also loads against the pre-fix schema (no 083).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_deposit_address_pin'").get()) {
    db.prepare("DELETE FROM subscription_deposit_address_pin").run();
  }
  db.prepare("DELETE FROM member_profile").run();
  asNode(h.MEMBER, "member");
  h.mode = "honest";
  h.stored = null;
  h.treasuryLndKey = h.TREASURY;
  vi.mocked(lnd.sendLndToChainAddress).mockClear();
  const profile = await import("../profile/profileStore");
  profile.acknowledgePrice(h.MEMBER, PRICE, 1);
});

const sends = () => vi.mocked(lnd.sendLndToChainAddress).mock.calls;
const manual = (address = ADDR) =>
  execute({
    origin: "manual",
    memberPubkey: h.MEMBER,
    expected: { amount_sats: PRICE, deposit_address: address },
    repeatAcknowledged: false,
    priceAcknowledged: false,
  });

async function honestPays() {
  db.prepare("DELETE FROM subscription_send_marker").run();
  vi.mocked(lnd.sendLndToChainAddress).mockClear();
  h.mode = "honest";
  h.treasuryLndKey = h.TREASURY;
  const r = await manual();
  expect(r.ok, `anti-vacuity: the real treasury's honest response must pay (${JSON.stringify(r)})`).toBe(true);
  expect(sends()).toHaveLength(1);
}

describe("both real ends", () => {
  it("C1 e2e: a byte flipped in transit after the treasury signed → invalid, nothing sent", async () => {
    h.mode = "tamper";
    const r = await manual();
    expect(sends(), "C1: the tampered body now verifies and pays").toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: "status_unverified", reason: "invalid" });
    await honestPays();
  });

  it("C2 e2e: the treasury's LND key is not TREASURY_PUBKEY → invalid, nothing sent", async () => {
    h.treasuryLndKey = h.OTHER_SIGNER;
    const r = await manual();
    expect(sends(), "C2: a foreign key's signature now verifies and pays").toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: "status_unverified", reason: "invalid" });
    await honestPays();
  });

  it("C3 e2e: the treasury's honest response, replayed to a later request → invalid, nothing sent", async () => {
    h.mode = "replay";
    await manual(); // primes the stored response (signed for the first nonce); refused or paid, then:
    db.prepare("DELETE FROM subscription_send_marker").run();
    vi.mocked(lnd.sendLndToChainAddress).mockClear();
    const r = await manual();
    expect(sends(), "C3: the replay now verifies and pays").toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: "status_unverified", reason: "invalid" });
    h.stored = null;
    await honestPays();
  });

  it("C3b e2e: the treasury's honest response for ANOTHER member → invalid, nothing sent", async () => {
    h.mode = "other_member";
    const r = await manual(ADDR_OTHER);
    expect(sends(), "C3b: another member's response now verifies and pays").toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: "status_unverified", reason: "invalid" });
    await honestPays();
  });

  it("C4 e2e: an old treasury (ignores the nonce, signs nothing) → unsigned, nothing sent", async () => {
    h.mode = "old_treasury";
    const r = await manual();
    expect(sends(), "C4: an unsigned body now pays").toHaveLength(0);
    expect(r).toMatchObject({ ok: false, code: "status_unverified", reason: "unsigned" });
    await honestPays();
  });
});
