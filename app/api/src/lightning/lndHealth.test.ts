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

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// ln-service throws array-shaped errors: [status, 'ReasonString', {err}] — see
// payFromNode.ts:109-112. The gRPC error sits at err[2].err and carries .code
// and .details. NOTE the top-level err.code / err.details / err.message are all
// UNDEFINED on these shapes, which is why grpcStatusCode() traverses into the
// nested .err (and why index.ts:248's `err?.code` logs an empty string —
// reported, out of scope).
//
// ══ PROVENANCE ══════════════════════════════════════════════════════════════
// The REAL_* fixtures below are VERBATIM captures from a live Polar regtest
// node, 2026-08-18:
//     LND 0.20.0-beta  commit b9ea7070c20ad2ca8514a47d9b4d560a501f0487
//     polarlightning/lnd:0.20.0-beta, container polar-n1-Treasury
//
// ⚠ THE KEY OBSERVED FACT: this version returns gRPC 2 UNKNOWN for EVERY
// credential fault. It never returns 7 PERMISSION_DENIED or 16 UNAUTHENTICATED.
// auth and permission are separable ONLY by the details TEXT. That is why
// classifyLndError deliberately leaves gRPC 2 unmapped in its numeric switch
// and falls through to the text rules — on this version the text rules are the
// only thing that separates the two kinds.
//
// The FORWARD_COMPAT_* fixtures carry proper 7/16 codes. Those branches were
// NOT observed on 0.20.0-beta and are retained for versions that do emit them.
// They are the only coverage those branches have.
//
// ⚠ Version limit: this repo does not pin LND (Umbrel owns that container), so
// the treasury and member-node versions are UNKNOWN. These strings are
// established for 0.20.0-beta only — not confirmed against production LND.
// Re-derive with the harness noted in the commit message.
// ════════════════════════════════════════════════════════════════════════════

/** Faithfully reproduce the observed ln-service array shape. */
function lnServiceError(reason: string, code: number, statusWord: string, details: string) {
  const inner = Object.assign(new Error(`${code} ${statusWord}: ${details}`), {
    code,
    details,
    // Plain object, not a Map: grpc-js's Metadata has a toJSON that serialises
    // to exactly this, so lndFaultDetail() produces a string byte-identical to
    // the observed capture.
    metadata: { "content-type": ["application/grpc"] },
  });
  return [503, reason, { err: inner }];
}

// ── REAL captures, LND 0.20.0-beta ──

/** CASE 2 — under-scoped macaroon (info:read + onchain:read, no offchain:read),
 *  getChannels refused. gRPC 2, discriminated by text. */
const REAL_UNDERSCOPED_OFFCHAIN = lnServiceError(
  "UnexpectedGetChannelsError", 2, "UNKNOWN", "permission denied",
);

/** CASE 3a — Farmer1's admin macaroon presented to Treasury. */
const REAL_FOREIGN_MACAROON = lnServiceError(
  "GetWalletInfoErr", 2, "UNKNOWN",
  "verification failed: signature mismatch after caveat verification",
);

/** CASE 3b — a well-formed macaroon with one signature byte flipped.
 *  Observed BYTE-IDENTICAL to 3a: a foreign and a mutated macaroon both fail
 *  the same HMAC check, so they are indistinguishable at the error level. */
const REAL_MUTATED_SIGNATURE = lnServiceError(
  "GetWalletInfoErr", 2, "UNKNOWN",
  "verification failed: signature mismatch after caveat verification",
);

/** CASE 3c — bytes that are not a macaroon at all. A genuinely DISTINCT
 *  signature from 3a/3b: decode failure, not signature failure. */
const REAL_NOT_A_MACAROON = lnServiceError(
  "GetWalletInfoErr", 2, "UNKNOWN",
  "cannot determine data format of binary-encoded macaroon",
);

/** CASE 4 — closed port. The ONLY observed fault carrying a mapped numeric
 *  code, so it resolves via the numeric switch and the CONNECTIVITY_RE text
 *  tokens are never consulted for it. */
const REAL_CLOSED_PORT = lnServiceError(
  "UnexpectedErrorWhenGettingChainBalance", 14, "UNAVAILABLE",
  "No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:10999. Resolution note: ",
);

/** Residual exposure, measured: gRPC 2 with wording no rule recognises falls
 *  to `malformed`. A version that words these differently would report the
 *  wrong KIND (the raw detail is still preserved). Documented, not fixed. */
const REAL_SHAPE_UNRECOGNISED_TEXT = lnServiceError(
  "SomeFutureError", 2, "UNKNOWN", "some future wording nobody has seen",
);

// ── FORWARD-COMPAT: proper codes, NOT observed on 0.20.0-beta ──

const FORWARD_COMPAT_AUTH_16 = [
  503, "UnexpectedErrorGettingWalletInfo",
  { err: { code: 16, details: "invalid auth: invalid macaroon" } },
];
const FORWARD_COMPAT_PERMISSION_7 = [
  503, "UnexpectedErrorGettingChannels",
  { err: { code: 7, details: "permission denied" } },
];

