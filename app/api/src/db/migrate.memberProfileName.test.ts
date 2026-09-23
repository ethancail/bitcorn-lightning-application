// Migration controls for 055/056 (member_profile.bitcorn_name +
// bitcorn_name_set_at) — spec 2026-09-23-member-name-prompt §4, §9.5.
//
// ─── THESE DRIVE THE REAL RUNNER ────────────────────────────────────────────
// The spec's Q2 predicted runMigrations could not be driven from a test
// without changing it (it imports `db` from ./index and resolves its directory
// from __dirname). That prediction was contradicted: the `db` singleton reads
// DB_DIR at module load, so vi.resetModules() + a dynamic import hands each
// case a fresh temp-dir database — the same mechanism the *.route.test.ts
// harness uses before calling runMigrations() itself (catchup.route.test.ts).
// migrate.ts is NOT modified.
//
// For (d), the hazard fixture has to be a file the runner reads. That is done
// by redirecting the runner's `fs` reads of its own migrations/ directory to a
// scratch directory (vi.doMock("fs")), so the runner's db.exec + swallow +
// mark-applied sequence runs verbatim against a two-statement file.
//
// ─── WHY 055 AND 056 ARE TWO FILES ──────────────────────────────────────────
// The runner db.execs each file whole with no transaction and, on an error
// containing "duplicate column" / "already exists", marks the WHOLE FILE
// applied (migrate.ts). In a multi-statement file whose first statement hits
// that swallow, the rest never run and are never retried. (d) observes that;
// (c) shows the same swallow is exactly right for a one-statement file.

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const REAL_MIGRATIONS_DIR = path.resolve(__dirname, "migrations");
const F055 = "055_member_profile_bitcorn_name.sql";
const F056 = "056_member_profile_bitcorn_name_set_at.sql";

type Runner = { runMigrations: () => void; db: Database.Database };

const opened: Database.Database[] = [];

/** Fresh module graph + fresh temp DB. With `migrationsDir`, the runner's
 *  reads of its own migrations/ directory are served from that directory. */
async function loadRunner(migrationsDir?: string): Promise<Runner> {
  vi.resetModules();
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-test-"));
  if (migrationsDir) {
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      const redirect = (p: any) =>
        typeof p === "string" && p.startsWith(REAL_MIGRATIONS_DIR)
          ? migrationsDir + p.slice(REAL_MIGRATIONS_DIR.length)
          : p;
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

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function applied(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM migrations ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  vi.doUnmock("fs");
});

describe("055/056 through the real runner", () => {
  it("(a) a fresh DB migrated through 056 has both columns, and both files are recorded", async () => {
    const { runMigrations, db } = await loadRunner();
    runMigrations();
    const cols = columns(db, "member_profile");
    expect(cols).toContain("bitcorn_name");
    expect(cols).toContain("bitcorn_name_set_at");
    expect(applied(db)).toEqual(expect.arrayContaining([F055, F056]));
  });

  it("(b) a second run is a no-op: no error, same columns, same migrations rows", async () => {
    const { runMigrations, db } = await loadRunner();
    runMigrations();
    const colsBefore = columns(db, "member_profile");
    const rowsBefore = applied(db);
    expect(() => runMigrations()).not.toThrow();
    expect(columns(db, "member_profile")).toEqual(colsBefore);
    expect(applied(db)).toEqual(rowsBefore);
  });

  it("(c) column present but no migrations row: the swallow fires, the file is marked applied, the column is there", async () => {
    const { runMigrations, db } = await loadRunner();
    runMigrations();
    // Column already exists (added by the first run); forget that 055 ran.
    db.prepare("DELETE FROM migrations WHERE id = ?").run(F055);
    expect(applied(db)).not.toContain(F055);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runMigrations()).not.toThrow();
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();

    // The swallow path specifically — not a silent success of some other kind.
    expect(lines).toContain(`[db] migration ${F055} skipped (already applied or column exists)`);
    expect(applied(db)).toContain(F055);
    expect(columns(db, "member_profile")).toContain("bitcorn_name");
  });
});

describe("(d) THE HAZARD: a two-statement file whose first statement hits the swallow", () => {
  function fixtureDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-fixture-"));
    fs.writeFileSync(path.join(dir, "001_base.sql"), "CREATE TABLE t (a TEXT);");
    fs.writeFileSync(
      path.join(dir, "002_two_statements.sql"),
      "ALTER TABLE t ADD COLUMN b TEXT;\nALTER TABLE t ADD COLUMN c TEXT;",
    );
    return dir;
  }

  it("PAIRED POSITIVE: on a clean DB the fixture adds BOTH columns (so the fixture can add c)", async () => {
    const { runMigrations, db } = await loadRunner(fixtureDir());
    runMigrations();
    expect(columns(db, "t")).toEqual(["a", "b", "c"]);
    expect(applied(db)).toEqual(["001_base.sql", "002_two_statements.sql"]);
  });

  it("with b pre-existing: c is ABSENT, and the file is marked applied anyway", async () => {
    const dir = fixtureDir();
    const { runMigrations, db } = await loadRunner(dir);
    // Pre-state: the table exists with b already on it, 002 never recorded.
    db.exec("CREATE TABLE t (a TEXT); ALTER TABLE t ADD COLUMN b TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
    db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run("001_base.sql", 0);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runMigrations()).not.toThrow();
    log.mockRestore();

    expect(columns(db, "t")).toEqual(["a", "b"]); // c never ran
    expect(applied(db)).toContain("002_two_statements.sql"); // ...and will never be retried

    // A later boot does not repair it.
    runMigrations();
    expect(columns(db, "t")).toEqual(["a", "b"]);
  });
});

describe("(e) structural: 055 and 056 each hold exactly one SQL statement", () => {
  // better-sqlite3's prepare() compiles exactly one statement and throws
  // "more than one statement" otherwise — a real SQLite parse, not a split(";").
  function schemaThrough051(): Database.Database {
    const db = new Database(":memory:");
    db.exec(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, "051_member_profile.sql"), "utf8"));
    return db;
  }

  it.each([F055, F056])("%s prepares as a single statement", (file) => {
    const db = schemaThrough051();
    const sql = fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, file), "utf8");
    expect(() => db.prepare(sql)).not.toThrow();
    db.close();
  });

  it("PAIRED POSITIVE: the same check rejects 052, a multi-statement file", () => {
    const db = schemaThrough051();
    const sql = fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, "052_subscription_autopay.sql"), "utf8");
    expect(() => db.prepare(sql)).toThrow(/more than one statement/);
    db.close();
  });
});
