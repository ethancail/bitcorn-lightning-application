// Route-level tests for POST / PATCH / DELETE /api/contacts — billing-pubkey-
// case arc (bitcorn-research
// specs/2026-10-28-billing-pubkey-case-normalization-spec.md, DW-1, DW-4,
// DW-7, DW-9 to DW-12, and the API halves of DW-15, DW-16, DW-17).
//
// THE RULES PINNED HERE:
//   · POST normalizes user input — trim, lowercase — and refuses anything that
//     is not 66 hex characters starting 02 or 03 (O-4(a)); it refuses a case
//     variant of an existing row with the existing 409 (O-2).
//   · PATCH and DELETE act on the row whose stored pubkey EQUALS the decoded
//     URL parameter, else on the case-insensitive tie-break winner (manual
//     first, then lowest id), one row by id (O-1 as refined). They do not
//     validate the parameter (O-4(b)); one that fails to URL-decode is
//     answered 404 like no match, and the API keeps serving.
//
// Duplicate pairs store the manual row UPPERCASE and the auto row lowercase
// (or mixed), the arrangement where an exact compare on the lowercase key
// finds the wrong row (spec §5.1 control 1).
//
// ⚠ NO LND. lnd.ts's client/peers and the node-info read are doubles;
// handleRequest, the migration chain and SQLite are real.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at module scope.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-contacts-db-"));
process.env.DB_DIR = TMP_DB;

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndClient: () => ({ lnd: {} }) as any,
    getLndPeers: async () => ({ peers: [] }) as any,
  };
});

vi.mock("./read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read")>();
  return { ...actual, getNodeInfo: () => ({ node_role: "treasury" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
const { db } = await import("../db");
const { classifyLanePurpose } = await import("../subscription/lanePurpose");

// ─── Fixtures ──────────────────────────────────────────────────────────────

const LOWER = "03" + "c7".repeat(32);
const UPPER = LOWER.toUpperCase();
const MIXED = "03" + "C7c7".repeat(16);
const OTHER = "02" + "a9".repeat(32); //   no case variant anywhere
const ABSENT = "02" + "e5".repeat(32); //  never stored

const REFUSAL = "Node ID must be 66 hexadecimal characters (0-9, a-f), starting with 02 or 03.";

type ContactRow = { id: number; pubkey: string; name: string; tags: string | null; source: string };

function seedContact(pubkey: string, source: "manual" | "auto", name: string, tags: string | null): number {
  const r = db
    .prepare(
      `INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 0, 0)`,
    )
    .run(pubkey, name, tags, source);
  return Number(r.lastInsertRowid);
}

const rows = () =>
  db.prepare("SELECT id, pubkey, name, tags, source FROM contacts ORDER BY id").all() as ContactRow[];
const rowById = (id: number) =>
  db.prepare("SELECT id, pubkey, name, tags, source FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;

type Captured = { status: number; body: any; rejected: unknown };

/**
 * Drive the real handleRequest. A handler that REJECTS is reported as such:
 * under http.createServer nothing awaits the returned promise, so a rejection
 * there is an unhandled rejection in the API process, not a response.
 */
function call(method: string, url: string, body?: unknown): Promise<Captured> {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  // apiFetch always sends the JSON Content-Type; the cross-site guard requires it.
  (req as any).headers = { "content-type": "application/json" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    let done = false;
    const finish = (rejected: unknown = undefined) => {
      if (done) return;
      done = true;
      let parsed: any = null;
      try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
      resolve({ status, body: parsed, rejected });
    };
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) { status = s; return res; },
      end(c?: any) { if (c) chunks += c.toString(); finish(); },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;
    handleRequest(req, res).catch((err) => finish(err ?? new Error("handler rejected")));
    setImmediate(() => stream.end(body === undefined ? "" : JSON.stringify(body)));
    setTimeout(() => { if (!done) { status = -1; finish(); } }, 4000);
  });
}

const post = (pubkey: unknown, name = "Probe", tags?: string[]) =>
  call("POST", "/api/contacts", { pubkey, name, ...(tags ? { tags } : {}) });
// The URL the fixed web client builds: the stored value, encodeURIComponent'd.
const patch = (pubkey: string, body: unknown) => call("PATCH", `/api/contacts/${encodeURIComponent(pubkey)}`, body);
const del = (pubkey: string) => call("DELETE", `/api/contacts/${encodeURIComponent(pubkey)}`);

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  runMigrations();
});

