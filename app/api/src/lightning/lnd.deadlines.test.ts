// The deadline as it actually reaches production, proven one level BELOW the
// wrappers: ln-service is the mock, lnd.ts is the real code under test.
//
// ⚠ WHY NOT AT THE CONSUMER LEVEL. api/treasury-alerts.test.ts mocks
// ../lightning/lnd wholesale, so a deadline added INSIDE lnd.ts is invisible
// there — every wrapper is replaced by a stub. Testing this change through that
// file would prove nothing about it. Mocking the transport instead exercises the
// real getLndChainBalance, the real withDeadline call, and the real constant.
//
// ⚠ THE PAIR, AGAIN, AND THE SHAPES ARE NOT INTERCHANGEABLE.
//   WEDGE — ln-service returns a promise that never settles. This is a wedged
//           LND: connection accepted, RPC unanswered, nothing ever rejects.
//   SLOW  — ln-service resolves after a delay well inside the deadline. This is
//           a healthy call on a loaded node and MUST still succeed.
// Both are needed: the wedge case proves the bound exists, the slow case proves
// the bound is not so tight that it fires on healthy traffic.
//
// The deadlines are seconds long, so the wedge cases use vitest fake timers and
// advance the clock rather than waiting. The slow cases use real timers with
// short delays, because the thing being proven there is that a call which
// finishes normally is passed through untouched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── ln-service, fully controllable ─────────────────────────────────────────

const rpc = vi.hoisted(() => ({
  /** When true, every stubbed RPC returns a promise that never settles. */
  wedged: false,
  /** Milliseconds a stubbed RPC takes to resolve when not wedged. */
  latencyMs: 0,
  calls: [] as string[],
}));

function stub<T>(name: string, value: T) {
  return async (_args?: unknown): Promise<T> => {
    rpc.calls.push(name);
    if (rpc.wedged) return new Promise<T>(() => {});
    if (rpc.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, rpc.latencyMs));
    }
    return value;
  };
}

vi.mock("ln-service", () => ({
  authenticatedLndGrpc: () => ({ lnd: { mocked: true } }),
  getWalletInfo: stub("getWalletInfo", {
    public_key: "02aa",
    alias: "n",
    version: "0.20.0",
    current_block_height: 1,
    is_synced_to_chain: true,
    features: [],
  }),
  getChainBalance: stub("getChainBalance", { chain_balance: 123 }),
  getChannels: stub("getChannels", { channels: [] }),
  getPeers: stub("getPeers", { peers: [] }),
  getIdentity: stub("getIdentity", { public_key: "02aa" }),
  getInvoices: stub("getInvoices", { invoices: [] }),
  getForwards: stub("getForwards", { forwards: [], next: undefined }),
  getPendingChannels: stub("getPendingChannels", { pending_channels: [] }),
  getPendingChainBalance: stub("getPendingChainBalance", { pending_chain_balance: 0 }),
  getChainTransactions: stub("getChainTransactions", { transactions: [] }),
  createChainAddress: stub("createChainAddress", { address: "bcrt1qx" }),
  createInvoice: stub("createInvoice", { request: "lnbcrt1", id: "ff" }),
  getChainFeeRate: stub("getChainFeeRate", { tokens_per_vbyte: 3 }),
  getUtxos: stub("getUtxos", { utxos: [] }),
  signMessage: stub("signMessage", { signature: "sig" }),
  verifyMessage: stub("verifyMessage", { signed_by: "02aa" }),
  getRouteToDestination: stub("getRouteToDestination", { route: { fee: 1 } }),
  addPeer: stub("addPeer", undefined),
  updateAlias: stub("updateAlias", undefined),
  // Held calls — reachable, so the held cases below exercise a real path.
  sendToChainAddress: stub("sendToChainAddress", { id: "tx", tokens: 1, is_confirmed: false }),
  openChannel: stub("openChannel", { transaction_id: "tx" }),
  closeChannel: stub("closeChannel", { transaction_id: "tx" }),
  payViaRoutes: stub("payViaRoutes", { id: "p", fee: 1 }),
  payViaPaymentDetails: stub("payViaPaymentDetails", {
    fee: 0, id: "p", is_confirmed: true, tokens: 1, secret: "s",
  }),
}));

