import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_DIR = "/data/db";
const DB_PATH = path.join(DB_DIR, "bitcorn.sqlite");

export let db: Database.Database;

export function initDb() {
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });

  db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}