beforeEach(() => {
  db.exec("DELETE FROM contacts; DELETE FROM lnd_channels;");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("DW-1: POST stores an uppercase entry lowercase, and it classifies", () => {
  it("an UPPERCASE merchant contact is stored lowercase (read from the table) and classifies merchant_lane", async () => {
    const r = await post(UPPER, "Prairie Mill", ["merchant"]);
    expect(r.status).toBe(200);

    expect(rows().map((x) => x.pubkey), "stored lowercase, read back from the table").toEqual([LOWER]);
    expect(r.body.contact.pubkey, "the response is built from the stored row").toBe(LOWER);
    expect(classifyLanePurpose(LOWER)).toBe("merchant_lane");
  });
});

describe("DW-4: POST refuses input that is not 66 hex characters", () => {
  it.each([
    ["65 characters", LOWER.slice(0, 65)],
    ["67 characters", LOWER + "a"],
    ["66 characters, one non-hex", LOWER.slice(0, 65) + "g"],
    ["an internal space", LOWER.slice(0, 30) + " " + LOWER.slice(31)],
    ["empty after trim", "   "],
  ])("%s → 400 with a reason, no row written", async (_label, input) => {
    const r = await post(input);
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe(REFUSAL);
    expect(rows(), "nothing may be written for a refused key").toEqual([]);
  });

  it("ANTI-VACUITY: a valid UPPERCASE 66-hex key with surrounding whitespace is accepted and written lowercase", async () => {
    const r = await post(`  ${UPPER}  `);
    expect(r.status).toBe(200);
    expect(rows().map((x) => x.pubkey)).toEqual([LOWER]);
  });
});

describe("DW-10: POST refuses a 66-hex key not starting 02 or 03", () => {
  it.each([
    ["04…", "04" + "c7".repeat(32)],
    ["00…", "00" + "c7".repeat(32)],
  ])("%s → 400 with a reason, no row written", async (_label, input) => {
    const r = await post(input);
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe(REFUSAL);
    expect(rows()).toEqual([]);
  });

  it.each([
    ["02…", "02" + "C7".repeat(32)],
    ["03…", "03" + "C7".repeat(32)],
  ])("ANTI-VACUITY: a valid uppercase %s key is accepted and written lowercase", async (_label, input) => {
    const r = await post(input);
    expect(r.status).toBe(200);
    expect(rows().map((x) => x.pubkey)).toEqual([input.toLowerCase()]);
  });
});

describe("DW-9: POST refuses a case variant of an existing row with the existing 409", () => {
  it.each([
    ["lowercase", LOWER],
    ["mixed-case", MIXED],
  ])("an existing UPPERCASE row + POST of its %s form → 409, no twin written", async (_label, input) => {
    seedContact(UPPER, "manual", "Legacy", "merchant");

    const r = await post(input, "Twin");
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe("Contact with this pubkey already exists");
    expect(rows().map((x) => x.pubkey), "no case twin may be written").toEqual([UPPER]);
  });

  it("ANTI-VACUITY: a POST of a key with no case variant succeeds and is written", async () => {
    seedContact(UPPER, "manual", "Legacy", "merchant");
    const r = await post(OTHER, "Fresh");
    expect(r.status).toBe(200);
    expect(rows().map((x) => x.pubkey)).toEqual([UPPER, OTHER]);
  });
});

describe("DW-7: PATCH and DELETE find an uppercase-stored contact by the lowercase key", () => {
  it("PATCH addressed with the lowercase key → 200, and the response carries that contact", async () => {
    const id = seedContact(UPPER, "manual", "Before", null);

    const r = await patch(LOWER, { name: "After" });
    expect(r.status).toBe(200);
    expect(r.body.contact).toMatchObject({ id, pubkey: UPPER, name: "After" });
    expect(rowById(id)?.name).toBe("After");
  });

  it("DELETE addressed with the lowercase key → 200, row removed", async () => {
    seedContact(UPPER, "manual", "Doomed", null);

    const r = await del(LOWER);
    expect(r.status).toBe(200);
    expect(rows()).toEqual([]);
  });

  it("ANTI-VACUITY: an absent key still returns 404 at both", async () => {
    seedContact(UPPER, "manual", "Kept", null);
    expect((await patch(ABSENT, { name: "x" })).status).toBe(404);
    expect((await del(ABSENT)).status).toBe(404);
    expect(rows().map((x) => x.name)).toEqual(["Kept"]);
  });
});

// ─── DW-11: exact match first, else the tie-break winner ──────────────────

const ORDERS = [
  ["manual inserted first", ["manual", "auto"]],
  ["auto inserted first", ["auto", "manual"]],
] as const;

/** Seed a case-duplicate pair in the given order; returns both ids. */
function seedPair(order: readonly ("manual" | "auto")[], manualKey: string, autoKey: string) {
  const ids = { manual: 0, auto: 0 };
  for (const source of order) {
    if (source === "manual") ids.manual = seedContact(manualKey, "manual", "Manual Mill", "merchant");
    else ids.auto = seedContact(autoKey, "auto", "Auto Alias", "farmer");
  }
  return ids;
}

describe("DW-11(a): PATCH and DELETE addressed by a row's own stored value act on THAT row", () => {
  it.each(ORDERS)("PATCH on the LOSING (auto) row's own value changes it, not the manual row (%s)", async (_l, order) => {
    const ids = seedPair(order, UPPER, LOWER);
    const manualBefore = rowById(ids.manual);

    const r = await patch(LOWER, { name: "Auto Renamed" });
    expect(r.status).toBe(200);
    expect(r.body.contact).toMatchObject({ id: ids.auto, pubkey: LOWER, name: "Auto Renamed" });
    expect(rowById(ids.auto)?.name).toBe("Auto Renamed");
    expect(rowById(ids.manual), "the other row must be byte-unchanged").toEqual(manualBefore);
  });

  it.each(ORDERS)("PATCH on the MANUAL row's own value changes it, not the auto row (%s)", async (_l, order) => {
    const ids = seedPair(order, UPPER, LOWER);
    const autoBefore = rowById(ids.auto);

    const r = await patch(UPPER, { name: "Manual Renamed" });
    expect(r.status).toBe(200);
    expect(r.body.contact).toMatchObject({ id: ids.manual, pubkey: UPPER, name: "Manual Renamed" });
    expect(rowById(ids.auto), "the other row must be byte-unchanged").toEqual(autoBefore);
  });

  it.each(ORDERS)("DELETE on the LOSING row's own value removes only it (%s)", async (_l, order) => {
    const ids = seedPair(order, UPPER, LOWER);

    expect((await del(LOWER)).status).toBe(200);
    expect(rows().map((x) => x.id), "the manual row must still be present").toEqual([ids.manual]);
  });

  it.each(ORDERS)("DELETE on the MANUAL row's own value removes only it (%s)", async (_l, order) => {
    const ids = seedPair(order, UPPER, LOWER);

    expect((await del(UPPER)).status).toBe(200);
    expect(rows().map((x) => x.id)).toEqual([ids.auto]);
  });
});

describe("DW-11(a): classification after an exact DELETE", () => {
  it.each(ORDERS)("deleting the LOSING row leaves the lane unchanged — the manual row's (%s)", async (_l, order) => {
    seedPair(order, UPPER, LOWER);
    expect(classifyLanePurpose(LOWER)).toBe("merchant_lane");

    expect((await del(LOWER)).status).toBe(200);
    expect(classifyLanePurpose(LOWER), "the winner is untouched, so the lane must not move").toBe("merchant_lane");
  });

  it.each(ORDERS)("deleting the MANUAL row hands classification to the twin's tags (%s)", async (_l, order) => {
    seedPair(order, UPPER, LOWER);

    expect((await del(UPPER)).status).toBe(200);
    expect(classifyLanePurpose(LOWER)).toBe("farmer_lane");
  });
});

describe("DW-11(b): no row equals the parameter → the tie-break winner", () => {
  // Manual all-UPPERCASE, auto mixed-case, addressed with the lowercase key.
  it.each(ORDERS)("PATCH changes the MANUAL row only; the lane follows the patched tags (%s)", async (_l, order) => {
    const ids = seedPair(order, UPPER, MIXED);
    const autoBefore = rowById(ids.auto);

    const r = await patch(LOWER, { name: "Manual Patched", tags: ["external"] });
    expect(r.status).toBe(200);
    expect(r.body.contact).toMatchObject({ id: ids.manual, name: "Manual Patched" });
    expect(rowById(ids.auto), "the twin must be byte-unchanged").toEqual(autoBefore);
    expect(classifyLanePurpose(LOWER)).toBe("external_peer");
  });

  it.each(ORDERS)("DELETE removes the manual row, then the twin, then 404 (%s)", async (_l, order) => {
    const ids = seedPair(order, UPPER, MIXED);

    expect((await del(LOWER)).status).toBe(200);
    expect(rows().map((x) => x.id), "the first DELETE removes the winner only").toEqual([ids.auto]);
    expect(classifyLanePurpose(LOWER), "classification falls to the twin's tags").toBe("farmer_lane");

    expect((await del(LOWER)).status).toBe(200);
    expect(rows()).toEqual([]);

    expect((await del(LOWER)).status).toBe(404);
  });

  it("two auto rows, neither equal to the parameter → the LOWER id", async () => {
    const first = seedContact(UPPER, "auto", "First Auto", "merchant");
    const second = seedContact(MIXED, "auto", "Second Auto", "farmer");

    const r = await patch(LOWER, { name: "Patched" });
    expect(r.status).toBe(200);
    expect(rowById(first)?.name).toBe("Patched");
    expect(rowById(second)?.name).toBe("Second Auto");

    expect((await del(LOWER)).status).toBe(200);
    expect(rows().map((x) => x.id)).toEqual([second]);
  });
});

describe("DW-12: PATCH and DELETE do not validate their URL parameter", () => {
  it.each([
    ["64 hex characters", "02" + "ab".repeat(31)],
    ["a 04… key", "04" + "ab".repeat(32)],
  ])("a legacy malformed row (%s) is PATCHed then DELETEd by its own value (200, 200)", async (_l, legacy) => {
    const id = seedContact(legacy, "manual", "Legacy", null);

    const p = await patch(legacy, { name: "Still Editable" });
    expect(p.status).toBe(200);
    expect(rowById(id)?.name).toBe("Still Editable");

    expect((await del(legacy)).status).toBe(200);
    expect(rows()).toEqual([]);
  });

  it("a malformed key that matches NO row → 404, not 400", async () => {
    seedContact(OTHER, "manual", "Kept", null);
    const malformed = "zz-not-a-key";
    expect((await patch(malformed, { name: "x" })).status).toBe(404);
    expect((await del(malformed)).status).toBe(404);
  });
});

describe("DW-15 (API half): each twin's request, as the page sends it, reaches that twin only", () => {
  // The page sends each row's STORED pubkey, encodeURIComponent'd by the client
  // (the UI half is app/web/src/pages/Contacts.pubkeyCase.test.tsx).
  it("PATCH and DELETE per row of an UPPERCASE-manual / lowercase-auto pair", async () => {
    const ids = seedPair(["manual", "auto"], UPPER, LOWER);

    for (const [key, id, other] of [
      [UPPER, ids.manual, ids.auto],
      [LOWER, ids.auto, ids.manual],
    ] as const) {
      const otherBefore = rowById(other);
      const r = await patch(key, { name: `edited-${id}` });
      expect(r.status).toBe(200);
      expect(rowById(id)?.name).toBe(`edited-${id}`);
      expect(rowById(other)).toEqual(otherBefore);
    }

    expect((await del(LOWER)).status).toBe(200);
    expect(rows().map((x) => x.id)).toEqual([ids.manual]);
    expect((await del(UPPER)).status).toBe(200);
    expect(rows()).toEqual([]);
  });
});

describe("DW-16 (API half): a legacy row whose stored pubkey needs URL encoding", () => {
  // The UI half is app/web/src/pages/Contacts.pubkeyCase.test.tsx.
  it.each([
    ["a '#'", "02" + "ab".repeat(16) + "#legacy"],
    ["a '%'", "02" + "ab".repeat(16) + "%zz"],
    ["a '?'", "02" + "ab".repeat(16) + "?x=1"],
  ])("stored with %s: the encoded PATCH (200, changed) and DELETE (200, removed) reach it", async (_l, stored) => {
    const id = seedContact(stored, "manual", "Odd Legacy", null);

    const p = await patch(stored, { name: "Edited Odd" });
    expect(p.status).toBe(200);
    expect(rowById(id)?.name).toBe("Edited Odd");

    expect((await del(stored)).status).toBe(200);
    expect(rows()).toEqual([]);
  });
});

describe("DW-17: a parameter that fails to URL-decode gets 404, and the API keeps serving", () => {
  // A malformed percent-escape: decodeURIComponent cannot decode it.
  const UNDECODABLE = "/api/contacts/%E0%A4%A";

  it("PATCH → 404 (handler does not reject), nothing written; a following valid PATCH → 200", async () => {
    const id = seedContact(LOWER, "manual", "Steady", null);

    const bad = await call("PATCH", UNDECODABLE, { name: "Should Not Land" });
    expect(bad.rejected, "the handler must answer, not reject").toBeUndefined();
    expect(bad.status).toBe(404);
    expect(rowById(id)?.name).toBe("Steady");

    const ok = await patch(LOWER, { name: "Next Request" });
    expect(ok.status).toBe(200);
    expect(rowById(id)?.name).toBe("Next Request");
  });

  it("DELETE → 404 (handler does not reject), nothing deleted; a following valid DELETE → 200", async () => {
    seedContact(LOWER, "manual", "Steady", null);

    const bad = await call("DELETE", UNDECODABLE);
    expect(bad.rejected, "the handler must answer, not reject").toBeUndefined();
    expect(bad.status).toBe(404);
    expect(rows()).toHaveLength(1);

    expect((await del(LOWER)).status).toBe(200);
    expect(rows()).toEqual([]);
  });
});
