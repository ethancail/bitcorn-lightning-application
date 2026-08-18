import { describe, it, expect, vi } from "vitest";
import {
  classifyLndError,
  grpcStatusCode,
  lndFaultDetail,
  runLndHealthProbe,
  LndMalformedResponseError,
  LND_SCOPES,
  type LndProbeDeps,
  type LndFaultKind,
} from "./lndHealth";

// ─── Fixtures modelled on real ln-service / gRPC error shapes ────────────────
//
// ln-service throws array-shaped errors: [status, 'CodeString', {err}] — see
// payFromNode.ts:109-112. The underlying gRPC error carries a numeric .code
// and a .details string. Phase 1 confirmed both reach the catch site at
// index.ts:248 and are discarded.

/** gRPC 16 UNAUTHENTICATED — the credential is not recognised. */
const AUTH_ARRAY = [
  503,
  "UnexpectedErrorGettingWalletInfo",
  { err: { code: 16, details: "invalid auth: invalid macaroon" } },
];
const AUTH_PLAIN = Object.assign(new Error("verification failed"), { code: 16 });
const AUTH_TEXT_ONLY = new Error(
  "cannot determine data format of binary-encoded macaroon",
);

/** gRPC 7 PERMISSION_DENIED — recognised, but not allowed this method. */
const PERMISSION_ARRAY = [
  503,
  "UnexpectedErrorGettingChannels",
  { err: { code: 7, details: "permission denied" } },
];
const PERMISSION_PLAIN = Object.assign(new Error("permission denied"), { code: 7 });
const PERMISSION_TEXT_ONLY = new Error("permission denied");

/** Connectivity. */
const CONN_ARRAY = [503, "FailedToConnect", {}];
const CONN_PLAIN = Object.assign(
  new Error("14 UNAVAILABLE: No connection established"),
  { code: 14 },
);
const CONN_ECONNREFUSED = new Error("connect ECONNREFUSED 127.0.0.1:10009");

/**
 * The app's OWN error from lnd.ts:67. ⚠ It contains the word "macaroon", so a
 * naive text order would classify it as `auth`. It is a file/connect problem.
 */
const CONN_APP_OWN = new Error(
  "LND files not available: missing TLS cert or readonly macaroon",
);

/** Malformed / undecodable. */
const MALFORMED_DECODE = Object.assign(
  new Error("failed to decode response: unexpected EOF"),
  { code: 13 },
);
const UNRECOGNISED = new Error("some totally unfamiliar failure mode");

const OK_WALLET = { public_key: "02aa", alias: "n", version: "0.18" };
const OK_CHANNELS = { channels: [] };
const OK_BALANCE = { chain_balance: 12_345 };

const NOW = 1_760_000_000_000;

/** Deps whose three probes all succeed. Spies so calls are countable. */
function workingDeps(): LndProbeDeps {
  return {
    isAvailable: vi.fn(() => true),
    getWalletInfo: vi.fn(async () => OK_WALLET),
    getChannels: vi.fn(async () => OK_CHANNELS),
    getChainBalance: vi.fn(async () => OK_BALANCE),
  };
}

function kindsByScope(scopes: { scope: string; kind: LndFaultKind }[]) {
  return Object.fromEntries(scopes.map((s) => [s.scope, s.kind]));
}

// ─── grpcStatusCode ─────────────────────────────────────────────────────────

describe("grpcStatusCode — pulls the numeric status out of every shape", () => {
  it("reads a code off the error itself", () => {
    expect(grpcStatusCode(AUTH_PLAIN)).toBe(16);
  });

  it("reads a code nested under .err inside an ln-service array", () => {
    expect(grpcStatusCode(AUTH_ARRAY)).toBe(16);
    expect(grpcStatusCode(PERMISSION_ARRAY)).toBe(7);
  });

  it("returns null when no numeric code is present", () => {
    expect(grpcStatusCode(AUTH_TEXT_ONLY)).toBeNull();
    expect(grpcStatusCode(CONN_ARRAY)).toBeNull();
    expect(grpcStatusCode(null)).toBeNull();
    expect(grpcStatusCode("a string")).toBeNull();
  });
});

