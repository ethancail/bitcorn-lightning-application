// Route-level tests for the treasury's public-alias store:
//   POST /api/admin/members/public-aliases/refresh
//   GET  /api/admin/members/public-aliases
// Spec: bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §5-§7,
// §11 controls 1, 2, 3, 5, 6, 9, 10, 11 (server half) and 12. Decision D7.
//
// ⚠ THE PERMITTING CONTROL LEADS (§11.1). Every other test here forbids
// something — a write, a role, a second refresh — and a suite of forbidding
// tests passes against a store that never learns an alias. The first test is
// the one that says the feature does its job.
//
// ⚠ PRE-CHANGE RUN: run against 30de308 before either route existed. Red
// there — the POST was refused as an unclassified mutation and the GET fell
// through the dispatch chain.
//
// ⚠ NO LND. ln-service's getNode and lnd.ts's client are scripted doubles;
// SQLite and the migration chain are real.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-public-alias-db-"));
process.env.DB_DIR = TMP_DB;

type Script = () => Promise<unknown>;

const ln = vi.hoisted(() => ({
  scripts: new Map<string, Script>(),
  calls: [] as string[],
  livePeers: [] as string[],
}));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const getNode = (args: { public_key: string }) => {
    ln.calls.push(args.public_key);
    const s = ln.scripts.get(args.public_key);
    if (!s) return Promise.reject(new Error(`test did not script getNode for ${args.public_key}`));
    return s();
  };
  return { ...actual, default: { ...(actual.default ?? actual), getNode }, getNode };
});

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndClient: () => ({ lnd: {} }) as any,
    getLndPeers: async () => ({ peers: ln.livePeers.map((public_key) => ({ public_key })) }) as any,
  };
});

const roleState = vi.hoisted(() => ({ node: null as { node_role?: string } | null }));

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
const { db } = await import("../db");

// ─── Fixtures ──────────────────────────────────────────────────────────────

const pk = (byte: string) => "02" + byte.repeat(32);

const REAL = pk("b1");
const DEFAULT = pk("b2");
const UNKNOWN = pk("b3");
const FAILS = pk("b4");
const SUB_ONLY = "03" + "b5".repeat(32); // subscription row only: no channel, no peer, no contact
const LIVE_ONLY = pk("b6"); //              a live peer with no channel and no subscription

const resolves = (alias: string): Script => () => Promise.resolve({ alias });
const rejects = (err: unknown): Script => () => Promise.reject(err);

function seedChannel(peerPubkey: string, channelId: string): void {
  db.prepare(
    `INSERT INTO lnd_channels (
       channel_id, peer_pubkey, capacity_sat, local_balance_sat,
       remote_balance_sat, active, private, updated_at, first_seen_at
     ) VALUES (?, ?, 1000000, 500000, 500000, 1, 0, 0, 0)`,
  ).run(channelId, peerPubkey);
}

function seedSubscription(memberPubkey: string): void {
  db.prepare(
    `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier)
     VALUES (?, ?, ?, 0, 0, 'current')`,
  ).run(memberPubkey, `bcrt1q${memberPubkey.slice(2, 20)}`, `bitcorn:subscription:${memberPubkey.slice(0, 16)}`);
}

function seedContact(pubkey: string, name: string): void {
  db.prepare(
    "INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'manual', 0, 0)",
  ).run(pubkey, name);
}

type Row = {
  pubkey: string;
  outcome: string | null;
  alias: string | null;
  outcome_at: number | null;
  last_attempt_at: number;
  last_attempt_ok: number;
  last_error: string | null;
};
const storeRow = (pubkey: string) =>
  db.prepare("SELECT * FROM peer_public_alias WHERE pubkey = ?").get(pubkey) as Row | undefined;

async function call(method: "GET" | "POST", url: string): Promise<{ status: number | null; body: any }> {
  const captured = { status: null as number | null, body: "" };
  const res: any = {
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  };
  await handleRequest({ method, url, headers: {} } as any, res);
  let body: any = null;
  try {
    body = JSON.parse(captured.body);
  } catch {
    body = null;
  }
  return { status: captured.status, body };
}

const REFRESH = "/api/admin/members/public-aliases/refresh";
const READ = "/api/admin/members/public-aliases";
const refresh = () => call("POST", REFRESH);
const read = () => call("GET", READ);

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  runMigrations();
});

