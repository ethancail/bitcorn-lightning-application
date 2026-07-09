import { describe, it, expect, vi } from "vitest";

// In-memory db stub with just the table the prune touches. vi.mock is
// hoisted above top-level consts, so the db is built via vi.hoisted.
const mem = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE member_channel_classifications (
    classification_id TEXT PRIMARY KEY,
    channel_id TEXT, capacity_sat INTEGER, member_local_sat INTEGER,
    treasury_local_sat INTEGER, member_local_pct REAL, state TEXT,
    urgency TEXT, consecutive_non_healthy_runs INTEGER, classified_at INTEGER
  )`);
  return db;
});
vi.mock("../db", () => ({ db: mem }));

import { pruneClassifications } from "./channelClassifier";

function insertRow(id: string, classifiedAt: number) {
  mem.prepare(
    `INSERT INTO member_channel_classifications VALUES (?, 'chan', 0, 0, 0, 0, 'healthy', 'none', 0, ?)`
  ).run(id, classifiedAt);
}

describe("pruneClassifications", () => {
  it("deletes only rows older than the retention window", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    insertRow("ancient", now - 45 * day);
    insertRow("old", now - 31 * day);
    insertRow("inside", now - 29 * day);
    insertRow("fresh", now);

    const deleted = pruneClassifications(30);
    expect(deleted).toBe(2);

    const remaining = mem
      .prepare("SELECT classification_id FROM member_channel_classifications ORDER BY classified_at")
      .all()
      .map((r: any) => r.classification_id);
    expect(remaining).toEqual(["inside", "fresh"]);
  });

  it("is idempotent — second run deletes nothing", () => {
    expect(pruneClassifications(30)).toBe(0);
  });
});
