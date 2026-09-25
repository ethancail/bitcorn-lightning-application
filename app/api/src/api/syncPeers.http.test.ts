// Route-level tests for POST /api/contacts/sync-peers after the public-alias
// change (bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §9,
// decision D7).
//
// THE HAZARD THIS FILE EXISTS FOR — spec §11 control 4, "D4 PRESERVED". The
// roster's Unidentified marker (D4) fires on "no contacts row", and treats ANY
// contacts row as a name. Before this change sync-peers inserted a row for
// every new peer, naming it with a pubkey-derived placeholder whenever the
// gossip lookup failed — and LND's 20-hex default alias arrives as a
// SUCCESSFUL lookup, so it was inserted as a "name" too. Either way the
// marker went silent on a member nobody had identified. The rule now: a
// contacts row is inserted ONLY for a real alias.
//
// ⚠ PRE-CHANGE RUN: the D4 test below was run against 30de308 before the route
// changed, and was red there — today's code inserts the placeholder and the
// default. That red is what makes the green after the change mean something.
//
// ⚠ NO LND. ln-service's getNode and lnd.ts's client/peers are scripted
// doubles; everything else, including the migration chain and SQLite, is real.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at module scope.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-sync-peers-db-"));
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

vi.mock("./read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
const { db } = await import("../db");
const { LND_GOSSIP_CALL_TIMEOUT_MS } = await import("../lightning/callDeadline");

// ─── Fixtures ──────────────────────────────────────────────────────────────

const pk = (byte: string) => "02" + byte.repeat(32);

const REAL = pk("a1"); //         a real announced alias
const DEFAULT = pk("a2"); //      LND's 20-hex default — a SUCCESSFUL answer
const EMPTY = pk("a3"); //        announced, alias empty
const PLACEHOLDER = pk("a4"); //  announces the route's old 8…6 placeholder
const UNKNOWN = pk("a5"); //      not in the graph (404 NodeIsUnknown)
const FAILS = pk("a6"); //        any other RPC failure
const HANGS = pk("a7"); //        never settles — the deadline must decide
const EXISTING = pk("a8"); //     already a contact

const resolves = (alias: string): Script => () => Promise.resolve({ alias });
const rejects = (err: unknown): Script => () => Promise.reject(err);
const hangs: Script = () => new Promise(() => {});

function seedChannel(peerPubkey: string, channelId: string): void {
  db.prepare(
    `INSERT INTO lnd_channels (
       channel_id, peer_pubkey, capacity_sat, local_balance_sat,
       remote_balance_sat, active, private, updated_at, first_seen_at
     ) VALUES (?, ?, 1000000, 500000, 500000, 1, 0, 0, 0)`,
  ).run(channelId, peerPubkey);
}

function seedContact(pubkey: string, name: string): void {
  db.prepare(
    "INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'manual', 0, 0)",
  ).run(pubkey, name);
}

const contactRows = () =>
  db.prepare("SELECT pubkey, name, source FROM contacts ORDER BY pubkey").all() as Array<{
    pubkey: string;
    name: string;
    source: string;
  }>;

async function syncPeers(): Promise<{ status: number | null; body: any }> {
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
  await handleRequest({ method: "POST", url: "/api/contacts/sync-peers", headers: {} } as any, res);
  let body: any = null;
  try {
    body = JSON.parse(captured.body);
  } catch {
    body = null;
  }
  return { status: captured.status, body };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  runMigrations();
});

