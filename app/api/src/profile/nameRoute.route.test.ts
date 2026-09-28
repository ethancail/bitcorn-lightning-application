// GET/POST /api/profile/name, driven through the real exported handleRequest
// against a temp-dir DB built by the real migration runner (the
// *.route.test.ts harness — see autoBuy/catchup.route.test.ts). Spec
// 2026-09-23-member-name-prompt §6.
//
// What this pins that the pure validator test cannot:
//   - the route exists and is CLASSIFIED (an unclassified POST fails closed at
//     the confirmation gate with 400 before dispatch — the discriminator is
//     the error code, so a 400 here is checked for WHICH 400);
//   - the stored value is the NORMALIZED form;
//   - errors are SPECIFIC (§5.3), not the alias route's generic rejection;
//   - overwrite works and there is no clear path (no DELETE);
//   - writing the name never touches the LND alias columns (D6 §3);
//   - the treasury is refused.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-name-route-test-"));
process.env.DB_DIR = TMP_DB;

const MEMBER_PUBKEY = "03" + "a".repeat(64);

// D8 call 9: a save triggers one token refresh. The refresh is a spy here —
// it records the name STORED AT CALL TIME, which is what the real refresh
// reads and signs (tokenRefresh.nameCarrier.test.ts pins that half).
const refresh = vi.hoisted(() => ({
  namesAtCall: [] as Array<string | null>,
  impl: null as null | (() => Promise<unknown>),
  readName: null as null | (() => string | null),
}));
vi.mock("../subscription/tokenRefresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../subscription/tokenRefresh")>();
  return {
    ...actual,
    refreshLocalToken: vi.fn(async () => {
      refresh.namesAtCall.push(refresh.readName?.() ?? null);
      return refresh.impl ? refresh.impl() : { ok: false, reason: "transport_error" };
    }),
  };
});

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: Database.Database;

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
  // Importing index.ts has no boot side effects (bootSideEffects runs only
  // from main()), so the schema is built here — as catchup.route.test.ts does.
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
});

