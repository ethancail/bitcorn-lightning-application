// refreshLocalToken — the member side of the name carrier.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §4, §12 P1 (member half), P14 (old-treasury half), P16. Decision D8.
//
// ⚠ THE PERMITTING CONTROL LEADS: a node with NO stored name sends exactly the
// pre-D8 body, {challenge, signature}, and still gets its token. Before this
// file refreshLocalToken had zero tests.
//
// ⚠ NO LND, NO NETWORK. getLndInfo / lndSignMessage are doubles at the lnd.ts
// wrapper boundary; the treasury is a stubbed global fetch that captures the
// exact request body. SQLite and the migration chain are real.
//
// ⚠ The signed-string format is HARDCODED here (§3), not imported.

import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-name-carrier-test-"));
process.env.DB_DIR = TMP;
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;
process.env.TREASURY_API_URL = "http://treasury.test";

const MEMBER = "03" + "aa".repeat(32);

const lnd = vi.hoisted(() => ({
  localPubkey: "",
  signThrowFor: null as null | ((message: string) => boolean),
}));

function sign(pubkey: string, message: string): string {
  return "fakesig" + Buffer.from(JSON.stringify([pubkey, message])).toString("base64");
}
function unsign(signature: string): [string, string] {
  return JSON.parse(Buffer.from(signature.slice(7), "base64").toString());
}

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndInfo: async () => ({ public_key: lnd.localPubkey }) as any,
    lndSignMessage: async (message: string) => {
      if (lnd.signThrowFor?.(message)) throw new Error("lnd sign failed");
      return sign(lnd.localPubkey, message);
    },
  };
});

const treasury = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: any }>,
  respond: (): { status: number; body: unknown } => ({ status: 200, body: {} }),
}));