beforeEach(() => {
  ln.scripts.clear();
  ln.calls = [];
  ln.livePeers = [];
  roleState.node = { node_role: "treasury" };
  db.exec("DELETE FROM contacts; DELETE FROM lnd_channels;");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/contacts/sync-peers — no pubkey-derived names (spec §9, §11.4)", () => {
  it("D4 PRESERVED: only the real-alias peer gets a contacts row; every other outcome creates NONE", async () => {
    // One channel peer (REAL), the rest live peers, and one existing contact.
    seedChannel(REAL, "1");
    seedContact(EXISTING, "Kept Name");
    ln.livePeers = [DEFAULT, EMPTY, PLACEHOLDER, UNKNOWN, FAILS, HANGS, EXISTING];

    ln.scripts.set(REAL, resolves("  Lazy H Farms  "));
    ln.scripts.set(DEFAULT, resolves(DEFAULT.slice(0, 20)));
    ln.scripts.set(EMPTY, resolves(""));
    ln.scripts.set(PLACEHOLDER, resolves(`${PLACEHOLDER.slice(0, 8)}…${PLACEHOLDER.slice(-6)}`));
    ln.scripts.set(UNKNOWN, rejects([404, "NodeIsUnknown"]));
    ln.scripts.set(FAILS, rejects([503, "FailedToRetrieveNodeDetails", { err: { details: "boom" } }]));
    ln.scripts.set(HANGS, hangs);

    // Only setTimeout is faked, so the hanging lookup's DEADLINE decides it
    // rather than the suite's own 10s test timeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: { status: number | null; body: any };
    try {
      const pending = syncPeers();
      await vi.advanceTimersByTimeAsync(LND_GOSSIP_CALL_TIMEOUT_MS + 1);
      result = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(result.status).toBe(200);

    // Anti-vacuity FIRST: the real-alias peer IS inserted, trimmed, as 'auto'.
    // Without this the absence below passes on a route that inserts nothing.
    const rows = contactRows();
    expect(rows.find((r) => r.pubkey === REAL)).toEqual({
      pubkey: REAL,
      name: "Lazy H Farms",
      source: "auto",
    });

    // The forbidding half: exactly two rows exist — the real alias and the
    // pre-existing contact, whose name is untouched.
    expect(
      rows.map((r) => r.pubkey),
      "a failed, timed-out, 404, empty, default or placeholder lookup must create NO contacts row " +
        "— any row reads as a name to the roster and silences D4's Unidentified marker",
    ).toEqual([REAL, EXISTING].sort());
    expect(rows.find((r) => r.pubkey === EXISTING)?.name).toBe("Kept Name");

    // Every peer that was not already a contact was actually looked up — the
    // absence of rows is not the absence of lookups.
    expect(new Set(ln.calls)).toEqual(new Set([REAL, DEFAULT, EMPTY, PLACEHOLDER, UNKNOWN, FAILS, HANGS]));
    expect(ln.calls, "an existing contact is skipped before any lookup").not.toContain(EXISTING);

    // §9.4: additive per-outcome counts; `added` / `skipped` keep their meaning.
    expect(result.body).toEqual({
      ok: true,
      added: 1,
      skipped: 1,
      none_announced: 3, // DEFAULT, EMPTY, PLACEHOLDER
      not_in_graph: 1, //   UNKNOWN
      failed: 2, //         FAILS, HANGS
    });
  });

  it("a MEMBER node's sync still works — ungated — and still inserts no default-alias row", async () => {
    roleState.node = { node_role: "member" };
    ln.livePeers = [REAL, DEFAULT];
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    ln.scripts.set(DEFAULT, resolves(DEFAULT.slice(0, 20)));

    const { status, body } = await syncPeers();

    expect(status, "sync-peers is not gated by role (spec §9.6)").toBe(200);
    expect(contactRows().map((r) => r.pubkey)).toEqual([REAL]);
    expect(body).toMatchObject({ ok: true, added: 1, skipped: 0, none_announced: 1 });
  });

  it("sync-peers does not write the treasury's public-alias store (spec §9.3)", async () => {
    ln.livePeers = [REAL, UNKNOWN];
    ln.scripts.set(REAL, resolves("Lazy H Farms"));
    ln.scripts.set(UNKNOWN, rejects([404, "NodeIsUnknown"]));

    const { status } = await syncPeers();
    expect(status).toBe(200);

    // Anti-vacuity: the store table EXISTS (so a zero count is not a missing
    // table), and the sync DID do work (the contacts row).
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peer_public_alias'")
      .get();
    expect(table, "migration 057 should have created peer_public_alias").toBeDefined();
    expect(contactRows().map((r) => r.pubkey)).toEqual([REAL]);

    const { n } = db.prepare("SELECT count(*) AS n FROM peer_public_alias").get() as { n: number };
    expect(n, "sync-peers runs on member nodes too; the store is the treasury refresh's alone").toBe(0);
  });
});
