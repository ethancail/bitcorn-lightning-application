// kraken-autobuy P2, migrations 084–088 (Slice 1 spec §3 P2; rulings S1–S4).
//
//   084 autobuy_config.provider     085 autobuy_runs.provider
//   086 autobuy_sweeps.provider     087 kraken_credentials
//   088 autobuy_balance_snapshot
//   089 kraken_nonce (P3, ruling K2; M7–M9 at the end of this file)
//
// What the spec's done-when asks: the files apply on a fresh DB (M1) and on a
// DB at 083 holding Coinbase rows, which then read 'coinbase' (M2). M2 is the
// case the negative control (remove the default) turns red.
//
// Why one statement per file (M5): db/migrate.ts runs a file whole, with no
// transaction, and on "duplicate column"/"already exists" marks the WHOLE file
// applied. A second statement after a swallowed first is skipped for good.
// M4 shows the one-statement files recover from a crash between exec and the
// migrations-table insert.
//
// Harness: migrate.transferSettings.test.ts's fresh-runner technique, extended
// to reopen the SAME database directory with a different migrations directory,
// which is how M2 stops a DB at 083 and then upgrades it.

import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REAL_MIGRATIONS_DIR = path.resolve(__dirname, "migrations");
const P2_FILES = [
  "084_autobuy_config_provider.sql",
  "085_autobuy_runs_provider.sql",
  "086_autobuy_sweeps_provider.sql",
  "087_kraken_credentials.sql",
  "088_autobuy_balance_snapshot.sql",
];
const PROVIDER_TABLES = ["autobuy_config", "autobuy_runs", "autobuy_sweeps"] as const;

type Runner = { runMigrations: () => void; db: Database.Database };
const opened: Database.Database[] = [];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** A fresh migrate/db module pair over `dbDir`, reading migrations from `migrationsDir` (default: the real ones). */
async function loadRunner(dbDir: string, migrationsDir?: string): Promise<Runner> {
  vi.resetModules();
  process.env.DB_DIR = dbDir;
  if (migrationsDir) {
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      const redirect = (p: any) =>
        typeof p === "string" && p.startsWith(REAL_MIGRATIONS_DIR) ? migrationsDir + p.slice(REAL_MIGRATIONS_DIR.length) : p;
      const patched = {
        ...actual,
        existsSync: (p: any) => actual.existsSync(redirect(p)),
        readdirSync: (p: any, ...rest: any[]) => (actual.readdirSync as any)(redirect(p), ...rest),
        readFileSync: (p: any, ...rest: any[]) => (actual.readFileSync as any)(redirect(p), ...rest),
      };
      return { ...patched, default: patched };
    });
  } else {
    vi.doUnmock("fs");
  }
  const { runMigrations } = await import("./migrate");
  const { db } = await import("./index");
  opened.push(db);
  return { runMigrations, db };
}

/** A migrations directory holding only the files numbered at or below 083: a node at the current head. */
function migrationsAt083(): string {
  const dir = tempDir("bitcorn-migrations-083-");
  for (const f of fs.readdirSync(REAL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && parseInt(f.slice(0, 3), 10) <= 83) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, f), path.join(dir, f));
    }
  }
  return dir;
}

