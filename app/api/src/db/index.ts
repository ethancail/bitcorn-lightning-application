import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_DIR = "/data/db";
const DB_PATH = path.join(DB_DIR, "bitcorn.sqlite");

// Initialize eagerly at module load time so `db` is always defined
// when other modules import it via CommonJS require().
// (TypeScript compiles `export let` to CommonJS which doesn't have
// live bindings — importing modules capture the value at require time.)
fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/** @deprecated Database is now initialized at module load time. Kept for backward compatibility. */
export function initDb() {
  return db;
}
