import { describe, it, expect, vi } from "vitest";
import {
  withProbeTimeout,
  LND_PROBE_TIMEOUT_MS,
} from "./lndProbeRoute";
import {
  runLndHealthProbe,
  classifyLndError,
  LND_SCOPES,
  type LndProbeDeps,
} from "./lndHealth";

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Same ln-service array shape as lndHealth.test.ts's real captures:
// [503, reason, {err}] with the gRPC code/details on the nested err. Reproduced
// here rather than exported from that file so this suite does not couple to its
// internals; the shape and the two 0.20.0-beta detail strings are the ones that
// file records as VERBATIM captures from LND 0.20.0-beta (commit b9ea7070).
function lnServiceError(reason: string, code: number, statusWord: string, details: string) {
  const inner = Object.assign(new Error(`${code} ${statusWord}: ${details}`), {
    code,
    details,
    metadata: { "content-type": ["application/grpc"] },
  });
  return [503, reason, { err: inner }];
}

/** Under-scoped macaroon: offchain:read refused. gRPC 2, separated only by text. */
const PERMISSION_FAULT = lnServiceError(
  "UnexpectedGetChannelsError", 2, "UNKNOWN", "permission denied",
);
/** Foreign/mutated macaroon. gRPC 2 — the SAME code as permission above. */
const AUTH_FAULT = lnServiceError(
  "GetWalletInfoErr", 2, "UNKNOWN",
  "verification failed: signature mismatch after caveat verification",
);
/** Closed port. The one observed fault that resolves via the numeric switch. */
const CONNECTIVITY_FAULT = lnServiceError(
  "UnexpectedErrorWhenGettingChainBalance", 14, "UNAVAILABLE",
  "No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:10999. Resolution note: ",
);

const OK_WALLET = { public_key: "02aa", alias: "t" };
const OK_CHANNELS = { channels: [] };
const OK_BALANCE = { chain_balance: 1000 };

const NOW = 1_700_000_000_000;

/** A call that never settles — a wedged LND that accepted the connection. */
const neverSettles = () => new Promise<never>(() => {});

function kindsByScope(scopes: { scope: string; kind: string }[]) {
  return Object.fromEntries(scopes.map((s) => [s.scope, s.kind]));
}

/** Deps whose three probes are timeout-bound, with an injected call per scope. */
function timedDeps(
  calls: { info: () => Promise<unknown>; offchain: () => Promise<unknown>; onchain: () => Promise<unknown> },
  timeoutMs: number,
  isAvailable = true,
): LndProbeDeps {
  return {
    isAvailable: () => isAvailable,
    getWalletInfo: withProbeTimeout("info:read", calls.info, timeoutMs),
    getChannels: withProbeTimeout("offchain:read", calls.offchain, timeoutMs),
    getChainBalance: withProbeTimeout("onchain:read", calls.onchain, timeoutMs),
  };
}

const workingCalls = {
  info: async () => OK_WALLET,
  offchain: async () => OK_CHANNELS,
  onchain: async () => OK_BALANCE,
};

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCY PIN — not a proof of this change.
//
// The timeout design routes a deadline to `connectivity` through the EXISTING
// classifier rather than adding a seventh kind. That works only because
// CONNECTIVITY_RE lists ETIMEDOUT. This block pins that dependency so the
// design breaks loudly if the regex is ever narrowed. It is green against
// pre-change code BY CONSTRUCTION — it asserts existing behaviour — and is
// labelled as such rather than counted as evidence for the new code.
// ═══════════════════════════════════════════════════════════════════════════

