// code-audit-2 F03: the runner applies each migration file all or nothing.
// Ruling: vault decisions/2026-11-20-code-audit-2-f03-migration-runner-wraps-
// each-file-in-a-transaction.md, and Ethan's Phase 1 rulings (2026-11-24):
// an explicit SELF_TRANSACTING allowlist ({072}) with the structural test T7,
// db.transaction(…).immediate(), and the "duplicate column" / "already
// exists" swallow kept as is (mark the file applied and continue).
//
// T1–T9 drive the REAL runner: a fresh module graph per case gives a fresh
// temp-dir database (the `db` singleton reads DB_DIR at module load), and the
// runner's reads of its own migrations/ directory are redirected to a fixture
// directory when a case needs one — migrate.memberProfileName.test.ts's
// harness, with the redirect target switchable mid-case so one database can
// be "upgraded" from one directory to another.
//
// Red on the pre-F03 runner: T1, T2, T3, T5's failure half, T9 (and T7, which
// has no allowlist to read). Green on both, as regression guards: T4, T6, T8.

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const REAL_MIGRATIONS_DIR = path.resolve(__dirname, "migrations");
const REAL_FILES = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const F004 = "004_add_block_drift.sql";
const F072 = "072_subscription_founding_member_credit.sql";

type Runner = { runMigrations: () => void; db: Database.Database; SELF_TRANSACTING: unknown };
const opened: Database.Database[] = [];
// Where the runner's reads of REAL_MIGRATIONS_DIR go; null = the real directory.
let redirectTo: string | null = null;

/** A fresh module graph on `dbDir` (default: a new, empty temp directory). */
async function loadRunner(migrationsDir: string | null = null, dbDir?: string): Promise<Runner> {
  vi.resetModules();
  redirectTo = migrationsDir;
  process.env.DB_DIR = dbDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-tx-"));
  vi.doMock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    const redirect = (p: any) =>
      redirectTo !== null && typeof p === "string" && p.startsWith(REAL_MIGRATIONS_DIR)
        ? redirectTo + p.slice(REAL_MIGRATIONS_DIR.length)
        : p;
    const patched = {
      ...actual,
      existsSync: (p: any) => actual.existsSync(redirect(p)),
      readdirSync: (p: any, ...rest: any[]) => (actual.readdirSync as any)(redirect(p), ...rest),
      readFileSync: (p: any, ...rest: any[]) => (actual.readFileSync as any)(redirect(p), ...rest),
    };
    return { ...patched, default: patched };
  });
  const migrate = await import("./migrate");
  const { db } = await import("./index");
  opened.push(db);
  return { runMigrations: migrate.runMigrations, db, SELF_TRANSACTING: (migrate as any).SELF_TRANSACTING };
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  vi.doUnmock("fs");
  redirectTo = null;
});

