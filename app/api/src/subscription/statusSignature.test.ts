// The signed status response, both ends (bitcorn-research specs/2026-11-10-
// treasury-price-trust-spec.md §1–§4, §10; controls C8, C9).
//
// The treasury side runs through the real GET /api/subscription/status
// handler on a treasury node; the member side through the real proxy on a
// member node, against a fake treasury behind global fetch. LND is faked at
// the lnd.ts boundary: the fake verifier returns the signer's key only for a
// signature the fake signer made over that exact message, otherwise another
// key, as real ECDSA recovery would. The signed string is built HERE.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-status-sig-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const h = vi.hoisted(() => {
  const TREASURY = "02" + "aa".repeat(32);
  process.env.TREASURY_PUBKEY = TREASURY;
  return {
    TREASURY,
    MEMBER: "02" + "cc".repeat(32),
    OTHER: "02" + "dd".repeat(32),
    FOREIGN: "03" + "ee".repeat(32),
    sigs: new Map<string, { key: string; message: string }>(),
    signThrows: false,
    signKey: "",
    // fake treasury, for the member-proxy cases
    upstream: { mode: "signed" as "signed" | "unsigned", body: {} as Record<string, unknown>, status: 200, signFor: "" },
    observed: [] as string[],
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
const fakeVerify = async (message: string, signature: string) => {
  const made = h.sigs.get(signature);
  return made && made.message === message ? made.key : h.FOREIGN;
};
const sha256hex = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const signedString = (member: string, nonce: string, digest: string) =>
  `bitcorn:treasury-status:v1:${member}:${nonce}:${digest}`;

vi.mock("../lightning/lnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lightning/lnd")>()),
  lndSignMessage: vi.fn(async (message: string) => {
    if (h.signThrows) throw new Error("DeadlineExceeded");
    return fakeSign(h.signKey, message);
  }),
  lndVerifyMessage: vi.fn(async (m: string, s: string) => fakeVerify(m, s)),
}));
vi.mock("./jwtVerify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jwtVerify")>()),
  // A bearer "jwt.<pubkey>" verifies as that subject.
  verifyEntitlementToken: vi.fn(async (bearer: string) => ({ sub: bearer.slice(4), scope: "payment", iat: 0, exp: 0 })),
}));
vi.mock("./tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tokenRefresh")>()),
  getCachedToken: () => ({ member_pubkey: h.MEMBER, jwt: `jwt.${h.MEMBER}`, scope: "payment", issued_at: 0, expires_at: 0, fetched_at: 0 }),
  getResolvedTreasuryBaseUrl: () => "https://treasury.test",
}));
vi.mock("./transitionObserver", () => ({
  observeTierForTransition: vi.fn((tier: string) => h.observed.push(tier)),
}));

import { buildSignedStatusResponse, parseStatusBytes, verifyStatusBytes } from "./statusSignature";

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: import("better-sqlite3").Database;
let computeSubscriptionStatusForPubkey: typeof import("./statusHandler").computeSubscriptionStatusForPubkey;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: any) => {
    const nonce = init?.headers?.["x-bitcorn-status-nonce"] ?? "";
    const bytes = Buffer.from(JSON.stringify(h.upstream.body), "utf8");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (h.upstream.mode === "signed") {
      headers["X-Bitcorn-Status-Signature"] = fakeSign(h.TREASURY, signedString(h.upstream.signFor, nonce, sha256hex(bytes)));
    }
    return new Response(bytes, { status: h.upstream.status, headers });
  }));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ handleRequest } = await import("../index"));
  ({ computeSubscriptionStatusForPubkey } = await import("./statusHandler"));
});

afterAll(() => vi.unstubAllGlobals());