describe("dependency pin: the classifier already routes ETIMEDOUT to connectivity", () => {
  it("classifies an ETIMEDOUT-leading message as connectivity", () => {
    expect(
      classifyLndError(new Error("ETIMEDOUT: info:read probe exceeded 3000ms deadline")),
    ).toBe("connectivity");
  });

  it("does NOT reach auth, permission or malformed on that message", () => {
    const kind = classifyLndError(
      new Error("ETIMEDOUT: offchain:read probe exceeded 3000ms deadline"),
    );
    expect(kind).not.toBe("auth");
    expect(kind).not.toBe("permission");
    expect(kind).not.toBe("malformed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE TIMEOUT — the pair. Unwrapped HANGS; wrapped REPORTS.
//
// One direction alone proves nothing: "wrapped deps report connectivity" is
// satisfied by any implementation that reports connectivity for anything. The
// unwrapped case is what establishes there was a hang to fix.
// ═══════════════════════════════════════════════════════════════════════════

describe("timeout — negative control: WITHOUT the wrapper the probe hangs", () => {
  it("runLndHealthProbe does not settle on a wedged call (unwrapped deps)", async () => {
    const unwrapped: LndProbeDeps = {
      isAvailable: () => true,
      getWalletInfo: async () => OK_WALLET,
      getChannels: neverSettles,          // wedged, no deadline anywhere
      getChainBalance: async () => OK_BALANCE,
    };

    const probe = runLndHealthProbe(unwrapped, NOW).then(() => "settled" as const);
    const race = new Promise<"still-pending">((resolve) =>
      globalThis.setTimeout(() => resolve("still-pending"), 150),
    );

    // This is the defect: no deadline exists in the client or the classifier,
    // so the report never arrives and a 60s poll would stack forever.
    expect(await Promise.race([probe, race])).toBe("still-pending");
  });
});

describe("timeout — with the wrapper the probe reports instead of hanging", () => {
  it("a wedged scope settles as connectivity, naming the deadline in detail", async () => {
    const deps = timedDeps({ ...workingCalls, offchain: neverSettles }, 40);
    const report = await runLndHealthProbe(deps, NOW);

    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "ok",
      "offchain:read": "connectivity",
      "onchain:read": "ok",
    });

    const offchain = report.scopes.find((s) => s.scope === "offchain:read")!;
    expect(offchain.detail).toContain("ETIMEDOUT");
    expect(offchain.detail).toContain("40ms deadline");
    expect(offchain.detail).toContain("offchain:read");
  });

  it("names the scope that timed out — a wedged onchain is not reported as offchain", async () => {
    const offchainWedged = await runLndHealthProbe(
      timedDeps({ ...workingCalls, offchain: neverSettles }, 40), NOW,
    );
    const onchainWedged = await runLndHealthProbe(
      timedDeps({ ...workingCalls, onchain: neverSettles }, 40), NOW,
    );

    expect(kindsByScope(offchainWedged.scopes)).toEqual({
      "info:read": "ok", "offchain:read": "connectivity", "onchain:read": "ok",
    });
    expect(kindsByScope(onchainWedged.scopes)).toEqual({
      "info:read": "ok", "offchain:read": "ok", "onchain:read": "connectivity",
    });
    expect(
      onchainWedged.scopes.find((s) => s.scope === "onchain:read")!.detail,
    ).toContain("onchain:read");
  });

  it("a total wedge reports all three scopes, still with no aggregate", async () => {
    const deps = timedDeps(
      { info: neverSettles, offchain: neverSettles, onchain: neverSettles }, 40,
    );
    const report = await runLndHealthProbe(deps, NOW);

    expect(report.scopes.map((s) => s.kind)).toEqual([
      "connectivity", "connectivity", "connectivity",
    ]);
    expect(report.files_present).toBe(true);
    expect(report.probe_calls_attempted).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRANSPARENCY — the wrapper must not change how real faults classify.
//
// This is the assertion that is genuinely NEW here. The classifier's own suite
// proves these fixtures classify correctly when called directly; what it cannot
// know is whether wrapping the deps mangles, replaces or swallows the thrown
// value on its way through. A wrapper that reported `connectivity` for every
// fault would satisfy the timeout tests above and fail these.
// ═══════════════════════════════════════════════════════════════════════════

describe("transparency: timeout-bound deps preserve every non-timeout kind", () => {
  it("healthy stays healthy through the wrapper — all three ok", async () => {
    const report = await runLndHealthProbe(timedDeps(workingCalls, 5000), NOW);

    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "ok", "offchain:read": "ok", "onchain:read": "ok",
    });
    expect(report.probe_calls_attempted).toBe(3);
  });

  it("auth survives the wrapper as auth", async () => {
    const report = await runLndHealthProbe(
      timedDeps({
        info: async () => { throw AUTH_FAULT; },
        offchain: async () => { throw AUTH_FAULT; },
        onchain: async () => { throw AUTH_FAULT; },
      }, 5000),
      NOW,
    );
    expect(report.scopes.map((s) => s.kind)).toEqual(["auth", "auth", "auth"]);
  });

  it("permission survives the wrapper as permission", async () => {
    const report = await runLndHealthProbe(
      timedDeps({ ...workingCalls, offchain: async () => { throw PERMISSION_FAULT; } }, 5000),
      NOW,
    );
    expect(kindsByScope(report.scopes)["offchain:read"]).toBe("permission");
  });

  it("⚠ auth and permission stay DISTINCT through the wrapper on identical gRPC code 2", async () => {
    const authReport = await runLndHealthProbe(
      timedDeps({ ...workingCalls, info: async () => { throw AUTH_FAULT; } }, 5000), NOW,
    );
    const permReport = await runLndHealthProbe(
      timedDeps({ ...workingCalls, info: async () => { throw PERMISSION_FAULT; } }, 5000), NOW,
    );

    const authScope = authReport.scopes.find((s) => s.scope === "info:read")!;
    const permScope = permReport.scopes.find((s) => s.scope === "info:read")!;

    // Both carry code 2 — only the detail text separates them on 0.20.0-beta.
    expect(authScope.code).toBe(2);
    expect(permScope.code).toBe(2);
    expect(authScope.kind).toBe("auth");
    expect(permScope.kind).toBe("permission");
    expect(authScope.kind).not.toBe(permScope.kind);
  });

  it("connectivity via the NUMERIC path (code 14) survives the wrapper", async () => {
    const report = await runLndHealthProbe(
      timedDeps({ ...workingCalls, onchain: async () => { throw CONNECTIVITY_FAULT; } }, 5000),
      NOW,
    );
    const onchain = report.scopes.find((s) => s.scope === "onchain:read")!;
    expect(onchain.kind).toBe("connectivity");
    expect(onchain.code).toBe(14);
  });

  it("a real fault is distinguishable from a timeout, though both are connectivity", async () => {
    const refused = await runLndHealthProbe(
      timedDeps({ ...workingCalls, onchain: async () => { throw CONNECTIVITY_FAULT; } }, 5000), NOW,
    );
    const wedged = await runLndHealthProbe(
      timedDeps({ ...workingCalls, onchain: neverSettles }, 40), NOW,
    );

    const refusedScope = refused.scopes.find((s) => s.scope === "onchain:read")!;
    const wedgedScope = wedged.scopes.find((s) => s.scope === "onchain:read")!;

    // Same KIND by design — the union is not widened. The DETAIL separates them,
    // which is the documented cost of not adding a seventh kind.
    expect(refusedScope.kind).toBe("connectivity");
    expect(wedgedScope.kind).toBe("connectivity");
    expect(refusedScope.code).toBe(14);
    expect(wedgedScope.code).toBeNull();
    expect(refusedScope.detail).toContain("ECONNREFUSED");
    expect(wedgedScope.detail).toContain("ETIMEDOUT");
    expect(refusedScope.detail).not.toBe(wedgedScope.detail);
  });

  it("files_absent still short-circuits with zero calls when deps are wrapped", async () => {
    const info = vi.fn(neverSettles);
    const offchain = vi.fn(neverSettles);
    const onchain = vi.fn(neverSettles);
    const deps = timedDeps({ info, offchain, onchain }, 40, /* isAvailable */ false);

    const report = await runLndHealthProbe(deps, NOW);

    expect(report.scopes.map((s) => s.kind)).toEqual([
      "files_absent", "files_absent", "files_absent",
    ]);
    expect(report.probe_calls_attempted).toBe(0);
    expect(info).not.toHaveBeenCalled();
    expect(offchain).not.toHaveBeenCalled();
    expect(onchain).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TIMER HYGIENE — load-bearing on the 60s poll.
// ═══════════════════════════════════════════════════════════════════════════

describe("withProbeTimeout leaves no pending timer", () => {
  it("clears the deadline timer when the call resolves first", async () => {
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const bound = withProbeTimeout("info:read", async () => OK_WALLET, 5000);
      await bound();

      const created = setSpy.mock.results.map((r) => r.value);
      expect(created.length).toBeGreaterThan(0);
      // Every timer this wrapper created was cleared again.
      for (const id of created) {
        expect(clearSpy).toHaveBeenCalledWith(id);
      }
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("clears the deadline timer when the call rejects first", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const bound = withProbeTimeout(
        "offchain:read",
        async () => { throw PERMISSION_FAULT; },
        5000,
      );
      await expect(bound()).rejects.toBeDefined();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  it("the bound call is reusable — a fresh timer per invocation", async () => {
    const bound = withProbeTimeout("info:read", async () => OK_WALLET, 5000);
    await expect(bound()).resolves.toEqual(OK_WALLET);
    await expect(bound()).resolves.toEqual(OK_WALLET);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS / CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe("probe contract", () => {
  it("the default deadline is well inside the 60s treasury-alerts poll", () => {
    expect(LND_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LND_PROBE_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("reports one entry per scope in LND_SCOPES order, wrapped or not", async () => {
    const report = await runLndHealthProbe(timedDeps(workingCalls, 5000), NOW);
    expect(report.scopes.map((s) => s.scope)).toEqual([...LND_SCOPES]);
  });

  it("⚠ the report carries EXACTLY the four report keys — no aggregate under any name", async () => {
    const report = await runLndHealthProbe(timedDeps(workingCalls, 5000), NOW);

    // Stronger than a name blocklist: an exact key set cannot be evaded by
    // picking a different word for the rollup (worst_kind, verdict, degraded,
    // all_passed, severity...). lndHealth.test.ts fences three names; this
    // fences the shape.
    expect(Object.keys(report).sort()).toEqual([
      "checked_at", "files_present", "probe_calls_attempted", "scopes",
    ]);
    for (const scope of report.scopes) {
      expect(Object.keys(scope).sort()).toEqual(["code", "detail", "kind", "scope"]);
    }
  });
});
