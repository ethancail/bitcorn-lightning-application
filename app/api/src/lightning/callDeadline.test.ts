// Controls for the LND call deadline wrapper.
//
// ⚠ THE CONTROLS COME IN PAIRS, AND SIMULATING A WEDGE IS NOT SIMULATING A SLOW
// CALL. The two shapes prove different things and both are required:
//
//   WEDGE   — `new Promise(() => {})`, a promise that never settles. This is the
//             await-semantics of a wedged LND: the TCP connection is accepted,
//             the RPC is never answered, and the await simply never returns.
//             Nothing rejects, so no catch anywhere in the app can fire.
//   SLOW    — a real `setTimeout` resolve just inside the deadline. This is a
//             healthy call on a loaded node. It MUST still succeed.
//
// The slow control is the one that matters most. A deadline that fires on
// healthy traffic is a self-inflicted outage on a fleet that updates by farmer
// click — a bad number reaches nodes unevenly and cannot be recalled. That
// control is mutation-proven below: with the deadline forced to 0 it goes red,
// which is what shows it measures the DEADLINE rather than merely that the call
// resolved.

import { describe, it, expect, vi } from "vitest";
import {
  withDeadline,
  LND_FAST_CALL_TIMEOUT_MS,
  LND_GOSSIP_CALL_TIMEOUT_MS,
  HELD_UNBOUNDED_CALLS,
} from "./callDeadline";
import { LND_PROBE_TIMEOUT_MS } from "./lndProbeRoute";

/** Never settles. The wedge shape. */
const wedged = <T>() => new Promise<T>(() => {});

/** Resolves after `ms`. The slow-but-healthy shape. */
const slow = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL 1 / 2 — the pair.
// ═══════════════════════════════════════════════════════════════════════════

describe("withDeadline: wedge vs slow", () => {
  it("CONTROL 1 — a wedged call rejects at the deadline", async () => {
    const started = Date.now();
    await expect(withDeadline("info:read", () => wedged(), 60)).rejects.toThrow(
      /^ETIMEDOUT:/,
    );
    // Bounded above so a wrapper that rejected for some unrelated reason on the
    // next tick could not pass this: it has to take roughly the deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("CONTROL 2 — a slow-but-legitimate call inside the deadline still succeeds", async () => {
    // 40ms of work against a 400ms deadline: the same 10x headroom shape as a
    // healthy ~3ms local gRPC call against the 3s fast deadline.
    await expect(
      withDeadline("offchain:read", () => slow(40, { channels: [] }), 400),
    ).resolves.toEqual({ channels: [] });
  });

  it("CONTROL 2b — a call finishing just under the wire still succeeds", async () => {
    // Deliberately tight: proves the deadline is an upper bound, not a budget
    // the call has to beat by a margin.
    await expect(withDeadline("onchain:read", () => slow(80, "ok"), 200)).resolves.toBe(
      "ok",
    );
  });

  it("the label and the deadline both appear in the timeout message", async () => {
    await expect(
      withDeadline("offchain:read", () => wedged(), 30),
    ).rejects.toThrow(/offchain:read.*30ms/);
  });

  it("a call that rejects on its own keeps ITS error, not ETIMEDOUT", async () => {
    // Guards the green-control mechanism "everything rejects, so control 1
    // would pass regardless": a real fault must NOT be relabelled a timeout.
    const fault = [503, "FailedToConnect", { err: "ECONNREFUSED" }];
    await expect(
      withDeadline("info:read", () => Promise.reject(fault), 5_000),
    ).rejects.toEqual(fault);
  });

  it("a SYNCHRONOUS throw becomes a rejection and does not escape the wrapper", async () => {
    // withDeadline starts the call inside an async IIFE precisely so a sync
    // throw cannot bypass the .finally that clears the timer (next describe).
    await expect(
      withDeadline("info:read", () => {
        throw new Error("sync boom");
      }, 5_000),
    ).rejects.toThrow("sync boom");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL 5 — timer hygiene. Mirrors the house pattern at
// lndProbeRoute.test.ts:296-329.
// ═══════════════════════════════════════════════════════════════════════════

describe("withDeadline leaves no pending timer", () => {
  async function assertAllTimersCleared(run: () => Promise<unknown>) {
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await run().catch(() => undefined);
      const created = setSpy.mock.results.map((r) => r.value);
      expect(created.length).toBeGreaterThan(0);
      for (const id of created) expect(clearSpy).toHaveBeenCalledWith(id);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  }

  it("clears the timer when the call resolves first", async () => {
    await assertAllTimersCleared(() => withDeadline("a", async () => 1, 5_000));
  });

  it("clears the timer when the call rejects first", async () => {
    await assertAllTimersCleared(() =>
      withDeadline("b", async () => { throw new Error("x"); }, 5_000),
    );
  });

  it("clears the timer when the call throws synchronously", async () => {
    await assertAllTimersCleared(() =>
      withDeadline("c", () => { throw new Error("sync"); }, 5_000),
    );
  });

  it("clears the timer when the DEADLINE fires", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await withDeadline("d", () => wedged(), 30).catch(() => undefined);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

describe("deadline constants", () => {
  it("⚠ the fast deadline EQUALS LND_PROBE_TIMEOUT_MS — do not delete this test", () => {
    // THIS IS NOT A TAUTOLOGY. It is the single-number discipline standing in
    // for an import deliberately NOT taken.
    //
    // Both constants bound the same class of call — a read against the local
    // LND gRPC socket — so there must be exactly one number for that class, and
    // its derivation is the one recorded at lndProbeRoute.ts:63-72 (~1000x a
    // healthy local-socket call, inside every poll cadence, test-pinned).
    //
    // The obvious way to guarantee that is for callDeadline.ts to import
    // LND_PROBE_TIMEOUT_MS. It deliberately does not. lnd.ts imports
    // callDeadline.ts, so that import would create
    //
    //     lnd.ts -> callDeadline.ts -> lndProbeRoute.ts ⇢ lnd.ts
    //
    // and lndProbeRoute.ts's dynamic import (:113-135) exists precisely to keep
    // lnd.ts — and so ln-service's gRPC client and better-sqlite3 — OUT of its
    // graph, so that its own tests can run without them. A static edge from
    // lnd.ts into that module inverts the property the dynamic import is there
    // to preserve.
    //
    // So: the value is declared locally and this test is the enforcement. A
    // TEST file may import both freely — it is not in lnd.ts's production
    // import graph. Delete this and the two numbers can drift apart silently.
    expect(LND_FAST_CALL_TIMEOUT_MS).toBe(LND_PROBE_TIMEOUT_MS);
  });

  it("the gossip deadline is longer than the fast one and inside the 60s poll", () => {
    expect(LND_GOSSIP_CALL_TIMEOUT_MS).toBeGreaterThan(LND_FAST_CALL_TIMEOUT_MS);
    expect(LND_GOSSIP_CALL_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("names exactly the six outcome-ambiguous calls as held", () => {
    expect([...HELD_UNBOUNDED_CALLS].sort()).toEqual([
      "closeTreasuryChannel",
      "openTreasuryChannel",
      "payViaPaymentDetails",
      "payViaPaymentRequest",
      "payViaRoutes",
      "sendLndToChainAddress",
    ]);
  });

  it("the held list is frozen — it is a contract, not a suggestion", () => {
    expect(Object.isFrozen(HELD_UNBOUNDED_CALLS)).toBe(true);
  });
});