// ─── lndFaultDetail ─────────────────────────────────────────────────────────

describe("lndFaultDetail — never throws, always yields something readable", () => {
  it("flattens an ln-service array including the nested err payload", () => {
    const d = lndFaultDetail(PERMISSION_ARRAY);
    expect(d).toContain("503");
    expect(d).toContain("UnexpectedErrorGettingChannels");
    expect(d).toContain("permission denied");
  });

  it("handles Error, string, null and undefined", () => {
    expect(lndFaultDetail(new Error("boom"))).toBe("boom");
    expect(lndFaultDetail("plain")).toBe("plain");
    expect(lndFaultDetail(null)).toBe("unknown error");
    expect(lndFaultDetail(undefined)).toBe("unknown error");
  });
});

// ─── classifyLndError — the discrimination this arc exists for ──────────────

describe("classifyLndError — auth vs permission are DISTINCT kinds", () => {
  it("classifies gRPC 16 UNAUTHENTICATED as auth (array shape)", () => {
    expect(classifyLndError(AUTH_ARRAY)).toBe("auth");
  });

  it("classifies gRPC 16 UNAUTHENTICATED as auth (plain Error + code)", () => {
    expect(classifyLndError(AUTH_PLAIN)).toBe("auth");
  });

  it("classifies macaroon-format text with no code as auth", () => {
    expect(classifyLndError(AUTH_TEXT_ONLY)).toBe("auth");
  });

  it("classifies gRPC 7 PERMISSION_DENIED as permission (array shape)", () => {
    expect(classifyLndError(PERMISSION_ARRAY)).toBe("permission");
  });

  it("classifies gRPC 7 PERMISSION_DENIED as permission (plain Error + code)", () => {
    expect(classifyLndError(PERMISSION_PLAIN)).toBe("permission");
  });

  it("classifies 'permission denied' text with no code as permission", () => {
    expect(classifyLndError(PERMISSION_TEXT_ONLY)).toBe("permission");
  });

  // The load-bearing assertion: these two must not collapse into one another.
  it("never reports auth and permission as the same kind", () => {
    expect(classifyLndError(AUTH_ARRAY)).not.toBe(
      classifyLndError(PERMISSION_ARRAY),
    );
    expect(classifyLndError(AUTH_PLAIN)).not.toBe(
      classifyLndError(PERMISSION_PLAIN),
    );
  });

  it("keeps auth and permission distinct from connectivity", () => {
    const conn = classifyLndError(CONN_PLAIN);
    expect(conn).toBe("connectivity");
    expect(classifyLndError(AUTH_ARRAY)).not.toBe(conn);
    expect(classifyLndError(PERMISSION_ARRAY)).not.toBe(conn);
  });
});

describe("classifyLndError — connectivity", () => {
  // Each of these also asserts INEQUALITY against an auth fixture. Without
  // that, a classifier hard-wired to return "connectivity" would satisfy them
  // vacuously — which is exactly what the pre-fix stub run demonstrated.
  it("classifies ln-service FailedToConnect as connectivity", () => {
    expect(classifyLndError(CONN_ARRAY)).toBe("connectivity");
    expect(classifyLndError(CONN_ARRAY)).not.toBe(classifyLndError(AUTH_ARRAY));
  });

  it("classifies gRPC 14 UNAVAILABLE as connectivity", () => {
    expect(classifyLndError(CONN_PLAIN)).toBe("connectivity");
    expect(classifyLndError(CONN_PLAIN)).not.toBe(classifyLndError(AUTH_PLAIN));
  });

  it("classifies ECONNREFUSED as connectivity", () => {
    expect(classifyLndError(CONN_ECONNREFUSED)).toBe("connectivity");
    expect(classifyLndError(CONN_ECONNREFUSED)).not.toBe(
      classifyLndError(PERMISSION_PLAIN),
    );
  });

  // PRECEDENCE TRAP: lnd.ts:67's own message contains the word "macaroon", so
  // a naive text order classifies it as auth. The inequality against a GENUINE
  // macaroon-format error is the load-bearing half here.
  it("classifies the app's own 'missing TLS cert or readonly macaroon' as connectivity, NOT auth", () => {
    expect(classifyLndError(CONN_APP_OWN)).toBe("connectivity");
    expect(classifyLndError(CONN_APP_OWN)).not.toBe("auth");
    expect(classifyLndError(CONN_APP_OWN)).not.toBe(
      classifyLndError(AUTH_TEXT_ONLY),
    );
  });

  // Impossible to satisfy with any constant classifier: four fixtures must
  // yield four different kinds, in this order.
  it("separates all four fault kinds simultaneously", () => {
    const kinds = [
      classifyLndError(CONN_ARRAY),
      classifyLndError(AUTH_ARRAY),
      classifyLndError(PERMISSION_ARRAY),
      classifyLndError(MALFORMED_DECODE),
    ];
    expect(kinds).toEqual(["connectivity", "auth", "permission", "malformed"]);
    expect(new Set(kinds).size).toBe(4);
  });
});