function setNodeRole(role: "member" | "treasury") {
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info
       (id, pubkey, alias, network, block_height, synced_to_chain, has_treasury_channel, membership_status, node_role, updated_at)
     VALUES (1, ?, NULL, 'regtest', 1, 1, 0, 'unsynced', ?, ?)`,
  ).run(MEMBER_PUBKEY, role, Date.now());
}

beforeEach(() => {
  db.prepare("DELETE FROM member_profile").run();
  db.prepare("DELETE FROM member_name_status").run();
  setNodeRole("member");
  refresh.namesAtCall = [];
  refresh.impl = null;
  refresh.readName = () =>
    (db.prepare("SELECT bitcorn_name FROM member_profile WHERE member_pubkey = ?").get(MEMBER_PUBKEY) as
      | { bitcorn_name: string | null }
      | undefined)?.bitcorn_name ?? null;
});

/** Let the fire-and-forget refresh run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

type Captured = { status: number; body: any };

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
    setTimeout(() => { if (!done) { status = -1; chunks = ""; finish(); } }, 4000);
  });
}

describe("GET /api/profile/name", () => {
  it("returns nulls for a member who has never set a name (no row yet)", async () => {
    const r = await call("GET", "/api/profile/name");
    expect(r.status).toBe(200);
    // treasury_name_status is additive (D8 §7.2) — null with no name.
    expect(r.body).toEqual({ bitcorn_name: null, bitcorn_name_set_at: null, treasury_name_status: null });
  });

  it("refuses the treasury (403 member_required)", async () => {
    setNodeRole("treasury");
    const r = await call("GET", "/api/profile/name");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("member_required");
  });
});

describe("POST /api/profile/name", () => {
  it("stores the NORMALIZED name and GET reads it back", async () => {
    const before = Math.floor(Date.now() / 1000);
    const w = await call("POST", "/api/profile/name", { name: "  Green   Acres  " });
    expect(w.status).toBe(200);
    expect(w.body.bitcorn_name).toBe("Green Acres");
    expect(w.body.bitcorn_name_set_at).toBeGreaterThanOrEqual(before);

    const r = await call("GET", "/api/profile/name");
    expect(r.body).toEqual({
      bitcorn_name: "Green Acres",
      bitcorn_name_set_at: w.body.bitcorn_name_set_at,
      treasury_name_status: null,
    });
  });

  it("overwrites an existing name", async () => {
    await call("POST", "/api/profile/name", { name: "First" });
    const w = await call("POST", "/api/profile/name", { name: "Second" });
    expect(w.status).toBe(200);
    expect((await call("GET", "/api/profile/name")).body.bitcorn_name).toBe("Second");
  });

  it("returns a SPECIFIC error for ':' (not the alias route's generic rejection)", async () => {
    const w = await call("POST", "/api/profile/name", { name: "Farm:1" });
    expect(w.status).toBe(400);
    expect(w.body).toEqual({
      error: "invalid_name",
      detail: "Name may contain only letters, numbers, spaces, and . - _ ' ! ?",
    });
    expect((await call("GET", "/api/profile/name")).body.bitcorn_name).toBeNull();
  });

  it("returns a specific error for an empty / all-whitespace name — there is no 'save empty' clear", async () => {
    await call("POST", "/api/profile/name", { name: "Kept" });
    const w = await call("POST", "/api/profile/name", { name: "   " });
    expect(w.status).toBe(400);
    expect(w.body).toEqual({ error: "invalid_name", detail: "Name cannot be empty." });
    expect((await call("GET", "/api/profile/name")).body.bitcorn_name).toBe("Kept");
  });

  it("returns a specific error for 65 characters, and accepts 64", async () => {
    const over = await call("POST", "/api/profile/name", { name: "a".repeat(65) });
    expect(over.status).toBe(400);
    expect(over.body.detail).toBe("Name is too long (65/64 characters).");
    const at = await call("POST", "/api/profile/name", { name: "a".repeat(64) });
    expect(at.status).toBe(200);
  });

  it("rejects a non-string name as invalid_request", async () => {
    const w = await call("POST", "/api/profile/name", { name: 42 });
    expect(w.status).toBe(400);
    expect(w.body.error).toBe("invalid_request");
  });

  it("never touches the LND alias columns", async () => {
    db.prepare(
      "INSERT INTO member_profile (member_pubkey, alias, alias_set_at, alias_applied_at) VALUES (?, 'PublicAlias', 100, 101)",
    ).run(MEMBER_PUBKEY);
    await call("POST", "/api/profile/name", { name: "Private Name" });
    const row = db.prepare("SELECT * FROM member_profile WHERE member_pubkey = ?").get(MEMBER_PUBKEY) as any;
    expect(row.alias).toBe("PublicAlias");
    expect(row.alias_set_at).toBe(100);
    expect(row.alias_applied_at).toBe(101);
    expect(row.bitcorn_name).toBe("Private Name");
  });

  it("refuses the treasury (403) and writes nothing", async () => {
    setNodeRole("treasury");
    const w = await call("POST", "/api/profile/name", { name: "Treasury" });
    expect(w.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM member_profile").get()).toEqual({ n: 0 });
  });
});

describe("no clear path (spec §6, accepted)", () => {
  it("DELETE /api/profile/name is not a route: the confirmation gate refuses it as unclassified", async () => {
    const r = await call("DELETE", "/api/profile/name");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("confirmation_required");
    expect(String(r.body.detail)).toMatch(/not classified/);
  });
});

// ─── D8 (spec 2026-09-25-member-name-signed-transport) ──────────────────────

describe("P15 — saving a name triggers exactly one token refresh (D8 call 9)", () => {
  it("PERMITTING: a 200 save → ONE refresh, which sees the SAVED name", async () => {
    const w = await call("POST", "/api/profile/name", { name: "  Green   Acres " });
    await settle();
    expect(w.status).toBe(200);
    expect(refresh.namesAtCall, "one refresh, after the write").toEqual(["Green Acres"]);
  });

  it("a failed refresh does not fail the save: still 200, still stored", async () => {
    refresh.impl = () => Promise.reject(new Error("treasury unreachable"));
    const w = await call("POST", "/api/profile/name", { name: "Green Acres" });
    await settle();
    expect(w.status).toBe(200);
    expect(w.body.bitcorn_name).toBe("Green Acres");
    expect((await call("GET", "/api/profile/name")).body.bitcorn_name).toBe("Green Acres");
    // Anti-vacuity: the refresh really ran — and really failed.
    expect(refresh.namesAtCall).toEqual(["Green Acres"]);
  });

  it("a refresh that never settles does not hold the save's response", async () => {
    refresh.impl = () => new Promise(() => {});
    const w = await call("POST", "/api/profile/name", { name: "Green Acres" });
    expect(w.status).toBe(200);
  });

  it("FORBIDDING: a 400 save triggers NO refresh", async () => {
    const w = await call("POST", "/api/profile/name", { name: "Farm:1" });
    await settle();
    expect(w.status).toBe(400);
    expect(refresh.namesAtCall).toEqual([]);
  });

  it("FORBIDDING: the treasury's refused save (403) triggers NO refresh", async () => {
    setNodeRole("treasury");
    await call("POST", "/api/profile/name", { name: "Treasury" });
    await settle();
    expect(refresh.namesAtCall).toEqual([]);
  });
});

describe("P14 (server half) — GET reports the treasury's status for the CURRENT name only", () => {
  const seedStatus = (name_sent: string, status: string) =>
    db.prepare(
      "INSERT INTO member_name_status (member_pubkey, name_sent, status, received_at) VALUES (?, ?, ?, 1)",
    ).run(MEMBER_PUBKEY, name_sent, status);

  it("a 'rejected' status for the current name → treasury_name_status 'rejected'", async () => {
    await call("POST", "/api/profile/name", { name: "Green Acres" });
    seedStatus("Green Acres", "rejected");
    expect((await call("GET", "/api/profile/name")).body.treasury_name_status).toBe("rejected");
  });

  it("'accepted' for the current name → 'accepted'", async () => {
    await call("POST", "/api/profile/name", { name: "Green Acres" });
    seedStatus("Green Acres", "accepted");
    expect((await call("GET", "/api/profile/name")).body.treasury_name_status).toBe("accepted");
  });

  it("⚠ a 'rejected' status for an EARLIER name does not describe the one saved since → null", async () => {
    seedStatus("Old Name", "rejected");
    await call("POST", "/api/profile/name", { name: "New Name" });
    const r = await call("GET", "/api/profile/name");
    expect(r.body.bitcorn_name).toBe("New Name");
    expect(r.body.treasury_name_status).toBeNull();
  });

  it("no status row (an old treasury, or not yet refreshed) → null", async () => {
    await call("POST", "/api/profile/name", { name: "Green Acres" });
    expect((await call("GET", "/api/profile/name")).body.treasury_name_status).toBeNull();
  });
});
