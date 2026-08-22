// Classification coverage for the LND-fault alert producer.
//
// NOTHING IS MOCKED HERE. Reports are produced by driving the real
// runLndHealthProbe() with injected LndProbeDeps that throw the classifier's
// VERBATIM 0.20.0-beta captures, so what is asserted is the whole chain from a
// real thrown LND value to the alert an operator would read. No DB, no gRPC, no
// better-sqlite3 — lndHealth.ts and lndFaultAlerts.ts are both pure and
// lndFaultAlerts imports only TYPES from treasury-alerts.ts, which tsc erases.
//
// The wiring — that treasury-alerts.ts's catch site actually calls this — is
// covered separately in treasury-alerts.test.ts, which is the only file in this
// pair that mocks anything.

import { describe, expect, it } from "vitest";
import {
  runLndHealthProbe,
  type LndProbeDeps,
  type LndHealthReport,
} from "../lightning/lndHealth";
import { withProbeTimeout, LND_PROBE_TIMEOUT_MS } from "../lightning/lndProbeRoute";
import {
  lndFaultAlerts,
  SEVERITY_BY_KIND,
  LND_FAULT_ALERT,
  RESERVE_CHECK_SKIPPED_ALERT,
} from "./lndFaultAlerts";

// ─── Fixtures: the real ln-service array shape ──────────────────────────────

function lnServiceError(reason: string, code: number, statusWord: string, details: string) {
  const inner = Object.assign(new Error(`${code} ${statusWord}: ${details}`), {
    code,
    details,
    metadata: { "content-type": ["application/grpc"] },
  });
  return [503, reason, { err: inner }];
}

/** Under-scoped macaroon, getChannels refused. gRPC 2. */
const PERMISSION_FAULT = lnServiceError(
  "UnexpectedGetChannelsError", 2, "UNKNOWN", "permission denied",
);
/** Foreign macaroon. gRPC 2 — IDENTICAL code to permission above. */
const AUTH_FAULT = lnServiceError(
  "GetWalletInfoErr", 2, "UNKNOWN",
  "verification failed: signature mismatch after caveat verification",
);
/** Closed port. The only observed fault resolving via the numeric switch. */
const CONNECTIVITY_FAULT = lnServiceError(
  "UnexpectedErrorWhenGettingChainBalance", 14, "UNAVAILABLE",
  "No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:10999. Resolution note: ",
);
/** gRPC 2 with wording no rule recognises -> malformed (documented fallback). */
const UNRECOGNISED_FAULT = lnServiceError(
  "SomeFutureError", 2, "UNKNOWN", "some future wording nobody has seen",
);

const OK_WALLET = { public_key: "02aa" };
const OK_CHANNELS = { channels: [] };
const OK_BALANCE = { chain_balance: 5_000_000 };

const NOW = 1_700_000_000_000;
const FLOOR = 1_000_000;
const OPTS = { minOnchainReserveSats: FLOOR };

type Calls = {
  info?: () => Promise<unknown>;
  offchain?: () => Promise<unknown>;
  onchain?: () => Promise<unknown>;
};

/** Build a report by driving the REAL probe with injected deps. */
async function reportFrom(calls: Calls, isAvailable = true): Promise<LndHealthReport> {
  const deps: LndProbeDeps = {
    isAvailable: () => isAvailable,
    getWalletInfo: calls.info ?? (async () => OK_WALLET),
    getChannels: calls.offchain ?? (async () => OK_CHANNELS),
    getChainBalance: calls.onchain ?? (async () => OK_BALANCE),
  };
  return runLndHealthProbe(deps, NOW);
}

const throws = (v: unknown) => async () => { throw v; };

function typesOf(alerts: { type: string }[]): string[] {
  return alerts.map((a) => a.type).sort();
}

// ═══════════════════════════════════════════════════════════════════════════
// THE PAIR: a fault produces the fault alert; healthy does not.
// ═══════════════════════════════════════════════════════════════════════════