type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const tableInfo = (db: Database.Database, t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as Col[];
const colNames = (db: Database.Database, t: string) => tableInfo(db, t).map((c) => c.name);
const applied = (db: Database.Database) =>
  db.prepare("SELECT id, applied_at FROM migrations ORDER BY id").all() as Array<{ id: string; applied_at: number }>;

/** Statements in a migration file: semicolons outside `--` comment lines. */
const statements = (file: string) =>
  fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, file), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").filter((s) => s.trim().length > 0).length;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const db of opened) { try { db.close(); } catch { /* already closed */ } }
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("migrations 084–088 (kraken-autobuy P2)", () => {
  it("M1 a fresh DB: each provider column is TEXT NOT NULL DEFAULT 'coinbase'; both new tables have exactly the planned columns; each file recorded", async () => {
    const { runMigrations, db } = await loadRunner(tempDir("bitcorn-mig-kraken-fresh-"));
    runMigrations();
    for (const t of PROVIDER_TABLES) {
      const p = tableInfo(db, t).find((c) => c.name === "provider");
      expect(p, t).toBeDefined();
      expect({ type: p!.type, notnull: p!.notnull, dflt: p!.dflt_value }, t).toEqual({ type: "TEXT", notnull: 1, dflt: "'coinbase'" });
    }
    expect(colNames(db, "kraken_credentials")).toEqual([
      "id", "api_key", "encrypted_secret", "nonce", "connected_at", "last_verified_at", "withdraw_method_id", "withdraw_address_id",
    ]);
    expect(colNames(db, "autobuy_balance_snapshot")).toEqual(["provider", "usd_available", "usdc_available", "btc_available", "read_at"]);
    const ids = applied(db).map((r) => r.id);
    for (const f of P2_FILES) expect(ids.filter((id) => id === f), f).toHaveLength(1);
    // The seeded config singleton (034) reads 'coinbase' on a fresh node too.
    expect(db.prepare("SELECT provider FROM autobuy_config WHERE id = 1").get()).toEqual({ provider: "coinbase" });
  });

  it("M2 a DB at 083 holding Coinbase rows: after 084–088 every row reads 'coinbase' and every other column is unchanged", async () => {
    const dbDir = tempDir("bitcorn-mig-kraken-083-");
    const at083 = await loadRunner(dbDir, migrationsAt083());
    at083.runMigrations();
    const db0 = at083.db;
    for (const t of PROVIDER_TABLES) expect(colNames(db0, t), t).not.toContain("provider");
    expect(applied(db0).map((r) => r.id).at(-1)).toBe("083_subscription_deposit_address_pin.sql");

    // Coinbase-era state: a customised config, runs in every status (filled,
    // in flight, skipped, failed), a confirmed and a failed sweep, a credential.
    db0.prepare(
      `UPDATE autobuy_config SET enabled = 1, base_unit_usd = 250, withdraw_address = 'bc1qfarm',
         withdraw_address_whitelisted_at = 1790000000, sweep_day_of_week = 3, currency_preference = 'usd_only',
         consecutive_failures = 1, last_run_at = 1790000000, next_run_at = 1790604800 WHERE id = 1`,
    ).run();
    const STATUSES = [
      "scheduled", "buy_placed", "buy_filled", "awaiting_withdraw_hold", "sweep_assigned", "withdraw_placed",
      "withdraw_confirmed", "skipped_stale_data", "skipped_zero_multiplier", "skipped_cap_hit",
      "skipped_insufficient_funds", "skipped_missed_interval", "failed_buy", "failed_withdraw",
    ];
    const insRun = db0.prepare(
      `INSERT INTO autobuy_runs (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd, status,
         coinbase_order_id, filled_btc, filled_usd, filled_at, currency_used, created_at, updated_at)
       VALUES (?, -0.4, 'fair_value', 1, 250, 250, ?, ?, ?, ?, ?, 'USD', ?, ?)`,
    );
    STATUSES.forEach((s, i) => {
      const filled = ["buy_filled", "awaiting_withdraw_hold", "sweep_assigned", "withdraw_placed", "withdraw_confirmed"].includes(s);
      insRun.run(1789000000 + i * 604800, s, filled ? `cb-order-${i}` : null, filled ? 0.0025 : null, filled ? 250 : null,
        filled ? 1789000600 + i * 604800 : null, 1789000000 + i, 1789000000 + i);
    });
    const insSweep = db0.prepare(
      `INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, withdraw_txid, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insSweep.run(1789500000, 0.005, "cb-tx-1", "txid-1", "confirmed", null);
    insSweep.run(1790100000, 0.0025, null, null, "failed", "withdraw_address_rejected");
    db0.prepare(
      `INSERT INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at, last_verified_at)
       VALUES (1, 'organizations/x/apiKeys/y', ?, ?, 1788000000, 1790000000)`,
    ).run(Buffer.from([1, 2, 3, 250]), Buffer.from("123456789012"));

    const dump = (db: Database.Database, t: string) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    const before = Object.fromEntries([...PROVIDER_TABLES, "coinbase_credentials"].map((t) => [t, dump(db0, t)]));
    const appliedBefore = applied(db0);
    expect(before.autobuy_runs).toHaveLength(STATUSES.length);
    db0.close();

    const upgraded = await loadRunner(dbDir);
    upgraded.runMigrations();
    const db = upgraded.db;

    for (const t of PROVIDER_TABLES) {
      const after = dump(db, t);
      expect(after.map((r) => r.provider), t).toEqual(before[t].map(() => "coinbase"));
      expect(after.map(({ provider, ...rest }) => rest), t).toEqual(before[t]);
    }
    expect(dump(db, "coinbase_credentials")).toEqual(before.coinbase_credentials);
    // 001–083 were not re-run; 084–088 were applied once each.
    const appliedAfter = applied(db);
    expect(appliedAfter.slice(0, appliedBefore.length)).toEqual(appliedBefore);
    // Later migrations (089 on) may follow; the five P2 files come first, in order.
    expect(appliedAfter.slice(appliedBefore.length, appliedBefore.length + P2_FILES.length).map((r) => r.id)).toEqual(P2_FILES);
  });

  it("M3 the CHECK admits 'coinbase' and 'kraken' and refuses anything else, on all four tables; kraken_credentials is a singleton", async () => {
    const { runMigrations, db } = await loadRunner(tempDir("bitcorn-mig-kraken-check-"));
    runMigrations();
    db.prepare("UPDATE autobuy_config SET provider = 'kraken' WHERE id = 1").run();
    expect(() => db.prepare("UPDATE autobuy_config SET provider = 'binance' WHERE id = 1").run()).toThrow(/CHECK constraint failed/);

    const run = (p: string) => db.prepare(
      `INSERT INTO autobuy_runs (scheduled_for, status, created_at, updated_at, provider) VALUES (1, 'scheduled', 1, 1, ?)`,
    ).run(p);
    run("kraken");
    run("coinbase");
    expect(() => run("binance")).toThrow(/CHECK constraint failed/);

    const sweep = (p: string) => db.prepare(
      `INSERT INTO autobuy_sweeps (swept_at, btc_amount, status, provider) VALUES (1, 0.001, 'placed', ?)`,
    ).run(p);
    sweep("kraken");
    expect(() => sweep("Kraken")).toThrow(/CHECK constraint failed/);

    const snap = (p: string | null) => db.prepare(
      `INSERT INTO autobuy_balance_snapshot (provider, read_at) VALUES (?, 1)`,
    ).run(p);
    snap("kraken");
    expect(() => snap("binance")).toThrow(/CHECK constraint failed/);
    expect(() => snap(null)).toThrow(/NOT NULL constraint failed/);

    const cred = (id: number) => db.prepare(
      `INSERT INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at) VALUES (?, 'k', x'00', x'01', 1)`,
    ).run(id);
    cred(1);
    expect(() => cred(2)).toThrow(/CHECK constraint failed/);
  });

  it("M4 a re-boot is a no-op; a crash after exec but before the record (084–088 unrecorded) recovers on the next boot with the schema complete", async () => {
    const { runMigrations, db } = await loadRunner(tempDir("bitcorn-mig-kraken-rerun-"));
    runMigrations();
    const once = applied(db);
    runMigrations();
    expect(applied(db)).toEqual(once);

    db.prepare(`DELETE FROM migrations WHERE id IN (${P2_FILES.map(() => "?").join(",")})`).run(...P2_FILES);
    expect(() => runMigrations()).not.toThrow();
    const ids = applied(db).map((r) => r.id);
    for (const f of P2_FILES) expect(ids, f).toContain(f);
    for (const t of PROVIDER_TABLES) expect(colNames(db, t), t).toContain("provider");
    expect(colNames(db, "kraken_credentials")).toContain("withdraw_address_id");
    expect(colNames(db, "autobuy_balance_snapshot")).toContain("read_at");
  });

  it("M5 each of 084–088 holds exactly one statement", () => {
    for (const f of P2_FILES) expect(statements(f), f).toBe(1);
  });

  it("M6 the balance snapshot keeps one row per provider: a second insert for a provider is refused, an upsert replaces it", async () => {
    const { runMigrations, db } = await loadRunner(tempDir("bitcorn-mig-kraken-snap-"));
    runMigrations();
    const upsert = db.prepare(
      `INSERT INTO autobuy_balance_snapshot (provider, usd_available, usdc_available, btc_available, read_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET usd_available = excluded.usd_available, usdc_available = excluded.usdc_available,
         btc_available = excluded.btc_available, read_at = excluded.read_at`,
    );
    upsert.run("kraken", 100, null, 0.001, 1000);
    upsert.run("kraken", 75, 20, 0.002, 1900);
    upsert.run("coinbase", 10, 5, null, 1900);
    expect(db.prepare("SELECT * FROM autobuy_balance_snapshot ORDER BY provider").all()).toEqual([
      { provider: "coinbase", usd_available: 10, usdc_available: 5, btc_available: null, read_at: 1900 },
      { provider: "kraken", usd_available: 75, usdc_available: 20, btc_available: 0.002, read_at: 1900 },
    ]);
    expect(() => db.prepare(`INSERT INTO autobuy_balance_snapshot (provider, read_at) VALUES ('kraken', 2000)`).run())
      .toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });
});

// ─── 089 kraken_nonce (kraken-autobuy P3, ruling K2) ─────────────────────────
const NONCE_FILE = "089_kraken_nonce.sql";

/** A migrations directory holding only the files numbered at or below 088. */
function migrationsAt088(): string {
  const dir = tempDir("bitcorn-migrations-088-");
  for (const f of fs.readdirSync(REAL_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && parseInt(f.slice(0, 3), 10) <= 88) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, f), path.join(dir, f));
    }
  }
  return dir;
}

describe("migration 089 (kraken-autobuy P3)", () => {
  it("M7 a fresh DB: kraken_nonce has exactly (id, last_nonce), last_nonce TEXT NOT NULL, no row; 089 recorded once", async () => {
    const { runMigrations, db } = await loadRunner(tempDir("bitcorn-mig-nonce-fresh-"));
    runMigrations();
    expect(tableInfo(db, "kraken_nonce").map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }))).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "last_nonce", type: "TEXT", notnull: 1, pk: 0 },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM kraken_nonce").get() as { n: number }).n).toBe(0);
    expect(applied(db).filter((r) => r.id === NONCE_FILE)).toHaveLength(1);
  });

  it("M8 a DB at 088 holding P2-era rows: 089 applies, nothing else changes, and a re-boot is a no-op", async () => {
    const dbDir = tempDir("bitcorn-mig-nonce-088-");
    const at088 = await loadRunner(dbDir, migrationsAt088());
    at088.runMigrations();
    const db0 = at088.db;
    expect(colNames(db0, "kraken_nonce")).toEqual([]);
    db0.prepare(
      `INSERT INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at) VALUES (1, 'k', x'00', x'01', 1)`,
    ).run();
    db0.prepare(`INSERT INTO autobuy_balance_snapshot (provider, usd_available, read_at) VALUES ('kraken', 50, 9)`).run();
    const dump = (db: Database.Database, t: string) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    const before = { creds: dump(db0, "kraken_credentials"), snap: dump(db0, "autobuy_balance_snapshot"), applied: applied(db0) };
    db0.close();

    const upgraded = await loadRunner(dbDir);
    upgraded.runMigrations();
    const db = upgraded.db;
    expect(colNames(db, "kraken_nonce")).toEqual(["id", "last_nonce"]);
    expect(dump(db, "kraken_credentials")).toEqual(before.creds);
    expect(dump(db, "autobuy_balance_snapshot")).toEqual(before.snap);
    const after = applied(db);
    expect(after.slice(0, before.applied.length)).toEqual(before.applied);
    expect(after.slice(before.applied.length).map((r) => r.id)).toEqual([NONCE_FILE]);
    upgraded.runMigrations();
    expect(applied(db)).toEqual(after);
  });

  it("M9 one statement; a singleton; last_nonce must be 1–20 decimal digits", async () => {
    expect(statements(NONCE_FILE)).toBe(1);
    const { runMigrations, db } = await loadRunner(tempDir("bitcorn-mig-nonce-check-"));
    runMigrations();
    const put = (id: number, v: string | null) => db.prepare(`INSERT INTO kraken_nonce (id, last_nonce) VALUES (?, ?)`).run(id, v);
    put(1, "18446744073709551615"); // the largest unsigned 64-bit value: 20 digits
    expect(() => put(2, "1")).toThrow(/CHECK constraint failed/);
    db.prepare("DELETE FROM kraken_nonce").run();
    for (const bad of ["", "12a", "-1", "1.5", " 1", "184467440737095516150"]) {
      expect(() => put(1, bad), JSON.stringify(bad)).toThrow(/CHECK constraint failed/);
    }
    expect(() => put(1, null)).toThrow(/NOT NULL constraint failed/);
  });
});
