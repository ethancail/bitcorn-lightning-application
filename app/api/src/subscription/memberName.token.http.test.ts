// POST /api/subscription/token — the member's Bitcorn-level name carried under
// a second signature, driven through the real exported handleRequest against a
// temp-dir DB built by the real migration runner.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §3, §5, §6.2, §12 P1-P9, P13 (treasury half). Decision D8.
//
// ⚠ THE PERMITTING CONTROL LEADS (§12 P1). Before this file the carrier had
// ZERO tests. Everything else here forbids something — a store, a revert, a
// signature — and a suite of forbidding tests passes against a handler that
// has stopped minting. P1 is the one that says the old grammar still works.
//
// ⚠ PRE-CHANGE RUN (§12 P1, P3): run against fc32f57 before any of this
// existed. P1's mint half and P3 are GREEN there — the old handler mints for
// the old grammar and ignores the two new fields. Everything that reads
// member_private_name or name_status is red there, for that reason.
//
// ⚠ NO LND. lndVerifyMessage is a deterministic double at the lnd.ts wrapper
// boundary: a "signature over string S by key K" recovers K ONLY for exactly S.
// Over any other string it recovers a different key — what real
// ecdsa.RecoverCompact does (LND rpcserver.go VerifyMessage), not a throw.
//
// ⚠ THE SIGNED STRING IS HARDCODED HERE, not imported from challengeGrammar.ts:
// a test that imports the builder it checks cannot notice the bytes changing.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-name-token-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;

const MEMBER = "03" + "aa".repeat(32);
const OTHER_KEY = "02" + "ee".repeat(32); // what a signature recovers over the WRONG string

const lnd = vi.hoisted(() => ({
  verifyCalls: [] as string[],
  // Returns true to make lndVerifyMessage throw for that message.
  throwFor: null as null | ((message: string) => boolean),
}));

/** A fake zbase32-ish signature: opaque to the handler, decodable by the double. */
function sign(pubkey: string, message: string): string {
  return "fakesig" + Buffer.from(JSON.stringify([pubkey, message])).toString("base64");
}

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    lndVerifyMessage: async (message: string, signature: string) => {
      lnd.verifyCalls.push(message);
      if (lnd.throwFor?.(message)) throw new Error("lnd unreachable");
      if (!signature.startsWith("fakesig")) throw new Error("failed to decode signature");
      const [pubkey, signed] = JSON.parse(Buffer.from(signature.slice(7), "base64").toString()) as [string, string];
      return signed === message ? pubkey : OTHER_KEY;
    },
  };
});

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: Database.Database;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
});

const hasStore = () =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='member_private_name'").get();

beforeEach(() => {
  lnd.verifyCalls = [];
  lnd.throwFor = null;
  db.prepare("DELETE FROM subscription").run();
  db.prepare("DELETE FROM blocked_aliases").run();
  if (hasStore()) db.prepare("DELETE FROM member_private_name").run();
  // A subscribed member at `current`, so minting needs no allocation path.
  db.prepare(
    `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier)
     VALUES (?, 'bcrt1qtest', 'bitcorn:subscription:test', 0, 0, 'current')`,
  ).run(MEMBER);
});

type Captured = { status: number; body: any };

function post(body: unknown): Promise<Captured> {
  return call("POST", "/api/subscription/token", body);
}

function call(method: string, url: string, body?: unknown): Promise<Captured> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { "content-type": "application/json" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let parsed: any = null;
      try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = null; }
      resolve({ status, body: parsed });
    };
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) { status = s; return res; },
      end(c?: any) { if (c) chunks += c.toString(); finish(); },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => { (req as unknown as PassThrough).end(raw); });
    setTimeout(() => { if (!done) { status = -1; finish(); } }, 4000);
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);
const challengeAt = (ts: number, pubkey = MEMBER) => `bitcorn:token-request:${pubkey}:${ts}`;
// §3 — hardcoded on purpose (see header).
const nameString = (challenge: string, name: string) => `bitcorn:member-name:${challenge}:${name}`;

/** An old-grammar request: exactly what every member sent before D8. */
function oldRequest(ts = nowSec(), pubkey = MEMBER) {
  const challenge = challengeAt(ts, pubkey);
  return { challenge, signature: sign(pubkey, challenge) };
}