describe("fault alert appears on a broken credential", () => {
  it("emits LND_FAULT for a refused credential", async () => {
    const report = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    const alerts = lndFaultAlerts(report, NOW, OPTS);
    expect(typesOf(alerts)).toContain(LND_FAULT_ALERT);
  });

  it("does NOT emit LND_FAULT when every scope is ok", async () => {
    const report = await reportFrom({});
    const alerts = lndFaultAlerts(report, NOW, OPTS);
    expect(typesOf(alerts)).not.toContain(LND_FAULT_ALERT);
  });

  it("⚠ the healthy case still reports the skipped check — the guardrail did not run", async () => {
    // Reaching the producer means the reserve call threw. Even if the follow-up
    // probe finds nothing, the floor went unverified for this cycle.
    const report = await reportFrom({});
    const alerts = lndFaultAlerts(report, NOW, OPTS);

    expect(typesOf(alerts)).toEqual([RESERVE_CHECK_SKIPPED_ALERT]);
    expect(alerts[0].data.reason).toBe("transient");
    expect(alerts[0].message).toContain("no fault");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KIND DISCRIMINATION — the assertion that matters most.
// An alert saying "LND unhealthy" for every cause is a much smaller fix than it
// looks. auth and permission arrive as the SAME gRPC code on 0.20.0-beta.
// ═══════════════════════════════════════════════════════════════════════════

describe("the KIND survives into the alert", () => {
  it("permission reports kind=permission", async () => {
    const report = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    const fault = lndFaultAlerts(report, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;
    expect(fault.data.kinds).toEqual(["permission"]);
    expect(fault.message).toContain("offchain:read permission");
  });

  it("auth reports kind=auth", async () => {
    const report = await reportFrom({ info: throws(AUTH_FAULT) });
    const fault = lndFaultAlerts(report, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;
    expect(fault.data.kinds).toEqual(["auth"]);
    expect(fault.message).toContain("info:read auth");
  });

  it("⚠ auth and permission yield DIFFERENT alerts despite identical gRPC code 2", async () => {
    const authReport = await reportFrom({ info: throws(AUTH_FAULT) });
    const permReport = await reportFrom({ info: throws(PERMISSION_FAULT) });

    // Same numeric code — only the classifier's TEXT rules separate them.
    expect(authReport.scopes.find((s) => s.scope === "info:read")!.code).toBe(2);
    expect(permReport.scopes.find((s) => s.scope === "info:read")!.code).toBe(2);

    const a = lndFaultAlerts(authReport, NOW, OPTS).find((x) => x.type === LND_FAULT_ALERT)!;
    const p = lndFaultAlerts(permReport, NOW, OPTS).find((x) => x.type === LND_FAULT_ALERT)!;

    expect(a.data.kinds).not.toEqual(p.data.kinds);
    expect(a.message).not.toBe(p.message);
  });

  it("connectivity, malformed and files_absent are each distinct kinds on the alert", async () => {
    const conn = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });
    const malformed = await reportFrom({ onchain: throws(UNRECOGNISED_FAULT) });
    const absent = await reportFrom({}, /* isAvailable */ false);

    const kindsFor = async (r: LndHealthReport) =>
      lndFaultAlerts(r, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!.data.kinds;

    expect(await kindsFor(conn)).toEqual(["connectivity"]);
    expect(await kindsFor(malformed)).toEqual(["malformed"]);
    expect(await kindsFor(absent)).toEqual(["files_absent"]);
  });

  it("all five fault kinds are simultaneously distinct", async () => {
    const reports = await Promise.all([
      reportFrom({ info: throws(AUTH_FAULT) }),
      reportFrom({ info: throws(PERMISSION_FAULT) }),
      reportFrom({ info: throws(CONNECTIVITY_FAULT) }),
      reportFrom({ info: throws(UNRECOGNISED_FAULT) }),
      reportFrom({}, false),
    ]);
    const kinds = reports.map(
      (r) => lndFaultAlerts(r, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!.data.kinds[0],
    );
    expect(new Set(kinds).size).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PARTIAL CASE — the state the whole arc exists for.
// ═══════════════════════════════════════════════════════════════════════════

describe("the partial case stays visible on the alert", () => {
  it("reports the faulted scope AND the healthy ones", async () => {
    // onchain:read alive, offchain:read lost — /api/node/balances would still
    // return 200 with one live number and one frozen one.
    const report = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    const fault = lndFaultAlerts(report, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;

    expect(fault.data.scopes).toHaveLength(3);
    expect(fault.data.scopes.map((s: any) => `${s.scope}=${s.kind}`)).toEqual([
      "info:read=ok", "offchain:read=permission", "onchain:read=ok",
    ]);
    // The message names only what is broken, so it is readable at a glance.
    expect(fault.message).toContain("offchain:read permission");
    expect(fault.message).not.toContain("info:read");
  });

  it("a partial fault differs from a total fault", async () => {
    const partial = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    const total = await reportFrom({
      info: throws(PERMISSION_FAULT),
      offchain: throws(PERMISSION_FAULT),
      onchain: throws(PERMISSION_FAULT),
    });

    const pf = lndFaultAlerts(partial, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;
    const tf = lndFaultAlerts(total, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;

    // Same kind, same severity — but not the same observation.
    expect(pf.data.kinds).toEqual(tf.data.kinds);
    expect(pf.message).not.toBe(tf.message);
    expect(pf.data.scopes.filter((s: any) => s.kind !== "ok")).toHaveLength(1);
    expect(tf.data.scopes.filter((s: any) => s.kind !== "ok")).toHaveLength(3);
  });

  it("mixed kinds across scopes are all carried", async () => {
    const report = await reportFrom({
      info: throws(AUTH_FAULT),
      offchain: throws(PERMISSION_FAULT),
    });
    const fault = lndFaultAlerts(report, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;
    expect(fault.data.kinds).toEqual(["auth", "permission"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEVERITY MAPPING
// ═══════════════════════════════════════════════════════════════════════════

describe("severity mapping", () => {
  it("maps the six kinds as decided", () => {
    expect(SEVERITY_BY_KIND).toEqual({
      ok: null,
      auth: "critical",
      permission: "critical",
      files_absent: "critical",
      malformed: "warning",
      connectivity: "warning",
    });
  });

  it("⚠ never uses info — Dashboard renders only critical and warning", () => {
    // An info alert would be invisible to the only human consumer of this
    // surface (Dashboard.tsx activeAlerts filter).
    expect(Object.values(SEVERITY_BY_KIND)).not.toContain("info");
  });

  it("a credential fault is critical, a connectivity blip is warning", async () => {
    const auth = await reportFrom({ info: throws(AUTH_FAULT) });
    const conn = await reportFrom({ info: throws(CONNECTIVITY_FAULT) });

    const sev = (r: LndHealthReport) =>
      lndFaultAlerts(r, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!.severity;

    expect(sev(auth)).toBe("critical");
    expect(sev(conn)).toBe("warning");
    expect(sev(auth)).not.toBe(sev(conn));
  });

  it("mixed severities take the worst, and the kinds all survive it", async () => {
    const report = await reportFrom({
      info: throws(CONNECTIVITY_FAULT),   // warning
      offchain: throws(PERMISSION_FAULT), // critical
    });
    const fault = lndFaultAlerts(report, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!;

    expect(fault.severity).toBe("critical");
    // Display priority picked one severity; no KIND was collapsed.
    expect(fault.data.kinds).toEqual(["connectivity", "permission"]);
  });

  it("the skipped-check signal is critical regardless of the fault kind", async () => {
    for (const f of [AUTH_FAULT, PERMISSION_FAULT, CONNECTIVITY_FAULT, UNRECOGNISED_FAULT]) {
      const report = await reportFrom({ onchain: throws(f) });
      const skipped = lndFaultAlerts(report, NOW, OPTS)
        .find((a) => a.type === RESERVE_CHECK_SKIPPED_ALERT)!;
      expect(skipped.severity).toBe("critical");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SKIPPED SIGNAL IS SEPARABLE FROM A PASSING CHECK
// ═══════════════════════════════════════════════════════════════════════════

describe("the did-not-run signal is its own type", () => {
  it("is emitted on every producer call, fault or not", async () => {
    const faulted = lndFaultAlerts(
      await reportFrom({ onchain: throws(PERMISSION_FAULT) }), NOW, OPTS,
    );
    const clean = lndFaultAlerts(await reportFrom({}), NOW, OPTS);

    expect(typesOf(faulted)).toContain(RESERVE_CHECK_SKIPPED_ALERT);
    expect(typesOf(clean)).toContain(RESERVE_CHECK_SKIPPED_ALERT);
  });

  it("names the unverified floor and says it is not a passing check", async () => {
    const alerts = lndFaultAlerts(
      await reportFrom({ onchain: throws(PERMISSION_FAULT) }), NOW, OPTS,
    );
    const skipped = alerts.find((a) => a.type === RESERVE_CHECK_SKIPPED_ALERT)!;

    expect(skipped.message).toContain("DID NOT RUN");
    expect(skipped.message).toContain("not a passing check");
    expect(skipped.data.min_reserve_sats).toBe(FLOOR);
    expect(skipped.data.reason).toBe("lnd_fault");
  });

  it("distinguishes an LND-caused skip from a transient one", async () => {
    const faultCaused = lndFaultAlerts(
      await reportFrom({ onchain: throws(PERMISSION_FAULT) }), NOW, OPTS,
    ).find((a) => a.type === RESERVE_CHECK_SKIPPED_ALERT)!;
    const transient = lndFaultAlerts(await reportFrom({}), NOW, OPTS)
      .find((a) => a.type === RESERVE_CHECK_SKIPPED_ALERT)!;

    expect(faultCaused.data.reason).toBe("lnd_fault");
    expect(transient.data.reason).toBe("transient");
    expect(faultCaused.message).not.toBe(transient.message);
  });

  it("is distinct from LND_FAULT — two alert types, not one", async () => {
    const alerts = lndFaultAlerts(
      await reportFrom({ onchain: throws(PERMISSION_FAULT) }), NOW, OPTS,
    );
    expect(typesOf(alerts)).toEqual([LND_FAULT_ALERT, RESERVE_CHECK_SKIPPED_ALERT].sort());
    expect(new Set(alerts.map((a) => a.type)).size).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TIMEOUT — the pair, at the producer's own layer.
// ═══════════════════════════════════════════════════════════════════════════

describe("a wedged probe becomes an alert, not a hang", () => {
  const neverSettles = () => new Promise<never>(() => {});

  it("negative control: WITHOUT the wrapper the report never arrives", async () => {
    const unwrapped: LndProbeDeps = {
      isAvailable: () => true,
      getWalletInfo: async () => OK_WALLET,
      getChannels: neverSettles,
      getChainBalance: async () => OK_BALANCE,
    };
    const probe = runLndHealthProbe(unwrapped, NOW).then(() => "settled" as const);
    const timer = new Promise<"pending">((r) => globalThis.setTimeout(() => r("pending"), 150));
    expect(await Promise.race([probe, timer])).toBe("pending");
  });

  it("WITH the wrapper it settles into a connectivity alert", async () => {
    const wrapped: LndProbeDeps = {
      isAvailable: () => true,
      getWalletInfo: async () => OK_WALLET,
      getChannels: withProbeTimeout("offchain:read", neverSettles, 40),
      getChainBalance: async () => OK_BALANCE,
    };
    const report = await runLndHealthProbe(wrapped, NOW);
    const alerts = lndFaultAlerts(report, NOW, OPTS);
    const fault = alerts.find((a) => a.type === LND_FAULT_ALERT)!;

    expect(fault.data.kinds).toEqual(["connectivity"]);
    expect(fault.severity).toBe("warning");   // the known under-weighting
    // The wedged/refused distinction lives in detail, not kind.
    expect(
      fault.data.scopes.find((s: any) => s.scope === "offchain:read").detail,
    ).toContain("ETIMEDOUT");
    expect(typesOf(alerts)).toContain(RESERVE_CHECK_SKIPPED_ALERT);
  });

  it("a wedged probe and a refused port differ in detail though both are connectivity", async () => {
    const wedged = await runLndHealthProbe({
      isAvailable: () => true,
      getWalletInfo: async () => OK_WALLET,
      getChannels: async () => OK_CHANNELS,
      getChainBalance: withProbeTimeout("onchain:read", neverSettles, 40),
    }, NOW);
    const refused = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });

    const detailOf = (r: LndHealthReport) =>
      lndFaultAlerts(r, NOW, OPTS).find((a) => a.type === LND_FAULT_ALERT)!
        .data.scopes.find((s: any) => s.scope === "onchain:read").detail;

    expect(detailOf(wedged)).toContain("ETIMEDOUT");
    expect(detailOf(refused)).toContain("ECONNREFUSED");
    expect(detailOf(wedged)).not.toBe(detailOf(refused));
  });

  it("reuses the endpoint's deadline constant — no second timeout value", () => {
    expect(LND_PROBE_TIMEOUT_MS).toBe(3000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PURITY
// ═══════════════════════════════════════════════════════════════════════════

describe("purity", () => {
  it("stamps `at` from the injected clock only", async () => {
    const report = await reportFrom({ onchain: throws(PERMISSION_FAULT) });
    for (const a of lndFaultAlerts(report, 424242, OPTS)) {
      expect(a.at).toBe(424242);
    }
  });

  it("is deterministic — same report in, same alerts out", async () => {
    const report = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    expect(lndFaultAlerts(report, NOW, OPTS)).toEqual(lndFaultAlerts(report, NOW, OPTS));
  });

  it("conforms to the existing TreasuryAlert shape — no reshaping", async () => {
    const report = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    for (const a of lndFaultAlerts(report, NOW, OPTS)) {
      expect(Object.keys(a).sort()).toEqual(["at", "data", "message", "severity", "type"]);
      expect(["info", "warning", "critical"]).toContain(a.severity);
      expect(typeof a.message).toBe("string");
      expect(typeof a.at).toBe("number");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 3 — cert-expiry severity composition.
//
// The severity STRINGS are branched on downstream (Dashboard.tsx renders only
// "critical" and "warning"), so these assert the VALUE, not merely that some
// carrier changed.
//
// The half that matters is (b), the future-notAfter control. Without it this
// seam could blanket-escalate EVERY connectivity fault to critical and (a)
// would still pass — which would fire on every container bounce and teach the
// operator to ignore criticals, the exact alert-fatigue failure that
// SEVERITY_BY_KIND's reasoning exists to avoid.
// ═══════════════════════════════════════════════════════════════════════════

type ProducedAlerts = ReturnType<typeof lndFaultAlerts>;

const DAY = 24 * 60 * 60 * 1000;

/** Shaped like certExpiry.ts's CertFacts, built inline so this file stays pure. */
function certFacts(notAfterMs: number, nowMs: number) {
  return {
    ok: true as const,
    notBeforeMs: notAfterMs - 400 * DAY,
    notAfterMs,
    daysRemaining: Math.floor((notAfterMs - nowMs) / DAY),
    isExpired: nowMs >= notAfterMs,
    subject: "CN=fixture",
  };
}

const EXPIRED_CERT = certFacts(NOW - 4 * DAY, NOW); // lapsed 4 days ago
const VALID_CERT = certFacts(NOW + 200 * DAY, NOW); // 200 days of runway

const sevOf = (alerts: ProducedAlerts) =>
  alerts.find((a) => a.type === LND_FAULT_ALERT)!.severity;
const msgOf = (alerts: ProducedAlerts) =>
  alerts.find((a) => a.type === LND_FAULT_ALERT)!.message;

describe("PAIR 3 — an expired cert makes a connectivity fault critical", () => {
  // ── (a) the escalation ──
  it("connectivity + a notAfter in the PAST is critical", async () => {
    const report = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });
    const alerts = lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: EXPIRED_CERT });
    expect(sevOf(alerts)).toBe("critical");
  });

  // ── (b) THE CONTROL — proves the seam did not blanket-escalate ──
  it("connectivity + a notAfter in the FUTURE stays warning", async () => {
    const report = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });
    const valid = lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: VALID_CERT });

    expect(sevOf(valid)).toBe("warning");
    // The inequality, so neither half can be a constant.
    const expired = lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: EXPIRED_CERT });
    expect(sevOf(valid)).not.toBe(sevOf(expired));
  });

  it("omitting certExpiry leaves connectivity at warning — every existing caller unaffected", async () => {
    const report = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });
    expect(sevOf(lndFaultAlerts(report, NOW, OPTS))).toBe("warning");
  });

  it("an unreadable cert does not escalate — 'could not tell' is not 'expired'", async () => {
    const report = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });
    const alerts = lndFaultAlerts(report, NOW, {
      ...OPTS,
      certExpiry: { ok: false as const, reason: "could not parse certificate" },
    });
    expect(sevOf(alerts)).toBe("warning");
  });

  it("an expired cert alone, with NO connectivity fault, does not escalate", async () => {
    // A healthy node whose cert is merely old must not produce a false critical.
    const report = await reportFrom({ offchain: throws(PERMISSION_FAULT) });
    const alerts = lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: EXPIRED_CERT });
    // permission is critical on its own merits; what matters is that the cert
    // note was NOT attached, because no connectivity fault was observed.
    expect(msgOf(alerts)).not.toMatch(/NOT TRANSIENT/);
  });

  it("says NOT TRANSIENT and names the date, so nobody is sent to check their internet", async () => {
    const report = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });
    const msg = msgOf(lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: EXPIRED_CERT }));

    expect(msg).toMatch(/NOT TRANSIENT/);
    expect(msg).toMatch(/certificate EXPIRED on \d{4}-\d{2}-\d{2}/);
    expect(msg).toMatch(/restart the lightning app/i);
    // Copy constraint, same shape as confirmMachine.test.ts:153-154.
    expect(msg).not.toMatch(/ask your (node )?operator/i);
    expect(msg).not.toMatch(/contact your (node )?operator/i);
  });

  it("an expired cert does NOT walk back an already-critical credential fault", async () => {
    const report = await reportFrom({ info: throws(AUTH_FAULT) });
    expect(sevOf(lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: VALID_CERT }))).toBe("critical");
    expect(sevOf(lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: EXPIRED_CERT }))).toBe("critical");
  });

  it("carries the cert facts in data, and null when the cert was unreadable", async () => {
    const report = await reportFrom({ onchain: throws(CONNECTIVITY_FAULT) });

    const withCert = lndFaultAlerts(report, NOW, { ...OPTS, certExpiry: EXPIRED_CERT })
      .find((a) => a.type === LND_FAULT_ALERT)!;
    expect((withCert.data as Record<string, unknown>).cert_expiry).toEqual({
      not_after_ms: EXPIRED_CERT.notAfterMs,
      days_remaining: -4,
      is_expired: true,
    });

    const unreadable = lndFaultAlerts(report, NOW, {
      ...OPTS,
      certExpiry: { ok: false as const, reason: "x" },
    }).find((a) => a.type === LND_FAULT_ALERT)!;
    // null = "we looked and could not read it"; undefined = "we did not look".
    expect((unreadable.data as Record<string, unknown>).cert_expiry).toBeNull();
  });
});