/** A fixture migrations directory holding `files` (name → SQL). */
function fixtureDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-tx-fixture-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}
/** A fixture directory holding copies of the first `k` real migration files. */
function realPrefixDir(k: number): string {
  return fixtureDir(Object.fromEntries(REAL_FILES.slice(0, k).map((f) => [f, fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, f), "utf8")])));
}

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const applied = (db: Database.Database) =>
  (db.prepare("SELECT id FROM migrations ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);

/** Schema + every table's rows. migrations contributes its ids only; values
 *  within a day of now (seconds or ms) and ISO datetimes are normalised,
 *  because migrations seed rows with strftime('now'). */
function dump(db: Database.Database): string {
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string }>;
  const data: Record<string, unknown> = {};
  for (const { name } of schema.filter((s) => s.type === "table")) {
    data[name] = name === "migrations" ? applied(db) : db.prepare(`SELECT * FROM "${name}"`).all();
  }
  const s = Date.now() / 1000;
  return JSON.stringify({ schema, data }, (_k, v) =>
    typeof v === "number" && ((v > s - 86400 && v < s + 86400) || (v > (s - 86400) * 1000 && v < (s + 86400) * 1000))
      ? "<now>"
      : typeof v === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(v)
        ? "<now-iso>"
        : v,
  );
}

function quietly<T>(fn: () => T): { result?: T; error?: Error; lines: string[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return { result: fn(), lines: log.mock.calls.map((c) => String(c[0])) };
  } catch (error) {
    return { error: error as Error, lines: log.mock.calls.map((c) => String(c[0])) };
  } finally {
    log.mockRestore();
  }
}

describe("T1/T2: a file that fails part-way", () => {
  const BASE = { "001_base.sql": "CREATE TABLE t (a TEXT);" };
  const FAILING = "ALTER TABLE t ADD COLUMN b TEXT;\nCREATE TABLE u (x TEXT);\nINSERT INTO t (a, b) VALUES ('1', '2');\nSELECT no_such_column FROM t;";
  const FIXED = "ALTER TABLE t ADD COLUMN b TEXT;\nCREATE TABLE u (x TEXT);\nALTER TABLE t ADD COLUMN c TEXT;";

  it("T1: throws, leaves NO partial schema or rows, and is not marked applied", async () => {
    const { runMigrations, db } = await loadRunner(fixtureDir({ ...BASE, "002_fails.sql": FAILING }));
    const r = quietly(() => runMigrations());
    expect(r.error?.message).toMatch(/no such column: no_such_column/);
    expect(columns(db, "t")).toEqual(["a"]);
    expect(tableExists(db, "u")).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(0);
    expect(applied(db)).toEqual(["001_base.sql"]);
    expect(db.inTransaction).toBe(false);
  });

  it("T2: after the failure, a re-run of the corrected file applies all of it and marks it", async () => {
    const dir = fixtureDir({ ...BASE, "002_fails.sql": FAILING });
    const { runMigrations, db } = await loadRunner(dir);
    expect(quietly(() => runMigrations()).error).toBeDefined();
    fs.writeFileSync(path.join(dir, "002_fails.sql"), FIXED);
    const r = quietly(() => runMigrations());
    expect(r.error).toBeUndefined();
    expect(r.lines).toContain("[db] applied migration 002_fails.sql");
    expect(columns(db, "t")).toEqual(["a", "b", "c"]);
    expect(tableExists(db, "u")).toBe(true);
    expect(applied(db)).toEqual(["001_base.sql", "002_fails.sql"]);
  });
});

describe("T3: a boot killed (SIGKILL) inside a 040-shaped file", () => {
  // 040's shape: RENAME the table, CREATE its replacement, copy, DROP the old.
  // die() is a SQL function the child registers: it SIGKILLs its own process
  // mid-file, after the RENAME and the CREATE have run.
  const BASE = "CREATE TABLE tok (id INTEGER PRIMARY KEY, scope TEXT NOT NULL);\nINSERT INTO tok VALUES (1, 'prepay');";
  const SHAPE = (killPoint: string) => [
    "ALTER TABLE tok RENAME TO tok_old;",
    "CREATE TABLE tok (id INTEGER PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('full', 'payment')));",
    killPoint,
    "INSERT INTO tok (id, scope) SELECT id, CASE scope WHEN 'prepay' THEN 'payment' ELSE scope END FROM tok_old;",
    "DROP TABLE tok_old;",
  ].join("\n");

  it("the next boot applies the whole file: no tok_old, the row converted, the file marked", async () => {
    const dir = fixtureDir({ "001_base.sql": BASE, "002_rebuild.sql": SHAPE("SELECT die();") });
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-tx-kill-"));
    const child = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-tx-child-")), "boot.cjs");
    fs.writeFileSync(child, `
      const fs = require("fs");
      const [dbDir, realDir, fixture, srcDb] = process.argv.slice(2);
      process.env.DB_DIR = dbDir;
      const redirect = (p) => typeof p === "string" && p.startsWith(realDir) ? fixture + p.slice(realDir.length) : p;
      for (const k of ["existsSync", "readdirSync", "readFileSync"]) { const o = fs[k]; fs[k] = (p, ...r) => o.call(fs, redirect(p), ...r); }
      const { db } = require(srcDb + "/index.ts");
      db.function("die", () => { process.kill(process.pid, "SIGKILL"); return 0; });
      require(srcDb + "/migrate.ts").runMigrations();
      process.exit(3); // not reached: die() kills the boot
    `);
    const r = spawnSync(process.execPath, ["--import", "tsx", child, dbDir, REAL_MIGRATIONS_DIR, dir, __dirname], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
    });
    expect(r.signal, `child stderr: ${r.stderr}`).toBe("SIGKILL");

    // The next boot: same database file, the file without its kill point.
    fs.writeFileSync(path.join(dir, "002_rebuild.sql"), SHAPE(""));
    const { runMigrations, db } = await loadRunner(dir, dbDir);
    const boot = quietly(() => runMigrations());
    expect(boot.error).toBeUndefined();
    expect(tableExists(db, "tok_old")).toBe(false);
    expect(db.prepare("SELECT id, scope FROM tok").all()).toEqual([{ id: 1, scope: "payment" }]);
    expect(applied(db)).toEqual(["001_base.sql", "002_rebuild.sql"]);
  });
});

