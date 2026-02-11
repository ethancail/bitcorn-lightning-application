import fs from "fs";
import path from "path";
import { db } from "./index";

export function runMigrations() {
  const MIGRATIONS_DIR = path.join(process.cwd(), "dist", "db", "migrations");

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

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);

    db.prepare(
      "INSERT INTO migrations (id, applied_at) VALUES (?, ?)"
    ).run(file, Date.now());

    console.log(`[db] applied migration ${file}`);
  }
}
