import { initDb, getDb } from "./index";

export function runMigrations() {
  initDb();
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

if (require.main === module) {
  runMigrations();
  console.log("[migrate] OK");
}