describe("T4: 004's harmless swallow on a fresh database", () => {
  it("004 is skipped by the swallow, marked applied, and both block_drift columns exist (from 001)", async () => {
    const { runMigrations, db } = await loadRunner();
    const r = quietly(() => runMigrations());
    expect(r.error).toBeUndefined();
    expect(r.lines).toContain(`[db] migration ${F004} skipped (already applied or column exists)`);
    expect(r.lines.filter((l) => l.includes("skipped"))).toEqual([`[db] migration ${F004} skipped (already applied or column exists)`]);
    expect(columns(db, "lnd_node_info")).toContain("block_drift");
    expect(columns(db, "lnd_node_info_history")).toContain("block_drift");
    expect(applied(db)).toEqual(REAL_FILES);
  });
});

describe("T5: 072 (self-transacting) applies once, and all or nothing", () => {
  const i072 = REAL_FILES.indexOf(F072);
  async function migratedTo071WithGrandfather() {
    const runner = await loadRunner(realPrefixDir(i072));
    expect(quietly(() => runner.runMigrations()).error).toBeUndefined();
    runner.db.prepare(
      "INSERT INTO subscription (member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier) VALUES ('pk1', 'addr', 'm/0', 0, 0, 'prepay')",
    ).run();
    runner.db.prepare(
      "INSERT INTO subscription_payment (member_pubkey, amount_sats, received_at, period_extension_days, kind, admin_reason) VALUES ('pk1', 0, 0, 0, 'admin_override', 'Stage 2 grandfather backfill at flip-day')",
    ).run();
    redirectTo = null; // the "upgrade": every real file from here
    return runner;
  }
  const credits = (db: Database.Database) =>
    (db.prepare("SELECT COUNT(*) AS n FROM subscription_payment WHERE admin_reason = 'Founding member credit'").get() as { n: number }).n;

  it("PAIRED POSITIVE: the grandfathered row gets exactly one credit; a second run adds none", async () => {
    const { runMigrations, db } = await migratedTo071WithGrandfather();
    const r = quietly(() => runMigrations());
    expect(r.error).toBeUndefined();
    expect(r.lines).toContain(`[db] applied migration ${F072}`);
    expect(credits(db)).toBe(1);
    expect((db.prepare("SELECT paid_through FROM subscription WHERE member_pubkey = 'pk1'").get() as { paid_through: number }).paid_through).toBeGreaterThan(0);
    quietly(() => runMigrations());
    expect(credits(db)).toBe(1);
    expect(applied(db)).toEqual(REAL_FILES);
  });

  it("a failure after 072's INSERT rolls the file back: no credit, no open transaction, not marked", async () => {
    const { runMigrations, db } = await migratedTo071WithGrandfather();
    db.exec("CREATE TRIGGER boom BEFORE UPDATE OF paid_through ON subscription BEGIN SELECT RAISE(ABORT, 'injected failure at 072 UPDATE'); END;");
    const r = quietly(() => runMigrations());
    expect(r.error?.message).toBe("injected failure at 072 UPDATE");
    expect(db.inTransaction).toBe(false);
    expect(credits(db)).toBe(0);
    expect(applied(db)).not.toContain(F072);
  });
});