beforeEach(() => {
  ln.scripts.clear();
  ln.calls = [];
  ln.livePeers = [];
  roleState.node = { node_role: "treasury" };
  db.exec("DELETE FROM contacts; DELETE FROM lnd_channels; DELETE FROM subscription;");
  // The table does not exist pre-change; tolerate that so the pre-change run
  // fails on the ROUTE, not in setup.
  try {
    db.exec("DELETE FROM peer_public_alias;");
  } catch {}
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.1 — the permitting control leads.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.1 PERMITTING CONTROL — a peer with a real alias shows it", () => {
  it("getNode returns 'Lazy H Farms' → stored as outcome 'alias' → the GET returns it", async () => {
    seedChannel(REAL, "1");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));

    const r = await refresh();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, total: 1, alias: 1, none_announced: 0, not_in_graph: 0, failed: 0 });

    const g = await read();
    expect(g.status).toBe(200);
    expect(g.body.aliases).toHaveLength(1);
    expect(g.body.aliases[0]).toMatchObject({
      pubkey: REAL,
      outcome: "alias",
      alias: "Lazy H Farms",
      last_attempt_ok: 1,
    });
    expect(typeof g.body.aliases[0].outcome_at).toBe("number");
    expect(typeof g.body.aliases[0].last_attempt_at).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.2 — four outcomes, stored distinctly.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.2 the four outcomes are stored distinctly", () => {
  it("alias / none_announced / not_in_graph / failed each land as their own row shape", async () => {
    for (const [i, k] of [REAL, DEFAULT, UNKNOWN, FAILS].entries()) seedChannel(k, String(i + 1));
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    ln.scripts.set(DEFAULT, resolves(DEFAULT.slice(0, 20)));
    ln.scripts.set(UNKNOWN, rejects([404, "NodeIsUnknown"]));
    ln.scripts.set(FAILS, rejects([503, "FailedToRetrieveNodeDetails", { err: { details: "boom" } }]));

    const r = await refresh();
    expect(r.body).toEqual({ ok: true, total: 4, alias: 1, none_announced: 1, not_in_graph: 1, failed: 1 });

    expect(storeRow(REAL)).toMatchObject({ outcome: "alias", alias: "Lazy H Farms", last_attempt_ok: 1, last_error: null });
    // The 20-hex default is NOT stored as a name — it arrives as a successful
    // answer, so it is recognised by value.
    expect(storeRow(DEFAULT)).toMatchObject({ outcome: "none_announced", alias: null, last_attempt_ok: 1 });
    expect(storeRow(UNKNOWN)).toMatchObject({ outcome: "not_in_graph", alias: null, last_attempt_ok: 1 });
    // A first-ever failure creates a row with NO definitive outcome, and a
    // code — not LND's free text ("boom" must not be stored).
    expect(storeRow(FAILS)).toMatchObject({
      outcome: null,
      alias: null,
      outcome_at: null,
      last_attempt_ok: 0,
      last_error: "503:FailedToRetrieveNodeDetails",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.3 — a failed lookup keeps the last good value.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.3 a failed lookup preserves the last good value", () => {
  it("alias stored, then a failed attempt → outcome and alias unchanged, attempt fields updated", async () => {
    seedChannel(REAL, "1");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    await refresh();
    const before = storeRow(REAL)!;
    expect(before.outcome).toBe("alias");

    ln.scripts.set(REAL, rejects(new Error("ETIMEDOUT: nodeAlias:getNode exceeded 10000ms deadline")));
    await new Promise((r) => setTimeout(r, 2)); // a distinguishable attempt timestamp
    const r = await refresh();
    expect(r.body).toMatchObject({ total: 1, alias: 0, failed: 1 });

    const after = storeRow(REAL)!;
    expect(after.outcome, "a failure must not overwrite the definitive outcome").toBe("alias");
    expect(after.alias).toBe("Lazy H Farms");
    expect(after.outcome_at).toBe(before.outcome_at);
    // Anti-vacuity: the attempt WAS recorded — the row was written, just not
    // its definitive half.
    expect(after.last_attempt_ok).toBe(0);
    expect(after.last_error).toBe("ETIMEDOUT");
    expect(after.last_attempt_at).toBeGreaterThan(before.last_attempt_at);

    const g = await read();
    expect(g.body.aliases[0]).toMatchObject({ outcome: "alias", alias: "Lazy H Farms", last_attempt_ok: 0 });
  });

  it("a later definitive outcome DOES replace the alias (the pairing follows the outcome)", async () => {
    seedChannel(REAL, "1");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    await refresh();
    ln.scripts.set(REAL, resolves(REAL.slice(0, 20)));
    await refresh();
    expect(storeRow(REAL)).toMatchObject({ outcome: "none_announced", alias: null, last_attempt_ok: 1, last_error: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.5 — contacts.name is never written by the refresh.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.5 the refresh never writes contacts", () => {
  it("a contact whose name differs from the fresh alias is unchanged; no contact is created for a nameless peer", async () => {
    seedChannel(REAL, "1");
    seedChannel(DEFAULT, "2");
    seedContact(REAL, "Our Private Name");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    ln.scripts.set(DEFAULT, resolves("Also Public"));

    const r = await refresh();
    expect(r.status).toBe(200);

    // Anti-vacuity: the store DID learn the fresh alias.
    expect(storeRow(REAL)?.alias).toBe("Lazy H Farms");
    expect(storeRow(DEFAULT)?.alias).toBe("Also Public");

    const contacts = db.prepare("SELECT pubkey, name FROM contacts").all();
    expect(contacts, "the refresh is not a contacts writer (D7 §0, spec §6.1)").toEqual([
      { pubkey: REAL, name: "Our Private Name" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.6 — treasury only; the member-side contact sync still works.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.6 refused on a member node", () => {
  it("member: refresh and read → 403, and no lookup starts", async () => {
    roleState.node = { node_role: "member" };
    seedChannel(REAL, "1");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));

    expect((await refresh()).status).toBe(403);
    expect((await read()).status).toBe(403);
    expect(ln.calls, "a refused refresh must not reach LND").toEqual([]);
  });

  it("member: sync-peers still works there and inserts the real-alias contact", async () => {
    roleState.node = { node_role: "member" };
    ln.livePeers = [REAL];
    ln.scripts.set(REAL, resolves("Lazy H Farms"));

    const s = await call("POST", "/api/contacts/sync-peers");
    expect(s.status).toBe(200);
    expect(db.prepare("SELECT pubkey, name FROM contacts").all()).toEqual([{ pubkey: REAL, name: "Lazy H Farms" }]);
  });

  it("anti-vacuity: the same fixture on the TREASURY role → 200", async () => {
    seedChannel(REAL, "1");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    expect((await refresh()).status).toBe(200);
    expect((await read()).status).toBe(200);
  });

  it("an empty role (node info not yet persisted) is refused too", async () => {
    roleState.node = null;
    expect((await refresh()).status).toBe(403);
    expect((await read()).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.9 — coverage: the roster set, not sync-peers' set.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.9 coverage follows the roster (lnd_channels ∪ subscription)", () => {
  it("a channel-less subscription pubkey with no contact and no live peer IS looked up; a live-only peer is NOT", async () => {
    seedChannel(REAL, "1");
    seedSubscription(SUB_ONLY);
    ln.livePeers = [LIVE_ONLY];
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    ln.scripts.set(SUB_ONLY, resolves("Prairie Mill"));
    ln.scripts.set(LIVE_ONLY, resolves("Not A Member"));

    const r = await refresh();
    expect(r.body).toMatchObject({ total: 2, alias: 2 });
    expect(new Set(ln.calls)).toEqual(new Set([REAL, SUB_ONLY]));
    expect(storeRow(SUB_ONLY)?.alias).toBe("Prairie Mill");
    expect(storeRow(LIVE_ONLY), "a live peer that is not on the roster is not the refresh's business").toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.10 — case.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.10 case", () => {
  it("an uppercase channel pubkey is stored lowercase and read back lowercase", async () => {
    seedChannel(REAL.toUpperCase(), "1");
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    await refresh();

    expect(storeRow(REAL)?.alias).toBe("Lazy H Farms");
    expect(storeRow(REAL.toUpperCase()), "nothing stored under the uppercase key").toBeUndefined();
    const g = await read();
    expect(g.body.aliases.map((a: any) => a.pubkey)).toEqual([REAL]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11.12 — single-flight.
// ═══════════════════════════════════════════════════════════════════════════

describe("§11.12 single-flight", () => {
  it("a second refresh while one runs → 409 refresh_in_progress, and starts no lookups", async () => {
    seedChannel(REAL, "1");
    // Every caller's lookup is held until release() — so if a second refresh
    // DID start a lookup, it would be held too, and must not deadlock the test.
    const held: Array<() => void> = [];
    const release = () => held.splice(0).forEach((r) => r());
    ln.scripts.set(REAL, () => new Promise((resolve) => held.push(() => resolve({ alias: "Lazy H Farms" }))));

    const first = refresh();
    // Let the first request reach its lookup.
    await new Promise((r) => setTimeout(r, 5));
    expect(ln.calls).toEqual([REAL]);

    // ⚠ Checked BEFORE awaiting the second request. Awaiting first would make
    // a missing single-flight show up as a test TIMEOUT (the second refresh
    // waits on its own held lookup) rather than as this assertion — found by
    // mutation: removing the guard went red for the wrong reason.
    const secondPending = refresh();
    await new Promise((r) => setTimeout(r, 5));
    expect(ln.calls, "the refused refresh started nothing").toEqual([REAL]);

    const second = await secondPending;
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "refresh_in_progress" });

    release();
    const done = await first;
    expect(done.status).toBe(200);

    // The flag clears: a refresh after the first finishes is admitted.
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    expect((await refresh()).status).toBe(200);
  });
});