function asNode(pubkey: string, role: "member" | "treasury") {
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, network, node_role, updated_at) VALUES (1, ?, 'regtest', ?, 0)`,
  ).run(pubkey, role);
}

function call(headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = "GET";
  (req as any).url = "/api/subscription/status";
  (req as any).headers = headers;
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let outHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number, hs?: Record<string, string>) { status = s; outHeaders = { ...(hs ?? {}) }; return res; },
      write(c: any) { if (c) chunks.push(Buffer.from(c)); return true; },
      end(c?: any) {
        if (c) chunks.push(Buffer.from(c));
        resolve({ status, headers: outHeaders, bytes: Buffer.concat(chunks) });
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => stream.end());
  });
}

beforeEach(() => {
  h.signThrows = false;
  h.observed = [];
  h.upstream = { mode: "signed", body: {}, status: 200, signFor: h.MEMBER };
});

// ─── The verdict (pure) ─────────────────────────────────────────────────────

describe("verifyStatusBytes", () => {
  const bytes = Buffer.from('{"applicable":true}');
  const nonce = "1f".repeat(16);
  const good = () => fakeSign(h.TREASURY, signedString(h.MEMBER, nonce, sha256hex(bytes)));
  const base = () => ({
    bytes,
    signatureHeader: good(),
    expectedTreasuryKey: h.TREASURY,
    expectedMemberPubkey: h.MEMBER,
    nonce,
    verify: fakeVerify,
  });

  it("verified for the treasury's signature over these bytes, this member, this nonce", async () => {
    expect(await verifyStatusBytes(base())).toEqual({ verdict: "verified" });
  });

  it("unsigned without a header; invalid for a header that is not an LND signature (LND not asked)", async () => {
    expect(await verifyStatusBytes({ ...base(), signatureHeader: null })).toEqual({ verdict: "unsigned" });
    const verify = vi.fn(fakeVerify);
    const r = await verifyStatusBytes({ ...base(), signatureHeader: "not-a-signature", verify });
    expect(r.verdict).toBe("invalid");
    expect(verify).not.toHaveBeenCalled();
  });

  it("LND recovering no signer is invalid; an LND outage is unverifiable (lnd_unavailable)", async () => {
    const noSigner = await verifyStatusBytes({
      ...base(),
      verify: async () => { throw [503, "ExpectedPublicKeyInVerifyMessageResponse"]; },
    });
    expect(noSigner.verdict).toBe("invalid");
    const down = await verifyStatusBytes({
      ...base(),
      verify: async () => { throw new Error("14 UNAVAILABLE: No connection established"); },
    });
    expect(down).toMatchObject({ verdict: "unverifiable", reason: "lnd_unavailable" });
  });

  it("C12: no usable treasury key is unverifiable (key_unset) — never a fallback to the signer", async () => {
    for (const key of ["", undefined, "02abc", "zz".repeat(33)]) {
      expect(await verifyStatusBytes({ ...base(), expectedTreasuryKey: key }), String(key)).toMatchObject({
        verdict: "unverifiable",
        reason: "key_unset",
      });
    }
    // Anti-vacuity: the same signature with the key set verifies.
    expect((await verifyStatusBytes(base())).verdict).toBe("verified");
  });
});

// ─── Treasury side: C8, C9 ──────────────────────────────────────────────────

describe("the treasury signs its status response (spec §2)", () => {
  beforeEach(() => {
    asNode(h.TREASURY, "treasury");
    h.signKey = h.TREASURY;
  });

  it("a nonce-carrying request is signed over the exact body bytes, for the JWT's subject", async () => {
    const nonce = "a1".repeat(16);
    const r = await call({ authorization: `Bearer jwt.${h.MEMBER}`, "x-bitcorn-status-nonce": nonce });
    expect(r.status).toBe(200);
    const sig = r.headers["X-Bitcorn-Status-Signature"];
    expect(sig).toBeTruthy();
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(r.headers["Content-Length"]).toBe(String(r.bytes.length));
    expect(await fakeVerify(signedString(h.MEMBER, nonce, sha256hex(r.bytes)), sig!)).toBe(h.TREASURY);
  });

  it("C9: a nonce-less request gets byte-identical body bytes to the old handler's, and no signature", async () => {
    const r = await call({ authorization: `Bearer jwt.${h.MEMBER}` });
    expect(r.status).toBe(200);
    // The old handler: res.end(JSON.stringify(computeSubscriptionStatusForPubkey(sub))).
    const old = Buffer.from(JSON.stringify(computeSubscriptionStatusForPubkey(h.MEMBER)), "utf8");
    expect(r.bytes.equals(old), `body changed:\n${r.bytes}\nvs\n${old}`).toBe(true);
    expect(r.headers["X-Bitcorn-Status-Signature"]).toBeUndefined();
    expect(r.headers["Content-Type"]).toBe("application/json");
    // A malformed nonce is the same old-member path.
    const m = await call({ authorization: `Bearer jwt.${h.MEMBER}`, "x-bitcorn-status-nonce": "XYZ" });
    expect(m.bytes.equals(old)).toBe(true);
    expect(m.headers["X-Bitcorn-Status-Signature"]).toBeUndefined();
  });

  it("C8: signing fails → 200, the same body bytes, no signature header, one log line", async () => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    h.signThrows = true;
    const r = await call({ authorization: `Bearer jwt.${h.MEMBER}`, "x-bitcorn-status-nonce": "b2".repeat(16) });
    expect(r.status, "C8: a signing failure broke the status").toBe(200);
    const old = Buffer.from(JSON.stringify(computeSubscriptionStatusForPubkey(h.MEMBER)), "utf8");
    expect(r.bytes.equals(old)).toBe(true);
    expect(r.headers["X-Bitcorn-Status-Signature"]).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[subscription] status signing failed:"))).toHaveLength(1);
    // Anti-vacuity: signing back, the same request is signed.
    h.signThrows = false;
    const ok = await call({ authorization: `Bearer jwt.${h.MEMBER}`, "x-bitcorn-status-nonce": "b2".repeat(16) });
    expect(ok.headers["X-Bitcorn-Status-Signature"]).toBeTruthy();
  });

  it("buildSignedStatusResponse lowercases the member it signs for", async () => {
    const r = await buildSignedStatusResponse({
      payload: { a: 1 },
      memberPubkey: h.MEMBER.toUpperCase(),
      nonceHeader: "c3".repeat(16),
      sign: async (m) => m,
    });
    expect(r.headers["X-Bitcorn-Status-Signature"]).toBe(signedString(h.MEMBER, "c3".repeat(16), sha256hex(r.body)));
  });
});

// ─── Member side: the one verifying fetch ───────────────────────────────────

describe("fetchVerifiedTreasuryStatus (spec §3.1)", () => {
  beforeEach(() => {
    asNode(h.MEMBER, "member");
    db.prepare("DELETE FROM subscription_deposit_address_pin").run();
    h.upstream.body = { applicable: true, deposit_address: "bcrt1qfirstsight", price_sats: 1 };
  });
  const pins = () => db.prepare("SELECT deposit_address, source FROM subscription_deposit_address_pin").all();

  it("an unverified result carries the verdict and the bytes, and NO `status` field; it writes no pin", async () => {
    const { fetchLocalSubscriptionStatus } = await import("./memberStatusClient");
    h.upstream.mode = "unsigned";
    const r = await fetchLocalSubscriptionStatus();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: "status_unverified", verdict: "unsigned" });
    expect("status" in r, "an unverified result exposed a parsed body").toBe(false);
    expect(pins(), "a pin was written from an unverified body").toEqual([]);

    // Anti-vacuity: verified, the parsed body is there and the first-sight pin is written.
    h.upstream.mode = "signed";
    const ok = await fetchLocalSubscriptionStatus();
    expect(ok.ok && ok.status).toMatchObject({ deposit_address: "bcrt1qfirstsight" });
    expect(pins()).toEqual([{ deposit_address: "bcrt1qfirstsight", source: "first_sight" }]);
  });

  it("a verified body that is not JSON is status_malformed (unreachable), not a parse of garbage", async () => {
    const { fetchVerifiedTreasuryStatus } = await import("./memberStatusClient");
    const nonce = "d4".repeat(16);
    const bytes = Buffer.from("\xff\xfe not json", "latin1");
    vi.mocked(fetch).mockImplementationOnce(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "X-Bitcorn-Status-Signature": fakeSign(h.TREASURY, signedString(h.MEMBER, nonce, sha256hex(bytes))) },
      }),
    );
    const r = await fetchVerifiedTreasuryStatus(
      { bearer: "b", treasuryBase: "https://t.test", expectedMemberPubkey: h.MEMBER },
      { nonce: () => nonce },
    );
    expect(r).toMatchObject({ ok: false, code: "treasury_unreachable", detail: "status_malformed" });
  });

  it("the cached token's subject IS this node's pubkey: a token minted for a challenge's key carries it, lowercased, as sub, and the fetch expects exactly that", async () => {
    db.prepare("DELETE FROM subscription").run();
    db.prepare(
      `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier)
       VALUES (?, 'bcrt1qsub', 'bitcorn:subscription:test', 0, 0, 'current')`,
    ).run(h.MEMBER);
    const { issueTokenForPubkey } = await import("./tokenIssuance");
    const minted = await issueTokenForPubkey(h.MEMBER.toUpperCase());
    expect(minted.kind).toBe("minted");
    const jwt = (minted as { token: { jwt: string } }).token.jwt;
    const sub = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")).sub;
    expect(sub).toBe(h.MEMBER);
    // tokenRefresh mints for the lowercased LND key and stores it as the
    // token's member_pubkey (tokenRefresh.ts refreshLocalToken); the verifying
    // fetch expects lnd_node_info's key, lowercased — the same key.
    asNode(h.MEMBER.toUpperCase(), "member");
    const { ownNodePubkey } = await import("./memberStatusClient");
    expect(await ownNodePubkey()).toBe(sub);
  });
});

// ─── Member side: the proxy labels for display (R3) ─────────────────────────

describe("the member's status proxy (spec §4 R3)", () => {
  beforeEach(() => {
    asNode(h.MEMBER, "member");
    h.upstream.body = {
      applicable: true,
      member_pubkey: h.MEMBER,
      current_tier: "worker_lapsed",
      price_sats: 50_000,
      deposit_address: "bcrt1qproxy",
      paid_through: 1,
      // A treasury cannot pre-label its own body: the proxy overwrites these.
      treasury_signature: "verified",
      treasury_pay_refusal: null,
    };
  });

  it("an unsigned body is shown for display, labelled unsigned (overwriting the treasury's own field); the observer does not fire", async () => {
    h.upstream.mode = "unsigned";
    const r = await call({});
    expect(r.status).toBe(200);
    const body = parseStatusBytes(r.bytes)!;
    expect(body.treasury_signature, "the treasury's own label survived").toBe("unsigned");
    expect(body.current_tier).toBe("worker_lapsed");
    expect(h.observed).toEqual([]);
    // Anti-vacuity: signed, the label is verified and the observer fires.
    h.upstream.mode = "signed";
    const ok = parseStatusBytes((await call({})).bytes)!;
    expect(ok.treasury_signature).toBe("verified");
    expect(h.observed).toEqual(["worker_lapsed"]);
  });

  it("a header bearer is verified against ITS subject, not this node", async () => {
    h.upstream.signFor = h.OTHER;
    const forOther = parseStatusBytes((await call({ authorization: `Bearer jwt.${h.OTHER}` })).bytes)!;
    expect(forOther.treasury_signature).toBe("verified");
    // The same response, read through this node's cached token, is invalid.
    const forSelf = parseStatusBytes((await call({})).bytes)!;
    expect(forSelf.treasury_signature).toBe("invalid");
  });

  it("a treasury non-2xx is forwarded as before, status and body", async () => {
    h.upstream.status = 401;
    h.upstream.body = { error: "expired" };
    const r = await call({});
    expect(r.status).toBe(401);
    expect(parseStatusBytes(r.bytes)).toEqual({ error: "expired" });
  });
});
