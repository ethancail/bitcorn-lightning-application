// LND credential/connectivity health probing — per-scope, read-only, report-only.
//
// WHY THIS EXISTS. Nothing in this app can currently report an LND credential,
// permission, or connectivity fault. `isLndAvailable()` (lnd.ts:51-59) checks
// that tls.cert and the macaroon EXIST on disk — a present-but-wrong, revoked,
// or under-scoped macaroon reads as available. The 15s sync loop swallows the
// resulting failures into a console.warn (index.ts:248) which carries err.code
// and err.details and then discards them; and its OTHER failure path
// (`{ok:false, reason:"lnd_unavailable"}` from sync.ts:22) RESOLVES rather than
// throwing, so it produces no output at all.
//
// THE STATE THIS IS FOR. The dangerous case is not total LND loss —
// /api/node/balances already fails closed on that, because its
// getLndChainBalance() call throws and the web freshness tracker
// (app/web/src/components/freshness.ts) turns three failed polls into a stale
// marker. The dangerous case is PARTIAL: onchain:read alive, offchain:read
// lost. Then /api/node/balances still returns 200 — one live number
// (chain_balance) plus one arbitrarily-stale number (SUM over lnd_channels,
// frozen because persistChannels() is failing) — consecutiveFailures stays 0,
// and the UI reports "fresh" indefinitely.
//
// Hence: ONE PROBE PER SCOPE, and NEVER an aggregate verdict. `info:read`
// succeeding proves nothing about `offchain:read`, which is the scope the
// capital-guardrail staleness (BACKLOG §2) actually hinges on. There is
// deliberately no `healthy` boolean here — a consumer computes its own rollup.
//
// PRIVILEGE. All three probes are calls the app already makes in normal
// operation (sync.ts, persist*.ts, /api/node/balances), so probing grants no
// privilege the app does not already hold. Nothing under offchain:write,
// onchain:write or peers:write is eligible — a probe that writes would be the
// privilege argument this work exists to avoid.
//
// STYLE. Mirrors app/api/src/base/staleness.ts: pure functions, clock injected
// by the caller, no module-level clock read, no DB access. Nothing here
// self-schedules and nothing here registers a route — the timer and the
// endpoint are a deferred follow-on step.
//
// PARALLEL CLASSIFIER. app/api/src/subscription/payFromNode.ts:107-179 solves
// the connectivity half correctly and is the pattern this follows, but it is
// shared with the subscription rail and has live tests, so its
// LND_UNAVAILABLE_RE is deliberately NOT extended or imported. This is a
// separate implementation.

/** The kinds a scope probe can report. Exactly one per scope, per probe. */
export type LndFaultKind =
  | "ok"
  | "files_absent"
  | "connectivity"
  | "auth"
  | "permission"
  | "malformed";

/** The three read-only macaroon scopes this app depends on. */
export type LndScope = "info:read" | "offchain:read" | "onchain:read";

export const LND_SCOPES: readonly LndScope[] = [
  "info:read",
  "offchain:read",
  "onchain:read",
];

/**
 * Thrown internally when a probe call RESOLVES but its payload does not match
 * the shape the app relies on (proto drift, a version mismatch, a truncated
 * response). Routed through classifyLndError like any other fault so there is
 * a single funnel.
 */
export class LndMalformedResponseError extends Error {
  readonly isMalformedResponse = true;
  constructor(message: string) {
    super(message);
    this.name = "LndMalformedResponseError";
  }
}

/**
 * Pure. Flatten any thrown LND value into a readable string. ln-service throws
 * array-shaped errors like `[503, 'FailedToConnect', {err}]`; plain Errors,
 * strings and bare objects also occur. Never throws.
 */