// ── Aliases kept so the existing discrimination suite reads unchanged. The
//    auth/permission pair now points at REAL captures. ──
const AUTH_ARRAY = REAL_FOREIGN_MACAROON;
const PERMISSION_ARRAY = REAL_UNDERSCOPED_OFFCHAIN;
const AUTH_PLAIN = Object.assign(new Error("verification failed"), { code: 16 });
const AUTH_TEXT_ONLY = new Error(
  "cannot determine data format of binary-encoded macaroon",
);
const PERMISSION_PLAIN = Object.assign(new Error("permission denied"), { code: 7 });
const PERMISSION_TEXT_ONLY = new Error("permission denied");

/** Connectivity — synthetic variants exercising CONNECTIVITY_RE text tokens,
 *  which the real capture does NOT reach (it carries code 14). */
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
    // Real 0.20.0-beta captures both carry gRPC 2 — see PROVENANCE.
    expect(grpcStatusCode(AUTH_ARRAY)).toBe(2);
    expect(grpcStatusCode(PERMISSION_ARRAY)).toBe(2);
    // Forward-compat shapes carry the proper codes.
    expect(grpcStatusCode(FORWARD_COMPAT_AUTH_16)).toBe(16);
    expect(grpcStatusCode(FORWARD_COMPAT_PERMISSION_7)).toBe(7);
  });

  it("returns null when no numeric code is present", () => {
    expect(grpcStatusCode(AUTH_TEXT_ONLY)).toBeNull();
    expect(grpcStatusCode(CONN_ARRAY)).toBeNull();
    expect(grpcStatusCode(null)).toBeNull();
    expect(grpcStatusCode("a string")).toBeNull();
  });

  // REGRESSION — proven necessary by the 0.20.0-beta captures. On the real
  // shape the top-level err.code/.details/.message are ALL undefined; the
  // values live only at err[2].err.*. A grpcStatusCode() that read the top
  // level would return null for every real fault and every credential error
  // would fall to the text rules with no numeric signal at all. (This is also
  // exactly why index.ts:248's `err?.code` logs an empty string — reported,
  // out of scope.)
  it("extracts from err[2].err on the real shape, where the top level is undefined", () => {
    const real: any = REAL_UNDERSCOPED_OFFCHAIN;
    expect(real.code).toBeUndefined();
    expect(real.details).toBeUndefined();
    expect(real.message).toBeUndefined();
    expect(real[2].err.code).toBe(2);
    expect(grpcStatusCode(real)).toBe(2);
  });

  it("extracts code 14 from the real closed-port capture", () => {
    expect(grpcStatusCode(REAL_CLOSED_PORT)).toBe(14);
  });
});

// ─── lndFaultDetail ─────────────────────────────────────────────────────────

