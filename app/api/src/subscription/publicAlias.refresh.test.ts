// Bounded parallelism for the public-alias refresh — spec
// 2026-09-24-public-alias-refresh §6.2, §11.7.
//
// THE PROPERTY: one lookup that never settles does not serialize the rest. The
// other P−1 settle, and are WRITTEN, before the hanging one's deadline — and no
// more than PUBLIC_ALIAS_REFRESH_CONCURRENCY lookups are ever in flight.
//
// The lookup is the REAL lookupNodeAlias, deadline included; only ln-service's
// getNode is scripted. Fake timers drive both the scripted latency and the
// 10s deadline, so the test is exact rather than slow.
//
// ⚠ What "in flight" counts here: getNode calls started and not yet settled,
// as the scripted double sees them. The hanging call never settles, so it
// stays counted for the whole test — which is the honest count, since the
// deadline frees our slot but does not cancel the call.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-public-alias-refresh-"));
process.env.DB_DIR = TMP_DB;

const ln = vi.hoisted(() => ({
  hang: "",
  inFlight: 0,
  maxInFlight: 0,
  started: [] as string[],
}));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const getNode = (args: { public_key: string }) => {
    ln.started.push(args.public_key);
    ln.inFlight++;
    ln.maxInFlight = Math.max(ln.maxInFlight, ln.inFlight);
    if (args.public_key === ln.hang) return new Promise(() => {});
    return new Promise((resolve) =>
      setTimeout(() => {
        ln.inFlight--;
        resolve({ alias: `Farm ${args.public_key.slice(2, 4)}` });
      }, 1_000),
    );
  };
  return { ...actual, default: { ...(actual.default ?? actual), getNode }, getNode };
});

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return { ...actual, getLndClient: () => ({ lnd: {} }) as any };
});

const { runMigrations } = await import("../db/migrate");
const { db } = await import("../db");
const { refreshPublicAliases, PUBLIC_ALIAS_REFRESH_CONCURRENCY } = await import("./publicAlias");
const { LND_GOSSIP_CALL_TIMEOUT_MS } = await import("../lightning/callDeadline");

// The hanging pubkey sorts FIRST in the roster, so a sequential refresh would
// block on it before anything else starts.
const HANG = "02" + "00".repeat(32);
const OTHERS = Array.from({ length: 8 }, (_, i) => "02" + (i + 1).toString(16).padStart(2, "0").repeat(32));

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  runMigrations();
  [HANG, ...OTHERS].forEach((pk, i) =>
    db
      .prepare(
        `INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat,
           remote_balance_sat, active, private, updated_at, first_seen_at)
         VALUES (?, ?, 1000000, 500000, 500000, 1, 0, 0, 0)`,
      )
      .run(String(i + 1), pk),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

const storedAliases = () =>
  (db.prepare("SELECT pubkey FROM peer_public_alias WHERE outcome = 'alias'").all() as Array<{ pubkey: string }>).map(
    (r) => r.pubkey,
  );

describe("§11.7 bounded parallelism", () => {
  it("a hanging lookup does not serialize the rest; in-flight never exceeds the bound", async () => {
    expect(PUBLIC_ALIAS_REFRESH_CONCURRENCY).toBe(4);
    ln.hang = HANG;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let finished = false;
    const pending = refreshPublicAliases().then((c) => {
      finished = true;
      return c;
    });

    // 8 fast lookups at 1s each, 3 slots free beside the hang: 3 + 3 + 2 →
    // all eight settle by t=3s, well before the hang's 10s deadline.
    await vi.advanceTimersByTimeAsync(3_000);

    expect(finished, "the refresh is still waiting on the hanging lookup").toBe(false);
    expect(
      storedAliases().sort(),
      "every fast lookup must be settled AND written before the hanging one's deadline",
    ).toEqual([...OTHERS].sort());
    expect(ln.maxInFlight, "never more than the bound in flight").toBeLessThanOrEqual(PUBLIC_ALIAS_REFRESH_CONCURRENCY);
    // Anti-vacuity: the bound was actually USED. A refresh that ran one at a
    // time would also satisfy "≤ 4".
    expect(ln.maxInFlight).toBe(PUBLIC_ALIAS_REFRESH_CONCURRENCY);

    // The deadline, not the hang, ends the refresh.
    await vi.advanceTimersByTimeAsync(LND_GOSSIP_CALL_TIMEOUT_MS);
    const counts = await pending;
    expect(counts).toEqual({ total: 9, alias: 8, none_announced: 0, not_in_graph: 0, failed: 1 });
    expect(db.prepare("SELECT outcome, last_attempt_ok, last_error FROM peer_public_alias WHERE pubkey = ?").get(HANG)).toEqual({
      outcome: null,
      last_attempt_ok: 0,
      last_error: "ETIMEDOUT",
    });
    expect(new Set(ln.started)).toEqual(new Set([HANG, ...OTHERS]));
  });
});