describe("T6: an already-migrated database", () => {
  it("a second run is a no-op: nothing applied or skipped, dump identical", async () => {
    const { runMigrations, db } = await loadRunner();
    quietly(() => runMigrations());
    const before = dump(db);
    const r = quietly(() => runMigrations());
    expect(r.error).toBeUndefined();
    expect(r.lines.filter((l) => l.startsWith("[db]"))).toEqual([]);
    expect(dump(db)).toBe(before);
  });
});

describe("T7: structural — transaction control lives only in SELF_TRANSACTING files", () => {
  // Statement starts after `--` and /* */ comments and '…' strings are
  // removed. A trigger body's inner statements would also count as starts
  // (none exists today): a new trigger fails this test, closed rather than open.
  const TX = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
  // Cannot run inside a transaction (VACUUM, ATTACH, DETACH) or silently does
  // nothing there (PRAGMA foreign_keys and others).
  const BANNED = /^(VACUUM|PRAGMA|ATTACH|DETACH)\b/i;
  function statementStarts(sql: string): string[] {
    return sql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const read = (f: string) => fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, f), "utf8");

  it("SELF_TRANSACTING is exactly the set of files with a transaction-control statement", async () => {
    const { SELF_TRANSACTING } = await loadRunner();
    expect(SELF_TRANSACTING).toBeInstanceOf(Set);
    const withTx = REAL_FILES.filter((f) => statementStarts(read(f)).some((s) => TX.test(s)));
    expect(withTx).toEqual([F072]);
    expect([...(SELF_TRANSACTING as Set<string>)].sort()).toEqual(withTx);
  });

  it("no migration holds VACUUM, PRAGMA, ATTACH or DETACH", () => {
    const hits = REAL_FILES.flatMap((f) => statementStarts(read(f)).filter((s) => BANNED.test(s)).map((s) => `${f}: ${s.slice(0, 40)}`));
    expect(hits).toEqual([]);
  });

  it("PAIRED POSITIVE: the scanner sees statements and ignores comments and strings", () => {
    const sql = "-- BEGIN; in a comment\n/* VACUUM; */ INSERT INTO t VALUES ('COMMIT; PRAGMA x');\nPRAGMA foreign_keys = OFF;\nbegin immediate;";
    const starts = statementStarts(sql);
    expect(starts.filter((s) => BANNED.test(s))).toEqual(["PRAGMA foreign_keys = OFF"]);
    expect(starts.filter((s) => TX.test(s))).toEqual(["begin immediate"]);
  });
});

describe("T8: an upgrade from every earlier migration set ends where a fresh install does", () => {
  let fresh: string | undefined;
  async function freshDump(): Promise<string> {
    if (fresh === undefined) {
      const { runMigrations, db } = await loadRunner();
      quietly(() => runMigrations());
      fresh = dump(db);
    }
    return fresh;
  }
  it.each(REAL_FILES.slice(0, -1).map((_, i) => i + 1))("from the first %i files", async (k) => {
    const want = await freshDump();
    const { runMigrations, db } = await loadRunner(realPrefixDir(k));
    db.pragma("synchronous = OFF"); // speed only: nothing here survives a crash
    expect(quietly(() => runMigrations()).error).toBeUndefined();
    expect(applied(db)).toEqual(REAL_FILES.slice(0, k));
    redirectTo = null;
    expect(quietly(() => runMigrations()).error).toBeUndefined();
    expect(dump(db)).toBe(want);
  });
});

describe("T9: the mark-applied INSERT commits with the file", () => {
  it("when recording the file fails, its schema change is rolled back too", async () => {
    const { runMigrations, db } = await loadRunner(
      fixtureDir({ "001_base.sql": "CREATE TABLE t (a TEXT);", "002_add.sql": "ALTER TABLE t ADD COLUMN b TEXT;" }),
    );
    db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
    db.exec("CREATE TRIGGER no_mark BEFORE INSERT ON migrations WHEN NEW.id = '002_add.sql' BEGIN SELECT RAISE(ABORT, 'injected mark failure'); END;");
    const r = quietly(() => runMigrations());
    expect(r.error?.message).toBe("injected mark failure");
    expect(columns(db, "t")).toEqual(["a"]);
    expect(applied(db)).toEqual(["001_base.sql"]);
  });
});