describe("classifyLndError — malformed", () => {
  it("classifies a shape-check failure as malformed", () => {
    expect(classifyLndError(new LndMalformedResponseError("no public_key"))).toBe(
      "malformed",
    );
  });

  it("classifies a decode failure as malformed", () => {
    expect(classifyLndError(MALFORMED_DECODE)).toBe("malformed");
  });

  // Ethan's decision: unrecognised errors land in malformed, with detail kept.
  it("classifies an unrecognised error as malformed", () => {
    expect(classifyLndError(UNRECOGNISED)).toBe("malformed");
  });

  it("classifies null/undefined/empty object as malformed", () => {
    expect(classifyLndError(null)).toBe("malformed");
    expect(classifyLndError(undefined)).toBe("malformed");
    expect(classifyLndError({})).toBe("malformed");
  });

  it("keeps malformed distinct from all four other fault kinds", () => {
    const malformed = classifyLndError(MALFORMED_DECODE);
    expect(malformed).toBe("malformed");
    for (const other of [AUTH_ARRAY, PERMISSION_ARRAY, CONN_ARRAY]) {
      expect(classifyLndError(other)).not.toBe(malformed);
    }
  });

  it("never returns a kind outside the six-value union", () => {
    const allowed: LndFaultKind[] = [
      "ok",
      "files_absent",
      "connectivity",
      "auth",
      "permission",
      "malformed",
    ];
    for (const fixture of [
      AUTH_ARRAY, AUTH_PLAIN, AUTH_TEXT_ONLY,
      PERMISSION_ARRAY, PERMISSION_PLAIN, PERMISSION_TEXT_ONLY,
      CONN_ARRAY, CONN_PLAIN, CONN_ECONNREFUSED, CONN_APP_OWN,
      MALFORMED_DECODE, UNRECOGNISED, null, undefined, {}, "str", 42,
    ]) {
      expect(allowed).toContain(classifyLndError(fixture));
    }
  });
});

// ─── DONE-WHEN 1 — working credential ───────────────────────────────────────

describe("done-when 1: working credential reports ok for all three scopes", () => {
  it("returns ok per scope and attempts all three calls", async () => {
    const deps = workingDeps();
    const report = await runLndHealthProbe(deps, NOW);

    expect(report.files_present).toBe(true);
    expect(report.checked_at).toBe(NOW);
    expect(report.probe_calls_attempted).toBe(3);
    expect(report.scopes).toHaveLength(3);
    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "ok",
      "offchain:read": "ok",
      "onchain:read": "ok",
    });
    for (const s of report.scopes) {
      expect(s.code).toBeNull();
      expect(s.detail).toBe("");
    }
  });

  it("reports one entry per scope, in LND_SCOPES order", async () => {
    const report = await runLndHealthProbe(workingDeps(), NOW);
    expect(report.scopes.map((s) => s.scope)).toEqual([...LND_SCOPES]);
  });
});

// ─── DONE-WHEN 2 — files absent, and NO call attempted ──────────────────────

