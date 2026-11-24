import fs from "fs";
import path from "path";
import { db } from "./index";

// Migration files that carry their own BEGIN/COMMIT. SQLite refuses a BEGIN
// inside an open transaction (a SAVEPOINT included), so these run unwrapped,
// as every file did before code-audit-2 F03; each is all or nothing by its
// own transaction. migrate.transaction.test.ts (T7) fails if this set and the
// files holding a transaction-control statement ever differ.
export const SELF_TRANSACTING: ReadonlySet<string> = new Set([
  "072_subscription_founding_member_credit.sql",
]);

export function runMigrations() {
  // Resolve relative to this file, not the cwd. Works for both:
  //   - dev (tsx watch)  → __dirname = app/api/src/db/  → src/db/migrations/
  //   - prod (node dist) → __dirname = app/api/dist/db/ → dist/db/migrations/
  // Previously hardcoded `cwd/dist/db/migrations` only worked in prod, and
  // silently no-op'd in dev because the path didn't exist (existsSync false
  // → early return at line below).
  const MIGRATIONS_DIR = path.join(__dirname, "migrations");

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const rows = db
    .prepare("SELECT id FROM migrations")
    .all() as Array<{ id: string }>;

  const applied = new Set(rows.map(r => r.id));

  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();

  const markApplied = db.prepare(
    "INSERT INTO migrations (id, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    try {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

      if (SELF_TRANSACTING.has(file)) {
        try {
          db.exec(sql);
        } catch (err) {
          // The file's own transaction is still open after a failed
          // statement; close it so nothing it wrote survives on this connection.
          if (db.inTransaction) db.exec("ROLLBACK");
          throw err;
        }
        markApplied.run(file, Date.now());
      } else {
        // All or nothing (code-audit-2 F03): the file's statements and its
        // migrations row commit together, or roll back together on any error.
        // IMMEDIATE takes the write lock before the first statement.
        db.transaction(() => {
          db.exec(sql);
          markApplied.run(file, Date.now());
        }).immediate();
      }

      console.log(`[db] applied migration ${file}`);
    } catch (err: any) {
      // If migration fails (e.g., column already exists), log and continue
      // This allows idempotent migrations when schema is updated in earlier migrations.
      // The whole file has already been rolled back at this point (above), so
      // marking it applied skips ALL of its statements, not just the failing one.
      if (err?.message?.includes("duplicate column") || err?.message?.includes("already exists")) {
        console.log(`[db] migration ${file} skipped (already applied or column exists)`);
        // Still mark as applied to prevent retries
        db.prepare(
          "INSERT OR IGNORE INTO migrations (id, applied_at) VALUES (?, ?)"
        ).run(file, Date.now());
      } else {
        throw err;
      }
    }
  }
}
