// P0 Suite C — characterization of the credential routes (index.ts
// POST/DELETE /api/autobuy/credentials, POST /api/autobuy/credentials/verify)
// and the /enable counter reset (S6), driven through the real handleRequest.
//
// Authority: bitcorn-research/specs/2026-11-18-kraken-autobuy-slice-1-spec.md
// §3 P0 (credential routes), decisions D3, D3+, S6. PINS CURRENT BEHAVIOUR.
//
// Deviation from the spec, reported in P0: the spec lists the /enable reset pin
// under Suite B. /enable is a route; runTick cannot reach it, so it lives here.
//
// ─── HARNESS ───────────────────────────────────────────────────────────────
// The catchup.route.test.ts pattern: a temp DB_DIR, ../index imported
// dynamically in beforeAll, migrations run by hand, an lnd_node_info row with
// node_role 'member'. SECRETS_DIR is ALSO a temp dir, set before that import,
// because credentials.ts:20 reads it at module load.
//
// ─── MOCK BOUNDARY ─────────────────────────────────────────────────────────
// ./coinbaseClient and ./valuationClient only. ./credentials is NOT mocked:
// storage goes through real AES-256-GCM with a real master key in the temp
// SECRETS_DIR — the route half of D3+.
//
// ─── MODULE STATE ──────────────────────────────────────────────────────────
// One module instance and one master key for the whole file: cachedKey
// (credentials.ts:58) deliberately stays warm. Cases that need a fresh key are
// Suite D's. Nothing here ticks, so tickInFlight is never set.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-cred-route-db-"));
const TMP_SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-cred-route-secrets-"));

vi.hoisted(() => {
  process.env.AUTOBUY_ENABLED = "true";
  process.env.AUTOBUY_FAILURE_PAUSE_THRESHOLD = "3";
});
process.env.DB_DIR = TMP_DB;
process.env.SECRETS_DIR = TMP_SECRETS;

const stubs = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  listAccounts: vi.fn(),
  placeMarketBuy: vi.fn(),
  pollOrder: vi.fn(),
  placeWithdraw: vi.fn(),
  pollWithdraw: vi.fn(),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.listAccounts,
  placeMarketBuy: stubs.placeMarketBuy,
  pollOrder: stubs.pollOrder,
  placeWithdraw: stubs.placeWithdraw,
  pollWithdraw: stubs.pollWithdraw,
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let realDecrypt: (blob: { ciphertext: Buffer; nonce: Buffer }) => string;
let db: Database.Database;

const PEM = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIStubStubStubStubStubStubStubStubStub\n-----END EC PRIVATE KEY-----\n";
const KEY_NAME = "organizations/org-1/apiKeys/key-1";
const OK_ACCOUNTS = {
  ok: true,
  status: 200,
  data: {
    accounts: [
      { uuid: "u1", name: "USD", currency: "USD", available_balance: { value: "12.50", currency: "USD" } },
      { uuid: "u2", name: "BTC", currency: "BTC", available_balance: { value: "0.00100000", currency: "BTC" } },
    ],
  },
};

type Captured = { status: number; body: any; raw: string };

function call(method: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<Captured> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { "content-type": "application/json", ...headers };
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
      resolve({ status, body: parsed, raw: chunks });
    };
    const res = {
      setHeader() {}, getHeader() {},
      writeHead(s: number) { status = s; return res; },
      end(c?: any) { if (c) chunks += c.toString(); finish(); },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;

    void handleRequest(req, res);
    setImmediate(() => { (req as unknown as PassThrough).end(raw); });
    setTimeout(() => { if (!done) { status = -1; chunks = ""; finish(); } }, 6000);
  });
}

const postCreds = (body: unknown) => call("POST", "/api/autobuy/credentials", body);
const verify = () => call("POST", "/api/autobuy/credentials/verify", {});
const credRow = () =>
  db.prepare(`SELECT * FROM coinbase_credentials WHERE id = 1`).get() as
    | { key_name: string; encrypted_private_key: Buffer; nonce: Buffer; connected_at: number; last_verified_at: number | null }
    | undefined;
const cfg = () =>
  db.prepare(`SELECT enabled, paused_reason, consecutive_failures, withdraw_address FROM autobuy_config WHERE id = 1`).get() as any;
const nowSec = () => Math.floor(Date.now() / 1000);

function setConfig(over: Record<string, unknown>): void {
  const cols = Object.keys(over);
  db.prepare(`UPDATE autobuy_config SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = 1`).run(
    ...cols.map((c) => over[c]),
  );
}

