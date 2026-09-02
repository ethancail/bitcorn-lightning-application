// The MECHANISM under the farmer-facing Loop copy: which branch of
// isLoopAvailable() fired, and whether that fact survives propagation.
//
// ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// The copy layer has 23 controls in memberAdvisor/recommendationEngine.test.ts.
// The two layers UNDER it had none. The arc's done-whens for them (DW3, DW4)
// are `git show | grep` READS — they prove the source says the right thing, and
// they cannot prove the code DOES it. Nothing in the repo executed
// isLoopAvailable() or checkLoopAvailability(): the only test-file mention of
// either is api/treasury-alerts.test.ts:127, which is a whole-module `vi.mock`
// REPLACING isLoopAvailable, so the real function never ran there.
//
// The gap that leaves is specific and it is the defect this whole arc exists to
// remove: swap the two reasons in isLoopAvailable() and a farmer whose loopd is
// unreachable is told Loop "isn't ready on this node yet" — wrong sentence,
// wrong claim, and every one of the 23 copy controls still passes, because they
// are handed a reason directly and never ask who classified it. The two
// mutations recorded in this arc's step-3 report are exactly that.
//
// ⚠ THE ASSERTIONS ARE ON THE REASON VALUE, NOT ON `available`. `available` is
// the carrier, not the contract. A test that checks only `available: false`
// sails straight through a swapped mapping, which is the mutation most likely
// to happen and the hardest to see in review.
//
// ─── WHAT IS MOCKED, AND WHAT IS DELIBERATELY NOT ───────────────────────────
//
// `fs` — so `existsSync` decides which branch is taken, per case.
// `@grpc/grpc-js` — so the transport resolves or throws on command, with no
//   socket. loadPackageDefinition is stubbed to hand back a fake SwapClient;
//   proto-loader is stubbed alongside it because its output then feeds nothing.
//
// NOT mocked, on purpose:
//   · `../config/env` — the real ENV supplies the real cert/macaroon paths, so
//     the paths under test are the ones production reads. It has no
//     import-time throw, and the fs mock makes the host filesystem irrelevant.
//   · `../db` — NEITHER module under test imports it. loop.ts imports grpc,
//     proto-loader, fs, path and ENV; loopAvailability.ts imports only
//     ../lightning/loop. So the empty-in-memory-database trap that would throw
//     at prepare() for anything reaching getConfig() is not inherited here,
//     and no config table is needed at any migration shape.
//   · `../lightning/loop` for the propagation test — the second seam runs the
//     REAL classifier through the REAL early return, so these cases cover
//     branch→reason→result end to end rather than asserting propagation
//     against a stubbed reason.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── gRPC transport double ───────────────────────────────────────────────────

type RpcHandler = (err: unknown, res?: unknown) => void;

/** Per-test transport behaviour, keyed by loopd RPC method name. */
const rpc: Record<string, (cb: RpcHandler) => void> = {};

vi.mock("@grpc/proto-loader", () => ({
  loadSync: () => ({}),
}));

vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    // loop.ts calls client[method](request, { deadline }, cb)
    GetInfo(_req: unknown, _opts: unknown, cb: RpcHandler) {
      rpc.GetInfo(cb);
    }
    LoopOutTerms(_req: unknown, _opts: unknown, cb: RpcHandler) {
      rpc.LoopOutTerms(cb);
    }
    GetLoopInTerms(_req: unknown, _opts: unknown, cb: RpcHandler) {
      rpc.GetLoopInTerms(cb);
    }
  }
  return {
    loadPackageDefinition: () => ({ looprpc: { SwapClient: FakeSwapClient } }),
    credentials: {
      createSsl: () => ({}),
      createFromMetadataGenerator: () => ({}),
      combineChannelCredentials: () => ({}),
    },
    Metadata: class {
      add() {}
    },
  };
});

// ─── fs double ───────────────────────────────────────────────────────────────

/** Which of the two credential files exist, set per test. */
const present = { cert: true, macaroon: true };

vi.mock("fs", () => {
  const existsSync = (p: unknown) => {
    const s = String(p);
    if (s.endsWith("tls.cert")) return present.cert;
    if (s.endsWith("loop.macaroon")) return present.macaroon;
    return true;
  };
  // getSwapClient() reads both files once it believes they exist.
  const readFileSync = () => Buffer.from("stub");
  return { default: { existsSync, readFileSync }, existsSync, readFileSync };
});

import { isLoopAvailable } from "./loop";
import { checkLoopAvailability } from "../memberAdvisor/loopAvailability";

const RPC_FAILS = (cb: RpcHandler) =>
  cb({ code: 14, details: "connection refused" });
const TERMS_OK = (cb: RpcHandler) =>
  cb(null, { min_swap_amount: 250_000, max_swap_amount: 500_000 });

beforeEach(() => {
  present.cert = true;
  present.macaroon = true;
  rpc.GetInfo = (cb) => cb(null, { version: "0.33.0-beta" });
  rpc.LoopOutTerms = TERMS_OK;
  rpc.GetLoopInTerms = TERMS_OK;
  // NO vi.resetModules() HERE, AND THE ABSENCE IS DELIBERATE.
  //
  // loop.ts memoises its gRPC client in a module-level singleton, and
  // getSwapClient() does its own cert/macaroon existence check — so a cached
  // client surviving between tests LOOKS like it should let a later
  // credentials_absent case slip past the filesystem branch. It cannot:
  // isLoopAvailable() runs its own fs.existsSync check at the top of its own
  // body and returns before rpcCall is ever reached, so the two checks are on
  // different paths and the singleton is irrelevant to classification.
  //
  // This file did carry a resetModules() call with a comment asserting that
  // protection. Removing it changed nothing — 11/11 either way — which is how
  // the claim was found to be false. A no-op guarded by a comment claiming it
  // prevents a specific failure is worse than no guard: the next reader trusts
  // it.
});