/** A new-grammar request: the challenge plus the name under its own signature. */
function namedRequest(name: string, ts = nowSec(), pubkey = MEMBER) {
  const base = oldRequest(ts, pubkey);
  return { ...base, name, name_signature: sign(pubkey, nameString(base.challenge, name)) };
}

type StoreRow = { pubkey: string; name: string; signed_at: number; received_at: number };
const stored = (pubkey = MEMBER) =>
  db.prepare("SELECT * FROM member_private_name WHERE pubkey = ?").get(pubkey) as StoreRow | undefined;
const seedStored = (name: string, signed_at: number, pubkey = MEMBER) =>
  db.prepare("INSERT INTO member_private_name (pubkey, name, signed_at, received_at) VALUES (?, ?, ?, ?)")
    .run(pubkey, name, signed_at, 1);

const TOKEN_KEYS = ["expires_at_sec", "issued_at_sec", "jwt", "scope"];

/** The token half of a 200: exactly the pre-D8 token fields, with a real JWT. */
function expectMinted(r: Captured, scope: "full" | "payment" = "full") {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const { name_status: _ignored, ...token } = r.body;
  expect(Object.keys(token).sort()).toEqual(TOKEN_KEYS);
  expect(token.jwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(token.scope).toBe(scope);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("P1 ⚠ PERMITTING CONTROL — an old-grammar request, no name field", () => {
  it("mints a token exactly as before (pre-change: GREEN)", async () => {
    const r = await post(oldRequest());
    expectMinted(r);
  });

  it("returns name_status 'none' and leaves a pre-seeded stored name byte-equal (pre-change: red — no store)", async () => {
    seedStored("Green Acres", nowSec() - 300);
    const before = stored();
    const r = await post(oldRequest());
    expectMinted(r);
    expect(r.body.name_status).toBe("none");
    // P4: absent NEVER clears. Byte-equal, every column.
    expect(stored()).toEqual(before);
    // Anti-vacuity: the row really was there to be cleared.
    expect(before?.name).toBe("Green Acres");
    // No name field → no second verifyMessage.
    expect(lnd.verifyCalls).toHaveLength(1);
  });
});

describe("P3 — a new member against a treasury that ignores the fields still gets its token", () => {
  it("the two new fields never stop the mint (pre-change: GREEN — the old handler drops them unread)", async () => {
    const r = await post(namedRequest("Green Acres"));
    expectMinted(r);
  });
});

describe("P2 — a valid name under a valid name signature", () => {
  it("is stored with signed_at = the challenge timestamp, and returns 'accepted'", async () => {
    const ts = nowSec();
    const before = nowSec();
    const r = await post(namedRequest("Green Acres", ts));
    expectMinted(r);
    expect(r.body.name_status).toBe("accepted");
    const row = stored();
    expect(row?.name).toBe("Green Acres");
    expect(row?.signed_at).toBe(ts);
    expect(row?.received_at).toBeGreaterThanOrEqual(before);
    // The name signature was verified over EXACTLY the §3 string.
    expect(lnd.verifyCalls).toEqual([challengeAt(ts), nameString(challengeAt(ts), "Green Acres")]);
  });

  it("pubkey is stored lowercased even when the challenge carries uppercase hex", async () => {
    const upper = MEMBER.toUpperCase();
    const ts = nowSec();
    const challenge = challengeAt(ts, upper);
    // LND's verifyMessage always returns lowercase hex (hex.EncodeToString).
    const r = await post({
      challenge,
      signature: sign(MEMBER, challenge),
      name: "Green Acres",
      name_signature: sign(MEMBER, nameString(challenge, "Green Acres")),
    });
    expectMinted(r);
    expect(r.body.name_status).toBe("accepted");
    expect(stored(MEMBER)?.name).toBe("Green Acres");
  });
});

describe("P5 — the monotonic property: only a STRICTLY NEWER signed timestamp stores", () => {
  it("an older timestamp with a different name is rejected; paired: a newer one stores", async () => {
    const t = nowSec() - 10;
    seedStored("Green Acres", t);

    const older = await post(namedRequest("Prairie Mill", t - 1));
    expectMinted(older);
    expect(older.body.name_status).toBe("rejected");
    expect(stored()?.name, "a revert to an older signature must not land").toBe("Green Acres");

    const equal = await post(namedRequest("Prairie Mill", t));
    expect(equal.body.name_status, "EQUAL is not newer").toBe("rejected");
    expect(stored()?.name).toBe("Green Acres");

    // Paired positive from the same fixture.
    const newer = await post(namedRequest("Prairie Mill", t + 1));
    expectMinted(newer);
    expect(newer.body.name_status).toBe("accepted");
    expect(stored()).toMatchObject({ name: "Prairie Mill", signed_at: t + 1 });
  });

  it("§5.3 'accepted' covers already-held: a not-newer timestamp whose stored name is EQUAL", async () => {
    const t = nowSec() - 10;
    seedStored("Green Acres", t);
    const r = await post(namedRequest("Green Acres", t - 1));
    expect(r.body.name_status).toBe("accepted");
    expect(stored()).toMatchObject({ name: "Green Acres", signed_at: t });
  });
});

describe("P6 — a name signature bound to a DIFFERENT challenge", () => {
  it("is rejected; the token is still minted and nothing is stored", async () => {
    const tsA = nowSec() - 5;
    const tsB = nowSec();
    const challengeB = challengeAt(tsB);
    const r = await post({
      challenge: challengeB,
      signature: sign(MEMBER, challengeB),
      name: "Green Acres",
      // Signed over challenge A — both challenges are individually valid.
      name_signature: sign(MEMBER, nameString(challengeAt(tsA), "Green Acres")),
    });
    expectMinted(r);
    expect(r.body.name_status).toBe("rejected");
    expect(stored()).toBeUndefined();
  });

  it("a name signature by ANOTHER node is rejected", async () => {
    const base = oldRequest();
    const r = await post({ ...base, name: "Green Acres", name_signature: sign(OTHER_KEY, nameString(base.challenge, "Green Acres")) });
    expectMinted(r);
    expect(r.body.name_status).toBe("rejected");
    expect(stored()).toBeUndefined();
  });
});

describe("§5.1 step 3 — the two fields travel together", () => {
  it("a name with no name_signature, an empty name, or a non-string name → rejected, token minted", async () => {
    const base = oldRequest();
    for (const body of [
      { ...base, name: "Green Acres" },
      { ...base, name: "Green Acres", name_signature: "" },
      { ...base, name: "", name_signature: sign(MEMBER, nameString(base.challenge, "")) },
      { ...base, name: 42, name_signature: sign(MEMBER, nameString(base.challenge, "42")) },
    ]) {
      const r = await post(body);
      expectMinted(r);
      expect(r.body.name_status, JSON.stringify(body)).toBe("rejected");
    }
    expect(stored()).toBeUndefined();
  });

  it("a name_signature with NO name field is treated as no name → 'none'", async () => {
    const base = oldRequest();
    const r = await post({ ...base, name_signature: sign(MEMBER, nameString(base.challenge, "x")) });
    expectMinted(r);
    expect(r.body.name_status).toBe("none");
  });
});

describe("P7 — invalid and blocked names never cost the token", () => {
  it("an invalid name (bypassing member validation) → minted, NOT stored, 'rejected'", async () => {
    for (const name of ["a:b", "x".repeat(65), "Café"]) {
      const r = await post(namedRequest(name));
      expectMinted(r);
      expect(r.body.name_status, name).toBe("rejected");
    }
    expect(stored()).toBeUndefined();
  });

  it("a blocked name → minted, NOT stored, 'rejected'; paired: an unblocked name against the SAME list stores", async () => {
    db.prepare("INSERT INTO blocked_aliases (alias, added_at) VALUES ('BitCorn1', 0)").run();

    const blocked = await post(namedRequest("B1tCorn1", nowSec() - 1));
    expectMinted(blocked);
    expect(blocked.body.name_status).toBe("rejected");
    expect(stored()).toBeUndefined();

    const fine = await post(namedRequest("Green Acres", nowSec()));
    expectMinted(fine);
    expect(fine.body.name_status).toBe("accepted");
    expect(stored()?.name).toBe("Green Acres");
  });
});

describe("P8 — verified over the EXACT received bytes, THEN normalized", () => {
  it("'Green  Acres' (two spaces) signed as sent verifies, and is stored as 'Green Acres'", async () => {
    const ts = nowSec();
    const r = await post(namedRequest("Green  Acres", ts));
    expectMinted(r);
    expect(r.body.name_status).toBe("accepted");
    expect(stored()?.name).toBe("Green Acres");
    expect(lnd.verifyCalls[1]).toBe(nameString(challengeAt(ts), "Green  Acres"));
  });
});

describe("P9 — nothing in the name path may throw into the token path", () => {
  it("the name-signature verification THROWS → the token is still minted, 'rejected' (§5.1 step 4)", async () => {
    lnd.throwFor = (m) => m.startsWith("bitcorn:member-name:");
    const r = await post(namedRequest("Green Acres"));
    expectMinted(r);
    expect(r.body.name_status).toBe("rejected");
    expect(stored()).toBeUndefined();
  });

  it("the blocklist read throws (internal) → the token is still minted, name_status OMITTED", async () => {
    db.exec("ALTER TABLE blocked_aliases RENAME TO blocked_aliases_moved");
    try {
      const r = await post(namedRequest("Green Acres"));
      expectMinted(r);
      expect("name_status" in r.body, "an internal error yields no status").toBe(false);
    } finally {
      db.exec("ALTER TABLE blocked_aliases_moved RENAME TO blocked_aliases");
    }
    expect(stored()).toBeUndefined();
  });

  it("the store write throws (internal) → the token is still minted, name_status OMITTED", async () => {
    db.exec("ALTER TABLE member_private_name RENAME TO member_private_name_moved");
    try {
      const r = await post(namedRequest("Green Acres"));
      expectMinted(r);
      expect("name_status" in r.body).toBe(false);
    } finally {
      db.exec("ALTER TABLE member_private_name_moved RENAME TO member_private_name");
    }
  });
});

describe("P13 — a challenge signature is not a name signature", () => {
  it("the challenge's own signature presented as name_signature → rejected, token minted", async () => {
    const base = oldRequest();
    const r = await post({ ...base, name: "Green Acres", name_signature: base.signature });
    expectMinted(r);
    expect(r.body.name_status).toBe("rejected");
    expect(stored()).toBeUndefined();
  });
});

describe("§5.4 — the 400/401 paths are unchanged and run no name path", () => {
  it("a failed challenge with a valid-looking name → 401, no name_status, nothing stored", async () => {
    const ts = nowSec() - 3600; // outside the ±60s window
    const r = await post(namedRequest("Green Acres", ts));
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("timestamp_out_of_window");
    expect(r.body.name_status).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  it("a missing signature → 400 missing_challenge_or_signature", async () => {
    const r = await post({ challenge: challengeAt(nowSec()), name: "Green Acres" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "missing_challenge_or_signature" });
  });
});

describe("§7.1 GET /api/admin/members/private-names", () => {
  const setRole = (role: "member" | "treasury") =>
    db.prepare(
      `INSERT OR REPLACE INTO lnd_node_info
         (id, pubkey, alias, network, block_height, synced_to_chain, has_treasury_channel, membership_status, node_role, updated_at)
       VALUES (1, ?, NULL, 'regtest', 1, 1, 0, 'unsynced', ?, 0)`,
    ).run(TREASURY, role);

  it("PERMITTING: on the treasury, returns every stored name", async () => {
    setRole("treasury");
    await post(namedRequest("Green Acres"));
    const r = await call("GET", "/api/admin/members/private-names");
    expect(r.status).toBe(200);
    expect(r.body.names).toHaveLength(1);
    expect(r.body.names[0]).toMatchObject({ pubkey: MEMBER, name: "Green Acres" });
    expect(Object.keys(r.body.names[0]).sort()).toEqual(["name", "pubkey", "received_at", "signed_at"]);
  });

  it("FORBIDDING: a member node is refused (403)", async () => {
    setRole("member");
    await post(namedRequest("Green Acres"));
    const r = await call("GET", "/api/admin/members/private-names");
    expect(r.status).toBe(403);
    expect(r.body.names).toBeUndefined();
  });

  it("a failed read → 500 private_name_read_failed (never a 200 with an empty list)", async () => {
    setRole("treasury");
    db.exec("ALTER TABLE member_private_name RENAME TO member_private_name_moved");
    try {
      const r = await call("GET", "/api/admin/members/private-names");
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: "private_name_read_failed" });
    } finally {
      db.exec("ALTER TABLE member_private_name_moved RENAME TO member_private_name");
    }
  });
});

describe("§5.2 — the treasury's own self-refresh", () => {
  it("carries no name, mints full scope, and returns 'none'", async () => {
    const r = await post(oldRequest(nowSec(), TREASURY));
    expectMinted(r, "full");
    expect(r.body.name_status).toBe("none");
    expect(stored(TREASURY)).toBeUndefined();
  });
});
