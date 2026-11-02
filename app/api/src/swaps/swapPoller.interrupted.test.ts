// Ruling e: a startup sweep marks swap_requests rows left 'initiating' for more
// than 10 minutes as TERMINAL (failed, failure_reason 'interrupted'). It never
// releases them: loopd may already have started the swap, and a released row
// could be executed again.
//
// 'initiating' is set only by initiateSwap's claim and always left again by a
// running process, so a row still there after 10 minutes was orphaned by a
// crash or restart mid-initiation.
//
// Real swapPoller against a temp-dir database the real migration runner builds.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-interrupted-test-"));

type Poller = typeof import("./swapPoller");
let poller: Poller;
let db: Database.Database;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  poller = await import("./swapPoller");
});

afterEach(() => {
  vi.useRealTimers();
});

const MIN = 60_000;

function row(status: string, updatedAgoMs: number): string {
  const id = crypto.randomUUID();
  const t = Date.now() - updatedAgoMs;
  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quote_expires_at)
    VALUES (?, ?, ?, '02aa', 'member', 'loop_out', 'lightning_to_chain', ?, 250000, ?)
  `).run(id, t, t, status, t + 300_000);
  return id;
}

const state = (id: string) =>
  db.prepare("SELECT status, failure_reason FROM swap_requests WHERE id = ?").get(id) as { status: string; failure_reason: string | null };

// Through the namespace, so a missing sweep fails on the row, not on an import.
const sweep = () => (poller as any).sweepInterruptedInitiations?.();

describe("the startup sweep of interrupted initiations", () => {
  it("an 'initiating' row older than 10 minutes becomes failed / interrupted", () => {
    const old = row("initiating", 11 * MIN);
    sweep();
    expect(state(old)).toEqual({ status: "failed", failure_reason: "interrupted" });
  });

  it("a fresh 'initiating' row is untouched", () => {
    const fresh = row("initiating", 1 * MIN);
    sweep();
    expect(state(fresh)).toEqual({ status: "initiating", failure_reason: null });
  });

  it("rows in other states are untouched, however old", () => {
    const quoted = row("quote_created", 60 * MIN);
    const started = row("initiated", 60 * MIN);
    sweep();
    expect(state(quoted).status).toBe("quote_created");
    expect(state(started).status).toBe("initiated");
  });

  it("runs at startup: startSwapPoller sweeps before its first tick", () => {
    vi.useFakeTimers(); // the poller's 15s interval must not fire here
    const old = row("initiating", 30 * MIN);
    poller.startSwapPoller();
    expect(state(old)).toEqual({ status: "failed", failure_reason: "interrupted" });
  });
});