// ═══════════════════════════════════════════════════════════════════════════
// SEAM 1 — isLoopAvailable()'s branch → reason mapping.
// ═══════════════════════════════════════════════════════════════════════════

describe("isLoopAvailable — branch to reason", () => {
  it("a missing cert classifies as credentials_absent", async () => {
    present.cert = false;
    const r = await isLoopAvailable();
    expect(r.available).toBe(false);
    // THE assertion. `available: false` alone would pass on a swapped mapping.
    expect(r.unavailableReason).toBe("credentials_absent");
  });

  it("a missing macaroon classifies as credentials_absent", async () => {
    // The other half of the `||`. Both files gate the same branch, and a
    // refactor that checks only the cert would leave this case unclassified.
    present.macaroon = false;
    const r = await isLoopAvailable();
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toBe("credentials_absent");
  });

  it("credentials present but the RPC throwing classifies as unreachable", async () => {
    rpc.GetInfo = RPC_FAILS;
    const r = await isLoopAvailable();
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toBe("unreachable");
  });

  it("credentials present and the RPC answering carries the version, with NO reason", async () => {
    const r = await isLoopAvailable();
    expect(r.available).toBe(true);
    expect(r.version).toBe("0.33.0-beta");
    // The third daemon state is the ABSENCE of a reason, not a third value.
    expect(r.unavailableReason).toBeUndefined();
  });

  it("the two failure branches do NOT produce the same reason", async () => {
    present.cert = false;
    const absent = (await isLoopAvailable()).unavailableReason;

    present.cert = true;
    rpc.GetInfo = RPC_FAILS;
    const unreachable = (await isLoopAvailable()).unavailableReason;

    // Both defined, and different — the pairing that catches a collapse to one
    // value, which asserting each in isolation would not.
    expect(absent).toBe("credentials_absent");
    expect(unreachable).toBe("unreachable");
    expect(absent).not.toBe(unreachable);
  });

  it("classifies without inspecting the error text", async () => {
    // Same branch, wildly different messages. If classification ever starts
    // reading `error`, one of these stops being `unreachable` and this goes red.
    for (const details of [
      "connection refused",
      "certificate has expired",
      "Loop credentials not found",
      "",
    ]) {
      rpc.GetInfo = (cb) => cb({ code: 14, details });
      const r = await isLoopAvailable();
      expect(r.unavailableReason).toBe("unreachable");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEAM 2 — the reason survives loopAvailability.ts's early return.
//
// This is the regression this arc exists to prevent recurring: that early
// return used to be a bare `return result`, which discarded the classification
// and left the copy layer unable to tell the two states apart.
// ═══════════════════════════════════════════════════════════════════════════

describe("checkLoopAvailability — the reason survives propagation", () => {
  it("carries credentials_absent onto the result", async () => {
    present.cert = false;
    const r = await checkLoopAvailability();
    expect(r.loopDaemonRunning).toBe(false);
    // ON the result — a reason computed and then dropped would satisfy a
    // description of this fix while changing nothing a member reads.
    expect(r.unavailableReason).toBe("credentials_absent");
  });

  it("carries unreachable onto the result", async () => {
    rpc.GetInfo = RPC_FAILS;
    const r = await checkLoopAvailability();
    expect(r.loopDaemonRunning).toBe(false);
    expect(r.unavailableReason).toBe("unreachable");
  });

  it("distinguishes the two states after propagation, not just before it", async () => {
    present.cert = false;
    const absent = (await checkLoopAvailability()).unavailableReason;

    present.cert = true;
    rpc.GetInfo = RPC_FAILS;
    const unreachable = (await checkLoopAvailability()).unavailableReason;

    expect(absent).toBe("credentials_absent");
    expect(unreachable).toBe("unreachable");
    expect(absent).not.toBe(unreachable);
  });

  it("reports null — not a reason — when the daemon is up", async () => {
    const r = await checkLoopAvailability();
    expect(r.loopDaemonRunning).toBe(true);
    expect(r.unavailableReason).toBeNull();
    // §2's fourth copy case hangs off this: a daemon that is up has no
    // unavailability reason, which is what keeps "terms fetch failed" distinct
    // from the two daemon-down states downstream.
    expect(r.loopOutAvailable).toBe(true);
    expect(r.loopInAvailable).toBe(true);
  });

  it("still reports null when the daemon is up and only the terms fetch fails", async () => {
    // §2 row four at the mechanism layer. loopDaemonRunning stays true and no
    // reason appears, so the copy layer reaches its fourth-case sentence rather
    // than either daemon-down one.
    rpc.LoopOutTerms = RPC_FAILS;
    rpc.GetLoopInTerms = RPC_FAILS;
    const r = await checkLoopAvailability();
    expect(r.loopDaemonRunning).toBe(true);
    expect(r.unavailableReason).toBeNull();
    expect(r.loopOutAvailable).toBe(false);
    expect(r.loopInAvailable).toBe(false);
  });
});