export function lndFaultDetail(err: unknown): string {
  if (err == null) return "unknown error";
  if (Array.isArray(err)) {
    return err
      .map((part) => {
        if (typeof part === "string" || typeof part === "number") return String(part);
        if (part instanceof Error) return part.message;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(" ");
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Pure. Extract a numeric gRPC status code if the error carries one, else null.
 *
 * These are the two numbers this whole module turns on:
 *   16 UNAUTHENTICATED   — "I don't know who you are"      -> auth
 *    7 PERMISSION_DENIED — "I know you, and you may not"   -> permission
 *
 * They reach the catch site today (index.ts:248 logs err?.code) and are thrown
 * away. Looked for on the error itself, on a nested `.err`, and inside an
 * ln-service array payload.
 */
export function grpcStatusCode(err: unknown): number | null {
  const fromValue = (v: unknown): number | null => {
    if (v == null || typeof v !== "object") return null;
    const code = (v as { code?: unknown }).code;
    if (typeof code === "number" && Number.isInteger(code)) return code;
    return null;
  };

  const direct = fromValue(err);
  if (direct !== null) return direct;

  if (err != null && typeof err === "object") {
    const nested = fromValue((err as { err?: unknown }).err);
    if (nested !== null) return nested;
  }

  if (Array.isArray(err)) {
    for (const part of err) {
      const inner = fromValue(part);
      if (inner !== null) return inner;
      if (part != null && typeof part === "object") {
        const deeper = fromValue((part as { err?: unknown }).err);
        if (deeper !== null) return deeper;
      }
    }
  }

  return null;
}

// ─── Classification ─────────────────────────────────────────────────────────
//
// PRECEDENCE IS LOAD-BEARING AND IS TESTED. In particular the app's OWN error
// from lnd.ts:67 — "LND files not available: missing TLS cert or readonly
// macaroon" — contains the word "macaroon", so it MUST be matched as a
// connect/file problem before any macaroon-text auth rule runs. Getting that
// order wrong reports a missing file as a rejected credential.

/** The app's own pre-flight failures (lnd.ts:67, lnd.ts:89). Checked FIRST. */
const APP_OWN_RE = /LND files not available|Failed to initialize LND client/i;

/** Transport-level failure signatures. */
const CONNECTIVITY_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|FailedToConnect|No connection established|\b14 UNAVAILABLE\b|UNAVAILABLE/i;

/** Authenticated-but-refused. Checked BEFORE the auth rules: more specific. */
const PERMISSION_RE = /permission denied|not authorized to access|PermissionDenied/i;

/** Credential-not-recognised signatures. */
const AUTH_RE =
  /invalid auth|verification failed|cannot determine data format|macaroon|Unauthenticated|expired credential/i;

/** Response we could not decode. */
const MALFORMED_RE =
  /failed to decode|unexpected EOF|cannot unmarshal|proto|parse error|unexpected token/i;

/**
 * Pure. Map a thrown LND value to exactly one LndFaultKind. Never throws.
 *
 * Order: shape failure -> numeric gRPC status -> text signatures -> malformed.
 *
 * The numeric status wins over text because it is unambiguous. Text is the
 * fallback, and it is needed: LND has reported permission failures as both
 * gRPC 7 and gRPC 2-with-"permission denied"-text across versions, so neither
 * signal alone is sufficient.
 *
 * An UNRECOGNISED error becomes `malformed` — "we could not make sense of
 * this" — and the caller keeps the raw `code`/`detail` alongside the kind, so
 * nothing is discarded and the case stays diagnosable.
 */
export function classifyLndError(err: unknown): LndFaultKind {
  // 1. A resolved-but-unusable payload, raised by our own shape assertions.
  if (
    err != null &&
    typeof err === "object" &&
    (err as { isMalformedResponse?: unknown }).isMalformedResponse === true
  ) {
    return "malformed";
  }

  // 2. Numeric gRPC status — unambiguous where present.
  //    NOTE: ln-service's leading array element (e.g. 503) is an HTTP-ish
  //    status, NOT a gRPC code; grpcStatusCode only reads `.code` properties,
  //    so it is never mistaken for one.
  const code = grpcStatusCode(err);
  if (code !== null) {
    switch (code) {
      case 16: // UNAUTHENTICATED — credential not recognised
        return "auth";
      case 7: // PERMISSION_DENIED — recognised, not permitted this method
        return "permission";
      case 14: // UNAVAILABLE — transport
        return "connectivity";
      case 3: // INVALID_ARGUMENT
      case 12: // UNIMPLEMENTED — method absent (build-tag / version drift)
      case 13: // INTERNAL — commonly a decode failure
        return "malformed";
      // gRPC 2 UNKNOWN is deliberately NOT mapped here: LND uses it for
      // several unrelated conditions, so it falls through to the text rules.
    }
  }

  const detail = lndFaultDetail(err);

  // 3. Text signatures, most-specific first.
  if (APP_OWN_RE.test(detail)) return "connectivity";
  if (CONNECTIVITY_RE.test(detail)) return "connectivity";
  if (PERMISSION_RE.test(detail)) return "permission";
  if (AUTH_RE.test(detail)) return "auth";
  if (MALFORMED_RE.test(detail)) return "malformed";

  // 4. Unrecognised — kind is coarse, but code/detail are preserved upstream.
  return "malformed";
}

// ─── Probe runner ────────────────────────────────────────────────────────────

/**
 * The LND surface the runner needs, injected so it is testable with no timer,
 * no route, no DB and no native bindings. `defaultLndProbeDeps()` wires the
 * real lnd.ts wrappers; tests pass spies.
 */
export interface LndProbeDeps {
  /** Wraps isLndAvailable() — a FILESYSTEM fact, not a credential fact. */
  isAvailable: () => boolean;
  /** info:read */
  getWalletInfo: () => Promise<unknown>;
  /** offchain:read */
  getChannels: () => Promise<unknown>;
  /** onchain:read */
  getChainBalance: () => Promise<unknown>;
}

export interface LndScopeResult {
  scope: LndScope;
  kind: LndFaultKind;
  /** gRPC status if the error carried one — preserved, not discarded. */
  code: number | null;
  /** Flattened error text, or "" when the probe succeeded. */
  detail: string;
}

export interface LndHealthReport {
  checked_at: number;
  /**
   * Whether tls.cert AND the macaroon are present on disk. Deliberately a
   * SEPARATE field from the per-scope kinds: files_absent is a filesystem
   * fact, the other five kinds are credential facts, and they can disagree —
   * the lndClient singleton (lnd.ts:45,:70-71) means a deleted macaroon file
   * can coexist with a cached client that still works.
   */
  files_present: boolean;
  /** Always one entry per scope, in LND_SCOPES order. Never aggregated. */
  scopes: LndScopeResult[];
  /**
   * How many probe calls were actually attempted. 0 when files are absent —
   * this is what makes "detected without any LND call" observable rather than
   * merely asserted.
   */
  probe_calls_attempted: number;
}

/** Minimal shape assertions — what each call site actually relies on. */
function assertInfoShape(value: unknown): void {
  const pk = (value as { public_key?: unknown } | null | undefined)?.public_key;
  if (typeof pk !== "string" || pk.length === 0) {
    throw new LndMalformedResponseError(
      "getWalletInfo returned no usable public_key",
    );
  }
}

function assertChannelsShape(value: unknown): void {
  const channels = (value as { channels?: unknown } | null | undefined)?.channels;
  if (!Array.isArray(channels)) {
    throw new LndMalformedResponseError("getChannels returned no channels array");
  }
}

function assertChainBalanceShape(value: unknown): void {
  const bal = (value as { chain_balance?: unknown } | null | undefined)?.chain_balance;
  if (typeof bal !== "number" || !Number.isFinite(bal)) {
    throw new LndMalformedResponseError(
      "getChainBalance returned no numeric chain_balance",
    );
  }
}

/**
 * Run one scope probe. Never throws — every outcome becomes a result.
 */
async function probeScope(
  scope: LndScope,
  call: () => Promise<unknown>,
  assertShape: (value: unknown) => void,
): Promise<LndScopeResult> {
  try {
    const value = await call();
    assertShape(value);
    return { scope, kind: "ok", code: null, detail: "" };
  } catch (err) {
    return {
      scope,
      kind: classifyLndError(err),
      code: grpcStatusCode(err),
      detail: lndFaultDetail(err),
    };
  }
}

/**
 * Probe all three scopes and report per-scope results.
 *
 * Plain async function: does NOT self-schedule, does NOT read a clock, does
 * NOT touch the database. `nowMs` is supplied by the caller.
 *
 * Short-circuits on absent files WITHOUT attempting any LND call.
 */
export async function runLndHealthProbe(
  deps: LndProbeDeps,
  nowMs: number,
): Promise<LndHealthReport> {
  const filesPresent = deps.isAvailable();

  if (!filesPresent) {
    return {
      checked_at: nowMs,
      files_present: false,
      scopes: LND_SCOPES.map((scope) => ({
        scope,
        kind: "files_absent" as LndFaultKind,
        code: null,
        detail: "tls.cert and/or macaroon not present on disk",
      })),
      probe_calls_attempted: 0,
    };
  }

  const scopes = await Promise.all([
    probeScope("info:read", deps.getWalletInfo, assertInfoShape),
    probeScope("offchain:read", deps.getChannels, assertChannelsShape),
    probeScope("onchain:read", deps.getChainBalance, assertChainBalanceShape),
  ]);

  return {
    checked_at: nowMs,
    files_present: true,
    scopes,
    probe_calls_attempted: scopes.length,
  };
}

/**
 * Production wiring for the deferred timer/endpoint. The import is lazy and
 * inside the function body on purpose: it keeps this module free of lnd.ts,
 * db.ts and better-sqlite3 at import time, so the test file loads pure code.
 */
export function defaultLndProbeDeps(): LndProbeDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lnd = require("./lnd") as typeof import("./lnd");
  return {
    isAvailable: () => lnd.isLndAvailable(),
    getWalletInfo: () => lnd.getLndInfo(),
    getChannels: () => lnd.getLndChannels(),
    getChainBalance: () => lnd.getLndChainBalance(),
  };
}