/** A stored credential row with known bytes, written without the route. */
function insertPriorRow(): void {
  db.prepare(
    `INSERT OR REPLACE INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at, last_verified_at)
     VALUES (1, 'prior-key', ?, ?, 1000, 1000)`,
  ).run(Buffer.from("prior-ciphertext-bytes"), Buffer.from("prior-nonce1"));
}

beforeAll(async () => {
  ({ handleRequest } = await import("../index"));
  ({ decrypt: realDecrypt } = await import("./credentials"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = new Database(path.join(TMP_DB, "bitcorn.sqlite"));
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, alias, network, updated_at, node_role)
     VALUES (1, 'pk', 'test', 'regtest', ?, 'member')`,
  ).run(nowSec());
});

afterAll(() => {
  db?.close();
  fs.rmSync(TMP_DB, { recursive: true, force: true });
  fs.rmSync(TMP_SECRETS, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  stubs.listAccounts.mockResolvedValue(OK_ACCOUNTS);
  db.prepare(`DELETE FROM coinbase_credentials`).run();
  setConfig({
    enabled: 0,
    paused_reason: null,
    consecutive_failures: 0,
    withdraw_address: "bc1qconfigured",
    withdraw_address_whitelisted_at: nowSec() - 86400,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/autobuy/credentials
// ─────────────────────────────────────────────────────────────────────────────
describe("C · POST /api/autobuy/credentials", () => {
  it("C1 json_blob form ({name, privateKey}) -> 200 {ok, key_name, connected_at}; listAccounts got the parsed credentials", async () => {
    const before = nowSec();
    const res = await postCreds({ json_blob: JSON.stringify({ name: KEY_NAME, privateKey: PEM }) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.key_name).toBe(KEY_NAME);
    expect(res.body.connected_at).toBeGreaterThanOrEqual(before);
    expect(res.body.connected_at).toBeLessThanOrEqual(nowSec());
    expect(stubs.listAccounts).toHaveBeenCalledTimes(1);
    expect(stubs.listAccounts).toHaveBeenCalledWith({ keyName: KEY_NAME, privateKeyPem: PEM });
    const row = credRow()!;
    expect(row.key_name).toBe(KEY_NAME);
    expect(row.connected_at).toBe(res.body.connected_at);
    expect(row.last_verified_at).toBe(res.body.connected_at);
  });

  it("C2 key_name / private_key form -> 200, same storage", async () => {
    const res = await postCreds({ key_name: KEY_NAME, private_key: PEM });
    expect(res.status).toBe(200);
    expect(stubs.listAccounts).toHaveBeenCalledWith({ keyName: KEY_NAME, privateKeyPem: PEM });
    expect(credRow()!.key_name).toBe(KEY_NAME);
  });

  it("C3 the stored blob is real AES-GCM: ciphertext != plaintext, 12-byte nonce, length = bytes + 16, and real decrypt returns the PEM (D3+)", async () => {
    await postCreds({ key_name: KEY_NAME, private_key: PEM });
    const row = credRow()!;
    expect(row.nonce.length).toBe(12);
    expect(row.encrypted_private_key.length).toBe(Buffer.byteLength(PEM, "utf8") + 16);
    expect(row.encrypted_private_key.toString("utf8")).not.toContain("PRIVATE KEY");
    expect(realDecrypt({ ciphertext: row.encrypted_private_key, nonce: row.nonce })).toBe(PEM);
    expect(fs.existsSync(path.join(TMP_SECRETS, "master.key"))).toBe(true);
  });

  it("C4 json_blob that is not JSON -> 400 invalid_json_blob; no live call", async () => {
    const res = await postCreds({ json_blob: "{not json" });
    expect(res).toMatchObject({ status: 400, body: { error: "invalid_json_blob" } });
    expect(stubs.listAccounts).not.toHaveBeenCalled();
  });

  for (const [label, body] of [
    ["no fields", {}],
    ["key_name only", { key_name: KEY_NAME }],
    ["private_key only", { private_key: PEM }],
    ["json_blob missing privateKey", { json_blob: JSON.stringify({ name: KEY_NAME }) }],
  ] as const) {
    it(`C5 ${label} -> 400 key_name_and_private_key_required; no live call`, async () => {
      const res = await postCreds(body);
      expect(res).toMatchObject({ status: 400, body: { error: "key_name_and_private_key_required" } });
      expect(stubs.listAccounts).not.toHaveBeenCalled();
    });
  }

  it("C6 a private key without the PEM markers -> 400 invalid_private_key_format; no live call", async () => {
    const res = await postCreds({ key_name: KEY_NAME, private_key: "MHcCAQEEI-no-markers" });
    expect(res).toMatchObject({ status: 400, body: { error: "invalid_private_key_format" } });
    expect(stubs.listAccounts).not.toHaveBeenCalled();
  });

  for (const [upstream, expected] of [[401, 401], [403, 401], [500, 502], [0, 502]] as const) {
    it(`C7 live verification ${upstream} -> ${expected} verification_failed + detail; NOTHING stored, the prior row untouched`, async () => {
      insertPriorRow();
      const prior = credRow()!;
      stubs.listAccounts.mockResolvedValue({ ok: false, status: upstream, error: `upstream-${upstream}` });
      const res = await postCreds({ key_name: KEY_NAME, private_key: PEM });
      expect(res.status).toBe(expected);
      expect(res.body).toEqual({ error: "verification_failed", detail: `upstream-${upstream}` });
      expect(credRow()).toEqual(prior);
    });
  }

  it("C8 a second POST replaces the singleton row", async () => {
    await postCreds({ key_name: "first-key", private_key: PEM });
    const first = credRow()!;
    const PEM2 = PEM.replace("Stub", "Next");
    await postCreds({ key_name: "second-key", private_key: PEM2 });
    const second = credRow()!;
    expect((db.prepare(`SELECT COUNT(*) AS n FROM coinbase_credentials`).get() as any).n).toBe(1);
    expect(second.key_name).toBe("second-key");
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(realDecrypt({ ciphertext: second.encrypted_private_key, nonce: second.nonce })).toBe(PEM2);
  });

  for (const [reason, after] of [
    ["no_credentials", null],
    ["credentials_invalid", null],
    ["credentials_corrupted", null],
    ["user_paused", "user_paused"],
    ["consecutive_failures", "consecutive_failures"],
    ["address_not_whitelisted", "address_not_whitelisted"],
  ] as const) {
    it(`C9 paused_reason ${reason} -> ${after ?? "NULL"}; enabled is not changed`, async () => {
      setConfig({ enabled: 0, paused_reason: reason });
      const res = await postCreds({ key_name: KEY_NAME, private_key: PEM });
      expect(res.status).toBe(200);
      expect(cfg()).toMatchObject({ enabled: 0, paused_reason: after });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/autobuy/credentials
// ─────────────────────────────────────────────────────────────────────────────
describe("C · DELETE /api/autobuy/credentials", () => {
  it("C10 -> 200; row gone; enabled 0, paused no_credentials; withdraw_address unchanged", async () => {
    await postCreds({ key_name: KEY_NAME, private_key: PEM });
    setConfig({ enabled: 1, paused_reason: null });
    const res = await call("DELETE", "/api/autobuy/credentials", undefined);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(credRow()).toBeUndefined();
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "no_credentials", withdraw_address: "bc1qconfigured" });
  });

  it("C11 with no row -> still 200", async () => {
    const res = await call("DELETE", "/api/autobuy/credentials", undefined);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/autobuy/credentials/verify
// ─────────────────────────────────────────────────────────────────────────────
describe("C · POST /api/autobuy/credentials/verify", () => {
  it("C12 no row -> 400 no_credentials; no live call", async () => {
    const res = await verify();
    expect(res).toMatchObject({ status: 400, body: { error: "no_credentials" } });
    expect(stubs.listAccounts).not.toHaveBeenCalled();
  });

  it("C13 a tampered blob -> 500 credentials_corrupted; no live call", async () => {
    await postCreds({ key_name: KEY_NAME, private_key: PEM });
    const row = credRow()!;
    const tampered = Buffer.from(row.encrypted_private_key);
    tampered[0] ^= 0xff;
    db.prepare(`UPDATE coinbase_credentials SET encrypted_private_key = ? WHERE id = 1`).run(tampered);
    stubs.listAccounts.mockClear();

    const res = await verify();
    expect(res).toMatchObject({ status: 500, body: { error: "credentials_corrupted" } });
    expect(stubs.listAccounts).not.toHaveBeenCalled();
  });

  for (const [upstream, expected] of [[401, 401], [403, 401], [500, 502]] as const) {
    it(`C14 live ${upstream} -> ${expected} {ok:false, status, error}; last_verified_at unchanged`, async () => {
      await postCreds({ key_name: KEY_NAME, private_key: PEM });
      db.prepare(`UPDATE coinbase_credentials SET last_verified_at = 5 WHERE id = 1`).run();
      stubs.listAccounts.mockResolvedValue({ ok: false, status: upstream, error: `upstream-${upstream}` });
      const res = await verify();
      expect(res.status).toBe(expected);
      expect(res.body).toEqual({ ok: false, status: upstream, error: `upstream-${upstream}` });
      expect(credRow()!.last_verified_at).toBe(5);
    });
  }

  it("C15 ok -> 200; accounts mapped to {currency, available: Number}; last_verified_at updated; listAccounts got the ORIGINAL PEM", async () => {
    await postCreds({ key_name: KEY_NAME, private_key: PEM });
    db.prepare(`UPDATE coinbase_credentials SET last_verified_at = 5 WHERE id = 1`).run();
    stubs.listAccounts.mockClear();
    const before = nowSec();

    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accounts).toEqual([
      { currency: "USD", available: 12.5 },
      { currency: "BTC", available: 0.001 },
    ]);
    expect(res.body.last_verified_at).toBeGreaterThanOrEqual(before);
    expect(credRow()!.last_verified_at).toBe(res.body.last_verified_at);
    expect(stubs.listAccounts).toHaveBeenCalledWith({ keyName: KEY_NAME, privateKeyPem: PEM });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gates in front of all three
// ─────────────────────────────────────────────────────────────────────────────
describe("C · gates", () => {
  it("C16 an empty node_role -> 403 on all three routes (getNodeInfo reads the row live)", async () => {
    db.prepare(`UPDATE lnd_node_info SET node_role = '' WHERE id = 1`).run();
    try {
      expect((await postCreds({ key_name: KEY_NAME, private_key: PEM })).status).toBe(403);
      expect((await call("DELETE", "/api/autobuy/credentials", undefined)).status).toBe(403);
      expect((await verify()).status).toBe(403);
      expect(stubs.listAccounts).not.toHaveBeenCalled();
    } finally {
      db.prepare(`UPDATE lnd_node_info SET node_role = 'member' WHERE id = 1`).run();
    }
  });

  it("C17 none of the three needs x-bitcorn-confirm (EXEMPT_MUTATIONS) — while a confirmed route in the same harness does", async () => {
    // Anti-vacuity: prove the gate is live here, so the three 200s below mean
    // "exempt", not "the harness bypasses the gate".
    const gated = await call("POST", "/api/autobuy/catch-up", { expected_intervals: 1, expected_usd: 100 });
    expect(gated.status).toBe(400);
    expect(gated.body.error).toBe("confirmation_required");

    expect((await postCreds({ key_name: KEY_NAME, private_key: PEM })).status).toBe(200);
    expect((await verify()).status).toBe(200);
    expect((await call("DELETE", "/api/autobuy/credentials", undefined)).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/autobuy/enable — the counter's route reset (S6, index.ts /enable)
// ─────────────────────────────────────────────────────────────────────────────
describe("C · POST /api/autobuy/enable", () => {
  it("C18 no credentials -> 400 no_credentials; config unchanged", async () => {
    setConfig({ enabled: 0, paused_reason: "no_credentials", consecutive_failures: 2 });
    const res = await call("POST", "/api/autobuy/enable", {});
    expect(res).toMatchObject({ status: 400, body: { error: "no_credentials" } });
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "no_credentials", consecutive_failures: 2 });
  });

  it("C19 not whitelisted -> 400 address_not_whitelisted; config unchanged", async () => {
    insertPriorRow();
    setConfig({ enabled: 0, withdraw_address_whitelisted_at: null, paused_reason: "user_paused", consecutive_failures: 2 });
    const res = await call("POST", "/api/autobuy/enable", {});
    expect(res).toMatchObject({ status: 400, body: { error: "address_not_whitelisted" } });
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "user_paused", consecutive_failures: 2 });
  });

  it("C20 success -> 200; enabled 1, paused_reason NULL, consecutive_failures RESET to 0", async () => {
    insertPriorRow();
    setConfig({ enabled: 0, paused_reason: "consecutive_failures", consecutive_failures: 3 });
    const res = await call("POST", "/api/autobuy/enable", {});
    expect(res).toMatchObject({ status: 200, body: { ok: true, enabled: true } });
    expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 0 });
  });
});