describe("done-when 2: macaroon absent reports files_absent with no LND call", () => {
  it("reports files_absent for every scope", async () => {
    const deps: LndProbeDeps = { ...workingDeps(), isAvailable: vi.fn(() => false) };
    const report = await runLndHealthProbe(deps, NOW);

    expect(report.files_present).toBe(false);
    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "files_absent",
      "offchain:read": "files_absent",
      "onchain:read": "files_absent",
    });
  });

  // The no-call half is PROVEN by call counts, not asserted in prose.
  it("attempts ZERO LND calls — proven by spy call counts", async () => {
    const deps: LndProbeDeps = { ...workingDeps(), isAvailable: vi.fn(() => false) };
    const report = await runLndHealthProbe(deps, NOW);

    expect(report.probe_calls_attempted).toBe(0);
    expect(deps.getWalletInfo).not.toHaveBeenCalled();
    expect(deps.getChannels).not.toHaveBeenCalled();
    expect(deps.getChainBalance).not.toHaveBeenCalled();
  });

  it("contrast: the working path DOES call each probe exactly once", async () => {
    const deps = workingDeps();
    await runLndHealthProbe(deps, NOW);
    expect(deps.getWalletInfo).toHaveBeenCalledTimes(1);
    expect(deps.getChannels).toHaveBeenCalledTimes(1);
    expect(deps.getChainBalance).toHaveBeenCalledTimes(1);
  });
});

// ─── DONE-WHEN 3 — rejected macaroon reports auth ───────────────────────────

describe("done-when 3: a rejected macaroon reports auth, distinctly", () => {
  it("reports auth on every scope when the credential is rejected", async () => {
    const deps: LndProbeDeps = {
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => { throw AUTH_ARRAY; }),
      getChannels: vi.fn(async () => { throw AUTH_ARRAY; }),
      getChainBalance: vi.fn(async () => { throw AUTH_ARRAY; }),
    };
    const report = await runLndHealthProbe(deps, NOW);

    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "auth",
      "offchain:read": "auth",
      "onchain:read": "auth",
    });
    // The discriminating data is PRESERVED, not discarded as at index.ts:248.
    for (const s of report.scopes) {
      expect(s.code).toBe(16);
      expect(s.detail).toContain("invalid auth");
    }
  });

  it("an auth report differs from a permission report on the same scope", async () => {
    const mk = (thrown: unknown): LndProbeDeps => ({
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => { throw thrown; }),
      getChannels: vi.fn(async () => { throw thrown; }),
      getChainBalance: vi.fn(async () => { throw thrown; }),
    });

    const authReport = await runLndHealthProbe(mk(AUTH_ARRAY), NOW);
    const permReport = await runLndHealthProbe(mk(PERMISSION_ARRAY), NOW);

    const a = authReport.scopes[0];
    const p = permReport.scopes[0];

    expect(a.kind).toBe("auth");
    expect(p.kind).toBe("permission");
    expect(a.kind).not.toBe(p.kind);
    expect(a.code).toBe(16);
    expect(p.code).toBe(7);
    expect(a.code).not.toBe(p.code);
  });
});

// ─── DONE-WHEN 4 — the partial-permission middle state ──────────────────────