let refreshLocalToken: typeof import("./tokenRefresh").refreshLocalToken;
let db: Database.Database;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    treasury.requests.push({ url, body: JSON.parse(init.body) });
    const r = treasury.respond();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ refreshLocalToken } = await import("./tokenRefresh"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const TOKEN = () => {
  const now = Math.floor(Date.now() / 1000);
  return { jwt: "h.p.s", scope: "full", issued_at_sec: now, expires_at_sec: now + 86400 };
};

function asNode(pubkey: string, role: "member" | "treasury"): void {
  lnd.localPubkey = pubkey;
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info
       (id, pubkey, alias, network, block_height, synced_to_chain, has_treasury_channel, membership_status, node_role, updated_at)
     VALUES (1, ?, NULL, 'regtest', 1, 1, 0, 'unsynced', ?, 0)`,
  ).run(pubkey, role);
}

const setName = (pubkey: string, name: string) =>
  db.prepare(
    `INSERT INTO member_profile (member_pubkey, bitcorn_name, bitcorn_name_set_at) VALUES (?, ?, 1)
     ON CONFLICT(member_pubkey) DO UPDATE SET bitcorn_name = excluded.bitcorn_name`,
  ).run(pubkey, name);

const statusRow = () =>
  db.prepare("SELECT member_pubkey, name_sent, status FROM member_name_status").get() as
    | { member_pubkey: string; name_sent: string; status: string }
    | undefined;
const storedJwt = () =>
  (db.prepare("SELECT jwt FROM subscription_local_token WHERE id = 1").get() as { jwt: string } | undefined)?.jwt;

beforeEach(() => {
  treasury.requests = [];
  treasury.respond = () => ({ status: 200, body: TOKEN() });
  lnd.signThrowFor = null;
  db.prepare("DELETE FROM member_profile").run();
  db.prepare("DELETE FROM member_name_status").run();
  db.prepare("DELETE FROM subscription_local_token").run();
  asNode(MEMBER, "member");
});

const onlyRequest = () => {
  expect(treasury.requests).toHaveLength(1);
  return treasury.requests[0].body;
};

// ═══════════════════════════════════════════════════════════════════════════

describe("P1 ⚠ PERMITTING CONTROL (member half) — no stored name", () => {
  it("sends exactly {challenge, signature} and stores the token", async () => {
    const r = await refreshLocalToken();
    expect(r.ok).toBe(true);
    const body = onlyRequest();
    expect(Object.keys(body)).toEqual(["challenge", "signature"]);
    expect(body.challenge).toMatch(new RegExp(`^bitcorn:token-request:${MEMBER}:\\d+$`));
    expect(storedJwt()).toBe("h.p.s");
    expect(statusRow()).toBeUndefined();
  });
});

describe("§4 — a stored name travels under a second signature", () => {
  it("sends name + name_signature over bitcorn:member-name:<challenge>:<name>, signed by this node", async () => {
    setName(MEMBER, "Green Acres");
    const r = await refreshLocalToken();
    expect(r.ok).toBe(true);
    const body = onlyRequest();
    expect(Object.keys(body)).toEqual(["challenge", "signature", "name", "name_signature"]);
    expect(body.name).toBe("Green Acres");
    expect(unsign(body.name_signature)).toEqual([MEMBER, `bitcorn:member-name:${body.challenge}:Green Acres`]);
    // The challenge signature itself is unchanged by the name.
    expect(unsign(body.signature)).toEqual([MEMBER, body.challenge]);
  });

  it("⚠ a failed name signature still requests the token — without the name", async () => {
    setName(MEMBER, "Green Acres");
    lnd.signThrowFor = (m) => m.startsWith("bitcorn:member-name:");
    const r = await refreshLocalToken();
    expect(r.ok).toBe(true);
    expect(Object.keys(onlyRequest())).toEqual(["challenge", "signature"]);
    expect(storedJwt()).toBe("h.p.s");
    expect(statusRow()).toBeUndefined();
  });
});

describe("P14 (member half) — name_status is recorded only when meaningful", () => {
  it("an OLD treasury (no name_status) records NOTHING; paired: 'rejected' is recorded against the name sent", async () => {
    setName(MEMBER, "Green Acres");
    await refreshLocalToken();
    expect(statusRow(), "an old treasury must not produce a status").toBeUndefined();

    treasury.respond = () => ({ status: 200, body: { ...TOKEN(), name_status: "rejected" } });
    await refreshLocalToken();
    expect(statusRow()).toEqual({ member_pubkey: MEMBER, name_sent: "Green Acres", status: "rejected" });
  });

  it("an unknown value records nothing; 'accepted' overwrites a prior 'rejected'", async () => {
    setName(MEMBER, "Green Acres");
    treasury.respond = () => ({ status: 200, body: { ...TOKEN(), name_status: "maybe" } });
    await refreshLocalToken();
    expect(statusRow()).toBeUndefined();

    treasury.respond = () => ({ status: 200, body: { ...TOKEN(), name_status: "rejected" } });
    await refreshLocalToken();
    treasury.respond = () => ({ status: 200, body: { ...TOKEN(), name_status: "accepted" } });
    await refreshLocalToken();
    expect(statusRow()?.status).toBe("accepted");
  });

  it("no name sent → nothing recorded, even if the treasury says 'none'", async () => {
    treasury.respond = () => ({ status: 200, body: { ...TOKEN(), name_status: "none" } });
    await refreshLocalToken();
    expect(statusRow()).toBeUndefined();
  });

  it("a denied refresh records nothing", async () => {
    setName(MEMBER, "Green Acres");
    treasury.respond = () => ({ status: 401, body: { error: "signature_invalid", name_status: "rejected" } });
    const r = await refreshLocalToken();
    expect(r.ok).toBe(false);
    expect(statusRow()).toBeUndefined();
  });
});

describe("recordMemberNameStatus — the value check is its own guard", () => {
  // Why this exists: with the value check removed, every test above still
  // passed — the table's NOT NULL / CHECK throws, and refreshLocalToken's
  // catch swallows it, so the observable outcome was identical. The check's
  // contract is a silent no-op, not a throw; this pins that directly.
  it("an unknown or missing value records nothing WITHOUT throwing; paired: a known value records", async () => {
    const { recordMemberNameStatus } = await import("./memberName");
    for (const v of [undefined, null, "maybe", 1]) {
      expect(() => recordMemberNameStatus(MEMBER, "Green Acres", v), String(v)).not.toThrow();
    }
    expect(statusRow()).toBeUndefined();
    recordMemberNameStatus(MEMBER, "Green Acres", "accepted");
    expect(statusRow()?.status).toBe("accepted");
  });
});

describe("P16 — the treasury's self-refresh is byte-identical", () => {
  it("on the treasury pubkey the body is exactly {challenge, signature}", async () => {
    asNode(TREASURY, "treasury");
    const r = await refreshLocalToken();
    expect(r.ok).toBe(true);
    const body = onlyRequest();
    expect(Object.keys(body)).toEqual(["challenge", "signature"]);
    expect(body.challenge).toMatch(new RegExp(`^bitcorn:token-request:${TREASURY}:\\d+$`));
  });
});