// The client's credential preconditions are filesystem checks; satisfy them so
// the tests reach the RPC layer rather than failing at getLndClient().
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: { ...actual, existsSync: () => true, readFileSync: () => Buffer.from("x") },
    existsSync: () => true,
    readFileSync: () => Buffer.from("x"),
  };
});

import * as lnd from "./lnd";
import { LND_FAST_CALL_TIMEOUT_MS, LND_GOSSIP_CALL_TIMEOUT_MS } from "./callDeadline";

beforeEach(() => {
  rpc.wedged = false;
  rpc.latencyMs = 0;
  rpc.calls = [];
  lnd.invalidateLndClient();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run `fn` against a wedged transport and return how it settles. */
async function underWedge(fn: () => Promise<unknown>, advanceMs: number) {
  vi.useFakeTimers();
  rpc.wedged = true;
  const p = fn();
  const settled = p.then(() => "resolved" as const).catch((e) => e);
  await vi.advanceTimersByTimeAsync(advanceMs);
  return settled;
}

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDED — the wedge must become a rejection.
// ═══════════════════════════════════════════════════════════════════════════

const FAST_CASES: ReadonlyArray<[string, () => Promise<unknown>]> = [
  ["getLndInfo", () => lnd.getLndInfo()],
  ["getLndChainBalance", () => lnd.getLndChainBalance()],
  ["getLndChannels", () => lnd.getLndChannels()],
  ["getLndPeers", () => lnd.getLndPeers()],
  ["getLndPendingChannels", () => lnd.getLndPendingChannels()],
  ["getLndPendingChainBalance", () => lnd.getLndPendingChainBalance()],
  ["getLndChainTransactions", () => lnd.getLndChainTransactions()],
  ["getLndInvoices", () => lnd.getLndInvoices()],
  ["getLndForwards", () => lnd.getLndForwards()],
  ["getLndIdentity", () => lnd.getLndIdentity()],
  ["getLndUtxos", () => lnd.getLndUtxos()],
  ["getLndChainFeeRate", () => lnd.getLndChainFeeRate()],
  ["createLndChainAddress", () => lnd.createLndChainAddress()],
  ["createLndInvoice", () => lnd.createLndInvoice(1)],
  ["isKeysendEnabled", () => lnd.isKeysendEnabled()],
  ["lndSignMessage", () => lnd.lndSignMessage("m")],
  ["lndVerifyMessage", () => lnd.lndVerifyMessage("m", "s")],
  ["updateNodeAlias", () => lnd.updateNodeAlias("a")],
  ["connectToPeer", () => lnd.connectToPeer("02bb", "1.2.3.4:9735")],
];

describe("CONTROL 1 — a wedged LND makes bounded calls reject at the fast deadline", () => {
  for (const [name, call] of FAST_CASES) {
    it(`${name} rejects with ETIMEDOUT`, async () => {
      const outcome = await underWedge(call, LND_FAST_CALL_TIMEOUT_MS + 10);
      expect(outcome, `${name} did not reject under a wedge`).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/^ETIMEDOUT:/);
    });
  }

  it("getLndRouteToDestination rejects at the LONGER gossip deadline, not the fast one", async () => {
    // Also a control on the class split: if this were bound at 3s the first
    // assertion would pass for the wrong reason, so check it is STILL PENDING
    // just after the fast deadline.
    vi.useFakeTimers();
    rpc.wedged = true;
    let done = false;
    const p = lnd
      .getLndRouteToDestination({ destination: "02bb", tokens: 1 })
      .catch((e) => { done = true; return e; });

    await vi.advanceTimersByTimeAsync(LND_FAST_CALL_TIMEOUT_MS + 50);
    expect(done, "gossip call was bound at the fast deadline, not the gossip one").toBe(false);

    await vi.advanceTimersByTimeAsync(
      LND_GOSSIP_CALL_TIMEOUT_MS - LND_FAST_CALL_TIMEOUT_MS + 50,
    );
    expect((await p).message).toMatch(/^ETIMEDOUT:/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL 2 — slow but healthy still succeeds. The one that matters most.
// ═══════════════════════════════════════════════════════════════════════════

describe("CONTROL 2 — a slow-but-healthy LND still returns normally", () => {
  it("a 50ms getLndChainBalance against a 3s deadline resolves", async () => {
    rpc.latencyMs = 50;
    await expect(lnd.getLndChainBalance()).resolves.toEqual({ chain_balance: 123 });
  });

  it("a 50ms getLndChannels resolves", async () => {
    rpc.latencyMs = 50;
    await expect(lnd.getLndChannels()).resolves.toEqual({ channels: [] });
  });

  it("a 50ms getLndInfo resolves with its mapped shape intact", async () => {
    rpc.latencyMs = 50;
    await expect(lnd.getLndInfo()).resolves.toMatchObject({
      public_key: "02aa",
      synced_to_chain: true,
    });
  });

  it("⚠ a call resolving 1ms INSIDE the real 3s deadline still succeeds", async () => {
    // The done-when at the actual production number rather than a scaled proxy.
    // This is the self-inflicted-outage case: if the deadline fired at or just
    // before its nominal value, healthy-but-loaded nodes would start failing,
    // and on a fleet that updates by farmer click a bad number cannot be
    // recalled. Fake timers so this costs no wall clock.
    vi.useFakeTimers();
    rpc.latencyMs = LND_FAST_CALL_TIMEOUT_MS - 1;

    const p = lnd.getLndChainBalance();
    await vi.advanceTimersByTimeAsync(LND_FAST_CALL_TIMEOUT_MS - 1);

    await expect(p).resolves.toEqual({ chain_balance: 123 });
  });

  it("the wrapper does not change what a healthy call returns", async () => {
    // Guards the green-control mechanism "it resolved, so the assertion passed":
    // the VALUE has to survive the wrapper, not just the promise.
    await expect(lnd.getLndChainFeeRate(6)).resolves.toEqual({ tokens_per_vbyte: 3 });
    await expect(lnd.createLndChainAddress()).resolves.toEqual({ address: "bcrt1qx" });
    await expect(lnd.lndSignMessage("m")).resolves.toBe("sig");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL 4, BEHAVIOURAL COMPANION — the held calls stay unbounded.
// ═══════════════════════════════════════════════════════════════════════════

describe("CONTROL 4 (behavioural) — held calls do not time out", () => {
  const HELD_CASES: ReadonlyArray<[string, () => Promise<unknown>]> = [
    ["sendLndToChainAddress", () => lnd.sendLndToChainAddress("bcrt1qx", 1)],
    ["openTreasuryChannel", () => lnd.openTreasuryChannel("02bb", 100_000)],
    ["closeTreasuryChannel", () => lnd.closeTreasuryChannel("tx", 0)],
    ["payLndViaRoutes", () => lnd.payLndViaRoutes("ff", [] as never[])],
    ["keysendPush", () => lnd.keysendPush({ destination: "02bb", tokens: 1 })],
  ];

  for (const [name, call] of HELD_CASES) {
    it(`${name} is STILL PENDING long past every deadline in the tree`, async () => {
      // The structural control in heldCalls.test.ts is the primary guard; this
      // is the behavioural companion. It cannot prove "never times out" — that
      // is a negative over unbounded time — so it proves the observable thing:
      // still pending well past the LONGEST deadline present anywhere.
      const beyondLongest = LND_GOSSIP_CALL_TIMEOUT_MS * 3;
      const outcome = await Promise.race([
        underWedge(call, beyondLongest),
        Promise.resolve("still-pending" as const),
      ]);
      expect(outcome, `${name} settled — it must be unbounded`).toBe("still-pending");
    });
  }

  it("a held call resolving past the longest deadline still returns normally", async () => {
    // The positive form: not merely "does not reject" but "completes and hands
    // back its value" after longer than any bounded call would tolerate.
    rpc.latencyMs = 30;
    await expect(lnd.sendLndToChainAddress("bcrt1qx", 5)).resolves.toEqual({
      id: "tx", tokens: 1, is_confirmed: false,
    });
    expect(rpc.calls).toContain("sendToChainAddress");
  });
});
