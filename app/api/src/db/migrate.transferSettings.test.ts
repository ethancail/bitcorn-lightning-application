// Drive-mode P3, migrations 074–079: member_transfer_settings, one column per
// file (R40(9)).
//
// Why one per file: db/migrate.ts marks a WHOLE file applied when it hits a
// "duplicate column"/"already exists" error, so in a multi-ALTER file whose
// first ALTER is swallowed every later statement is skipped for good (055's
// header). The last case below folds two of these ALTERs into one file and
// shows exactly that loss — the plan's negative control, run in-suite.
//
// Harness: migrate.memberProfileName.test.ts's fresh-runner technique.

import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

const REAL_MIGRATIONS_DIR = path.resolve(__dirname, "migrations");
const P3_FILES = [
  "074_member_transfer_settings.sql",
  "075_member_transfer_settings_strategy.sql",
  "076_member_transfer_settings_fee_limit_pct.sql",
  "077_member_transfer_settings_fee_limit_usd.sql",
  "078_member_transfer_settings_daily_fee_budget.sql",
  "079_member_transfer_settings_max_moved_per_day.sql",
];
const COLUMNS = ["id", "updated_at", "strategy", "fee_limit_pct_bps", "fee_limit_usd_cents", "daily_fee_budget_usd_cents", "max_moved_per_day_usd_cents"];

type Runner = { runMigrations: () => void; db: Database.Database };
const opened: Database.Database[] = [];

async function loadRunner(migrationsDir?: string): Promise<Runner> {
  vi.resetModules();
  process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrate-transfer-"));
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

const columns = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(member_transfer_settings)").all() as Array<{ name: string }>).map((c) => c.name);

/** Statements in a migration file: semicolons outside `--` comment lines. */
const statements = (file: string) =>
  fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, file), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").filter((s) => s.trim().length > 0).length;

afterAll(() => {
  for (const db of opened) db.close();
});

describe("migrations 074–079", () => {
  it("each file holds exactly one statement", () => {
    for (const f of P3_FILES) expect(statements(f), f).toBe(1);
  });

  it("a fresh node gets the table and every column, and no row (missing row = defaults)", async () => {
    const { runMigrations, db } = await loadRunner();
    runMigrations();
    expect(columns(db).sort()).toEqual([...COLUMNS].sort());
    expect((db.prepare("SELECT COUNT(*) AS n FROM member_transfer_settings").get() as { n: number }).n).toBe(0);
  });

  it("a rerun does nothing", async () => {
    const { runMigrations, db } = await loadRunner();
    runMigrations();
    const before = (db.prepare("SELECT id, applied_at FROM migrations ORDER BY id").all());
    runMigrations();
    expect(db.prepare("SELECT id, applied_at FROM migrations ORDER BY id").all()).toEqual(before);
    expect(columns(db).sort()).toEqual([...COLUMNS].sort());
  });

  it("with one column already present (a partial earlier run), the others still arrive", async () => {
    const { runMigrations, db } = await loadRunner();
    db.exec("CREATE TABLE member_transfer_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER NOT NULL DEFAULT 0, strategy TEXT)");
    runMigrations();
    expect(columns(db).sort()).toEqual([...COLUMNS].sort());
  });

  it("CONTROL: folding 076's ALTER into 075 loses fee_limit_pct_bps when strategy is pre-created", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-migrations-folded-"));
    for (const f of fs.readdirSync(REAL_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql")) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, f), path.join(dir, f));
    }
    fs.writeFileSync(
      path.join(dir, "075_member_transfer_settings_strategy.sql"),
      "ALTER TABLE member_transfer_settings ADD COLUMN strategy TEXT;\nALTER TABLE member_transfer_settings ADD COLUMN fee_limit_pct_bps INTEGER;\n",
    );
    fs.writeFileSync(path.join(dir, "076_member_transfer_settings_fee_limit_pct.sql"), "-- folded into 075\nSELECT 1;\n");
    const { runMigrations, db } = await loadRunner(dir);
    db.exec("CREATE TABLE member_transfer_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER NOT NULL DEFAULT 0, strategy TEXT)");
    runMigrations();
    expect(columns(db)).not.toContain("fee_limit_pct_bps");
    expect(columns(db)).toContain("fee_limit_usd_cents");
  });
});