describe("done-when 4: partial permission is visible AS partial", () => {
  it("reports ok for info+onchain and permission for offchain", async () => {
    // An under-scoped macaroon: info:read and onchain:read granted,
    // offchain:read refused. This is the state the whole arc exists for.
    const deps: LndProbeDeps = {
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => OK_WALLET),
      getChannels: vi.fn(async () => { throw PERMISSION_ARRAY; }),
      getChainBalance: vi.fn(async () => OK_BALANCE),
    };
    const report = await runLndHealthProbe(deps, NOW);

    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "ok",
      "offchain:read": "permission",
      "onchain:read": "ok",
    });
  });

  it("is neither wholly healthy nor wholly broken", async () => {
    const deps: LndProbeDeps = {
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => OK_WALLET),
      getChannels: vi.fn(async () => { throw PERMISSION_ARRAY; }),
      getChainBalance: vi.fn(async () => OK_BALANCE),
    };
    const report = await runLndHealthProbe(deps, NOW);
    const kinds = report.scopes.map((s) => s.kind);

    // ⚠ The every/some pair alone is satisfied by ANY non-ok kind, so it passed
    // against the stub. The exact-shape assertion is what makes this a real
    // proof that the middle scope is specifically `permission`.
    expect(kinds).toEqual(["ok", "permission", "ok"]);
    expect(kinds.every((k) => k === "ok")).toBe(false);   // not healthy
    expect(kinds.some((k) => k === "ok")).toBe(true);     // not wholly broken
    expect(report.files_present).toBe(true);              // files are fine
    expect(report.probe_calls_attempted).toBe(3);         // all three ran

    const offchain = report.scopes.find((s) => s.scope === "offchain:read")!;
    expect(offchain.code).toBe(7);
    expect(offchain.detail).toContain("permission denied");
  });

  it("distinguishes offchain-lost from onchain-lost", async () => {
    const offchainLost: LndProbeDeps = {
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => OK_WALLET),
      getChannels: vi.fn(async () => { throw PERMISSION_ARRAY; }),
      getChainBalance: vi.fn(async () => OK_BALANCE),
    };
    const onchainLost: LndProbeDeps = {
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => OK_WALLET),
      getChannels: vi.fn(async () => OK_CHANNELS),
      getChainBalance: vi.fn(async () => { throw PERMISSION_ARRAY; }),
    };

    expect(kindsByScope((await runLndHealthProbe(offchainLost, NOW)).scopes)).toEqual({
      "info:read": "ok",
      "offchain:read": "permission",
      "onchain:read": "ok",
    });
    expect(kindsByScope((await runLndHealthProbe(onchainLost, NOW)).scopes)).toEqual({
      "info:read": "ok",
      "offchain:read": "ok",
      "onchain:read": "permission",
    });
  });
});

// ─── DONE-WHEN 5 — malformed response ───────────────────────────────────────

describe("done-when 5: malformed responses report malformed", () => {
  it("reports malformed when a call RESOLVES with an unusable payload", async () => {
    const deps: LndProbeDeps = {
      isAvailable: vi.fn(() => true),
      getWalletInfo: vi.fn(async () => ({ alias: "no pubkey here" })),
      getChannels: vi.fn(async () => ({ channels: "not an array" })),
      getChainBalance: vi.fn(async () => ({ chain_balance: "not a number" })),
    };
    const report = await runLndHealthProbe(deps, NOW);

    expect(kindsByScope(report.scopes)).toEqual({
      "info:read": "malformed",
      "offchain:read": "malformed",
      "onchain:read": "malformed",
    });
    expect(report.probe_calls_attempted).toBe(3);
  });

  it("distinguishes malformed from ok on the same scope set", async () => {
    const good = await runLndHealthProbe(workingDeps(), NOW);
    const bad: LndProbeDeps = {
      ...workingDeps(),
      getChannels: vi.fn(async () => ({ notChannels: true })),
    };
    const badReport = await runLndHealthProbe(bad, NOW);

    expect(kindsByScope(good.scopes)["offchain:read"]).toBe("ok");
    expect(kindsByScope(badReport.scopes)["offchain:read"]).toBe("malformed");
  });
});

// ─── Purity / no hidden dependencies ────────────────────────────────────────

describe("purity: clock injected, no self-scheduling, no aggregate verdict", () => {
  it("stamps checked_at from the injected clock only", async () => {
    const a = await runLndHealthProbe(workingDeps(), 111);
    const b = await runLndHealthProbe(workingDeps(), 222);
    expect(a.checked_at).toBe(111);
    expect(b.checked_at).toBe(222);
  });

  it("classifyLndError is deterministic and side-effect free", () => {
    for (const fixture of [AUTH_ARRAY, PERMISSION_ARRAY, CONN_ARRAY, UNRECOGNISED]) {
      expect(classifyLndError(fixture)).toBe(classifyLndError(fixture));
    }
  });

  it("exposes no aggregate health field — partial must stay visible", async () => {
    const report = await runLndHealthProbe(workingDeps(), NOW);
    expect(report).not.toHaveProperty("healthy");
    expect(report).not.toHaveProperty("status");
    expect(report).not.toHaveProperty("ok");
  });
});