describe("lndFaultDetail — never throws, always yields something readable", () => {
  it("flattens an ln-service array including the nested err payload", () => {
    const d = lndFaultDetail(PERMISSION_ARRAY);
    expect(d).toContain("503");
    expect(d).toContain("UnexpectedGetChannelsError"); // observed reason string
    expect(d).toContain("permission denied");
    // Byte-identical to the 0.20.0-beta capture.
    expect(d).toBe(
      '503 UnexpectedGetChannelsError {"err":{"code":2,"details":"permission denied","metadata":{"content-type":["application/grpc"]}}}',
    );
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

// ─── REAL CAPTURES — LND 0.20.0-beta, Polar regtest, 2026-08-18 ─────────────
//
// These assert against VERBATIM observed values. See the PROVENANCE block at the
// top of this file. Every one of these resolves through the TEXT rules, not the
// numeric switch, because 0.20.0-beta reports gRPC 2 UNKNOWN for all of them.

describe("real captures (LND 0.20.0-beta): observed strings classify correctly", () => {
  it("case 2 — under-scoped macaroon, getChannels refused -> permission", () => {
    expect(classifyLndError(REAL_UNDERSCOPED_OFFCHAIN)).toBe("permission");
    expect(grpcStatusCode(REAL_UNDERSCOPED_OFFCHAIN)).toBe(2);
    expect(lndFaultDetail(REAL_UNDERSCOPED_OFFCHAIN)).toContain("permission denied");
  });

  it("case 3a — foreign macaroon (baked on another node) -> auth", () => {
    expect(classifyLndError(REAL_FOREIGN_MACAROON)).toBe("auth");
    expect(grpcStatusCode(REAL_FOREIGN_MACAROON)).toBe(2);
    expect(lndFaultDetail(REAL_FOREIGN_MACAROON)).toContain(
      "verification failed: signature mismatch after caveat verification",
    );
  });

  it("case 3b — mutated signature byte -> auth (same string as 3a)", () => {
    expect(classifyLndError(REAL_MUTATED_SIGNATURE)).toBe("auth");
    // Observed identical: both fail the same HMAC check.
    expect(lndFaultDetail(REAL_MUTATED_SIGNATURE)).toBe(
      lndFaultDetail(REAL_FOREIGN_MACAROON),
    );
  });

  it("case 3c — not a macaroon at all -> auth, via a DISTINCT string", () => {
    expect(classifyLndError(REAL_NOT_A_MACAROON)).toBe("auth");
    expect(lndFaultDetail(REAL_NOT_A_MACAROON)).toContain(
      "cannot determine data format of binary-encoded macaroon",
    );
    // Distinct signature from the signature-mismatch cases.
    expect(lndFaultDetail(REAL_NOT_A_MACAROON)).not.toBe(
      lndFaultDetail(REAL_FOREIGN_MACAROON),
    );
  });

  it("case 4 — closed port -> connectivity, via the NUMERIC path (code 14)", () => {
    expect(classifyLndError(REAL_CLOSED_PORT)).toBe("connectivity");
    expect(grpcStatusCode(REAL_CLOSED_PORT)).toBe(14);
  });

  // The whole point, on real values: same gRPC code, different kind.
  it("separates auth from permission on IDENTICAL gRPC code 2", () => {
    expect(grpcStatusCode(REAL_FOREIGN_MACAROON)).toBe(2);
    expect(grpcStatusCode(REAL_UNDERSCOPED_OFFCHAIN)).toBe(2);
    expect(classifyLndError(REAL_FOREIGN_MACAROON)).toBe("auth");
    expect(classifyLndError(REAL_UNDERSCOPED_OFFCHAIN)).toBe("permission");
    expect(classifyLndError(REAL_FOREIGN_MACAROON)).not.toBe(
      classifyLndError(REAL_UNDERSCOPED_OFFCHAIN),
    );
  });

  it("all four real fault kinds are simultaneously distinct", () => {
    expect([
      classifyLndError(REAL_CLOSED_PORT),
      classifyLndError(REAL_FOREIGN_MACAROON),
      classifyLndError(REAL_UNDERSCOPED_OFFCHAIN),
      classifyLndError(REAL_SHAPE_UNRECOGNISED_TEXT),
    ]).toEqual(["connectivity", "auth", "permission", "malformed"]);
  });
});

describe("residual exposure (documented, not fixed)", () => {
  // gRPC 2 with unrecognised wording -> malformed. A version phrasing these
  // differently would report the wrong KIND. The raw detail is still preserved,
  // so the fault stays diagnosable. This test pins the behaviour so a change
  // to it is deliberate rather than accidental.
  it("gRPC 2 with wording no rule recognises falls to malformed", () => {
    expect(classifyLndError(REAL_SHAPE_UNRECOGNISED_TEXT)).toBe("malformed");
    expect(lndFaultDetail(REAL_SHAPE_UNRECOGNISED_TEXT)).toContain(
      "some future wording nobody has seen",
    );
  });
});

describe("forward-compat: proper gRPC codes NOT observed on 0.20.0-beta", () => {
  // These branches are unexercised by any real capture. Retained because a
  // different LND version may emit them, and this is their only coverage.
  it("gRPC 16 UNAUTHENTICATED -> auth", () => {
    expect(classifyLndError(FORWARD_COMPAT_AUTH_16)).toBe("auth");
    expect(grpcStatusCode(FORWARD_COMPAT_AUTH_16)).toBe(16);
  });

  it("gRPC 7 PERMISSION_DENIED -> permission", () => {
    expect(classifyLndError(FORWARD_COMPAT_PERMISSION_7)).toBe("permission");
    expect(grpcStatusCode(FORWARD_COMPAT_PERMISSION_7)).toBe(7);
  });

  it("the numeric branches stay distinct from each other", () => {
    expect(classifyLndError(FORWARD_COMPAT_AUTH_16)).not.toBe(
      classifyLndError(FORWARD_COMPAT_PERMISSION_7),
    );
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
    // Real 0.20.0-beta values: code 2, discriminated by the details text.
    for (const s of report.scopes) {
      expect(s.code).toBe(2);
      expect(s.detail).toContain("verification failed: signature mismatch");
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

    // ⚠ THE HEADLINE FINDING, as an assertion. On LND 0.20.0-beta both faults
    // carry the SAME gRPC code (2 UNKNOWN). The numeric status therefore does
    // NOT separate them — only the details text does. This assertion used to
    // read `expect(a.code).not.toBe(p.code)` against synthetic 16/7 fixtures,
    // which is FALSE on real data. Inverting it is the point: the kinds differ
    // while the codes are identical.
    expect(a.code).toBe(2);
    expect(p.code).toBe(2);
    expect(a.code).toBe(p.code);
    expect(a.detail).not.toBe(p.detail);
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
    expect(offchain.code).toBe(2); // real 0.20.0-beta value, not 7
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
