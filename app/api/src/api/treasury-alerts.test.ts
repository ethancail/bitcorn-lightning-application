// Wiring coverage for getTreasuryAlerts()'s LND-fault path.
//
// ⚠ THIS FILE WAS WRITTEN AGAINST THE UNMODIFIED FUNCTION FIRST, TO PIN THE
// DEFECT, BEFORE ANY CHANGE WAS MADE. treasury-alerts.ts had ZERO coverage, so a
// suite authored alongside the fix would be the same hand writing both sides and
// would prove very little. The pinning version asserted the OLD behaviour and
// passed 9/9 green on unmodified code — specifically that an LND fault produced
// an empty alert list and that `expect(faulted).toEqual(healthy)` HELD. Those
// cases are inverted in place below; each carries the pre-change behaviour in a
// comment so the flip is legible. Raw before/after numbers are in the commit.
//
// WHAT IS AND IS NOT PROVEN HERE. This suite proves WIRING: that the catch site
// calls the producer and that its alerts reach the returned array. The
// CLASSIFICATION — which kind maps to which alert and severity — is proven in
// api/lndFaultAlerts.test.ts against the classifier's real 0.20.0-beta captures
// with NOTHING mocked. Module mocking is confined to this file, where the thing
// under test is the seam rather than the logic.
//
// getTreasuryAlerts() takes no injected dependencies and its signature is
// deliberately unchanged: it is a live capital-facing surface and this arc is
// report-only. Mocking its imports is the only way to reach it.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Controllable mock state ────────────────────────────────────────────────

const s = vi.hoisted(() => ({
  chainBalance: 100_000_000 as number,
  /** Thrown by getLndChainBalance — serves BOTH the reserve check and onchain:read. */
  chainBalanceThrows: null as unknown,
  /** Makes getLndChainBalance never settle. Hangs the reserve check at :121. */
  chainBalanceHangs: false,
  /** Makes getLndChannels (offchain:read) never settle. */
  channelsHang: false,
  minOnchainReserveSats: 1_000_000,
  rotationCandidates: [] as any[],
  dailyLossSats: 0,
  liquidityHealth: [] as any[],
  loopAvailable: { available: true, version: "v0.9" } as any,
  keysendDisabled: [] as any[],
  latestPerMetric: [] as any[],
  metricKeys: [] as string[],
  // Channel-data freshness fixture, as an AGE in ms rather than an absolute
  // timestamp: Date.now() is real in this suite, so a pinned absolute would
  // drift into staleness as the file's slower cases run. Defaults describe a
  // HEALTHY, SYNCED treasury.
  channelAgeMs: 5_000 as number,
  channelRowCount: 3 as number,
  /** null = no lnd_node_info row at all, i.e. never synced. */
  nodeInfoAgeMs: 5_000 as number | null,
}));

// ⚠ THE CHANNEL-DATA READS ARE ANSWERED SPECIFICALLY, NOT BY THE `{ v: 0 }`
// CATCH-ALL. getTreasuryAlerts() now also ages lnd_channels against
// lnd_node_info (CHANNEL_DATA_STALE). Under the blanket `{ v: 0 }` those reads
// return no channel rows and no node-info timestamp, which is a NEVER-SYNCED
// node — so every "quiet treasury" case below would carry a staleness alert and
// the empty-list assertions would fail. That is the classifier being right about
// a fixture that was not describing a quiet treasury at all: a quiet treasury
// has synced. The fixture now says so.
vi.mock("../db", () => ({
  db: {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes("MAX(updated_at)") && sql.includes("lnd_channels")) {
          return {
            latest: s.channelRowCount === 0 ? null : Date.now() - s.channelAgeMs,
            n: s.channelRowCount,
          };
        }
        if (sql.includes("FROM lnd_node_info")) {
          return { updated_at: s.nodeInfoAgeMs == null ? null : Date.now() - s.nodeInfoAgeMs };
        }
        return { v: 0 };
      },
      all: () => s.keysendDisabled,
      run: () => undefined,
    }),
  },
}));

vi.mock("./treasury-capital-policy", () => ({
  getCapitalPolicy: () => ({
    min_onchain_reserve_sats: s.minOnchainReserveSats,
    max_daily_loss_sats: 1_000_000,
    max_daily_deploy_sats: 100_000_000,
    max_expansions_per_day: 10,
  }),
}));

vi.mock("./treasury-rotation", () => ({
  getRotationCandidates: () => s.rotationCandidates,
}));

vi.mock("./treasury-liquidity-health", () => ({
  getLiquidityHealth: () => s.liquidityHealth,
}));

vi.mock("../utils/loss-cap", () => ({
  getDailyLossSats: () => s.dailyLossSats,
}));

// Mocked once and reached two ways: directly by the reserve check, and through
// timeoutBoundProbeDeps()'s dynamic import inside runTimeoutBoundLndProbe. That
// the SAME mock serves both is asserted below ("the probe reaches the mocked
// lnd module"), because a mock that failed to intercept the dynamic import would
// make several cases here pass for the wrong reason.
vi.mock("../lightning/lnd", () => ({
  getLndChainBalance: async () => {
    if (s.chainBalanceHangs) return new Promise(() => {});
    if (s.chainBalanceThrows !== null) throw s.chainBalanceThrows;
    return { chain_balance: s.chainBalance };
  },
  getLndInfo: async () => {
    if (s.chainBalanceThrows !== null) throw s.chainBalanceThrows;
    return { public_key: "02aa" };
  },
  getLndChannels: async () => {
    if (s.channelsHang) return new Promise(() => {});
    if (s.chainBalanceThrows !== null) throw s.chainBalanceThrows;
    return { channels: [] };
  },
  isLndAvailable: () => true,
}));

vi.mock("../lightning/loop", () => ({
  isLoopAvailable: async () => s.loopAvailable,
}));

vi.mock("../config/env", () => ({
  ENV: {
    rebalanceSchedulerEnabled: false,
    rebalanceSchedulerDryRun: false,
    rebalanceSchedulerIntervalMs: 0,
  },
}));

vi.mock("../valuation/manualInputStore", () => ({
  MANUAL_METRIC_KEYS: s.metricKeys,
  listLatestPerMetric: () => s.latestPerMetric,
}));

const { getTreasuryAlerts } = await import("./treasury-alerts");

// ─── Fixtures: the real ln-service array shape ──────────────────────────────

function lnServiceError(reason: string, code: number, statusWord: string, details: string) {
  const inner = Object.assign(new Error(`${code} ${statusWord}: ${details}`), {
    code,
    details,
    metadata: { "content-type": ["application/grpc"] },
  });
  return [503, reason, { err: inner }];
}

const PERMISSION_FAULT = lnServiceError(
  "UnexpectedGetChannelsError", 2, "UNKNOWN", "permission denied",
);
const AUTH_FAULT = lnServiceError(
  "GetWalletInfoErr", 2, "UNKNOWN",
  "verification failed: signature mismatch after caveat verification",
);

const RESERVE_FLOOR = 1_000_000;

function types(alerts: { type: string }[]): string[] {
  return alerts.map((a) => a.type).sort();
}

beforeEach(() => {
  s.chainBalance = 100_000_000;   // 100x the floor
  s.chainBalanceThrows = null;
  s.chainBalanceHangs = false;
  s.channelsHang = false;
  s.minOnchainReserveSats = RESERVE_FLOOR;
  s.rotationCandidates = [];
  s.dailyLossSats = 0;
  s.liquidityHealth = [];
  s.loopAvailable = { available: true, version: "v0.9" };
  s.keysendDisabled = [];
  s.latestPerMetric = [];
  s.metricKeys = [];
  s.channelAgeMs = 5_000;
  s.channelRowCount = 3;
  s.nodeInfoAgeMs = 5_000;
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL FIRST — the harness must be able to produce a reserve alert.
//
// Without this, every "no reserve alert on a fault" assertion could pass
// vacuously: a setup where the reserve check never fires satisfies them for
// reasons unrelated to the defect. This is what makes the absences meaningful.
// ═══════════════════════════════════════════════════════════════════════════

describe("control: the reserve check demonstrably fires in this harness", () => {
  it("emits ONCHAIN_RESERVE_BREACHED below the floor", async () => {
    s.chainBalance = RESERVE_FLOOR - 1;
    const alerts = await getTreasuryAlerts();
    expect(types(alerts)).toContain("ONCHAIN_RESERVE_BREACHED");
    expect(alerts.find((a) => a.type === "ONCHAIN_RESERVE_BREACHED")!.severity).toBe("critical");
  });

  it("emits ONCHAIN_RESERVE_NEAR within 1.2x the floor", async () => {
    s.chainBalance = Math.floor(RESERVE_FLOOR * 1.1);
    expect(types(await getTreasuryAlerts())).toContain("ONCHAIN_RESERVE_NEAR");
  });

  it("emits NEITHER comfortably above the floor", async () => {
    const t = types(await getTreasuryAlerts());
    expect(t).not.toContain("ONCHAIN_RESERVE_BREACHED");
    expect(t).not.toContain("ONCHAIN_RESERVE_NEAR");
  });

  it("a quiet treasury produces an EMPTY alert list", async () => {
    expect(await getTreasuryAlerts()).toEqual([]);
  });

  it("the probe reaches the MOCKED lnd module, not the real one", async () => {
    // If vi.mock did not intercept timeoutBoundProbeDeps()'s dynamic
    // import("./lnd"), the producer would hit real ln-service and this would
    // report a probe_failed or a connectivity fault instead of permission.
    s.chainBalanceThrows = PERMISSION_FAULT;
    const fault = (await getTreasuryAlerts()).find((a) => a.type === "LND_FAULT")!;
    expect(fault.data.kinds).toEqual(["permission"]);
    expect(fault.data.probe_calls_attempted).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT (a), INVERTED — an LND fault now produces an LND alert.
// ═══════════════════════════════════════════════════════════════════════════

describe("defect (a) fixed: an LND fault produces an LND alert", () => {
  it("emits LND_FAULT when the credential is refused", async () => {
    // PINNED PRE-CHANGE: this list was [] — the catch swallowed the fault and no
    // alert of any kind mentioned LND.
    s.chainBalanceThrows = PERMISSION_FAULT;
    const alerts = await getTreasuryAlerts();
    expect(types(alerts)).toContain("LND_FAULT");
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("does NOT emit LND_FAULT when LND is healthy — the other direction", async () => {
    const t = types(await getTreasuryAlerts());
    expect(t).not.toContain("LND_FAULT");
    expect(t).not.toContain("ONCHAIN_RESERVE_CHECK_SKIPPED");
  });

  it("auth and permission are no longer equally invisible", async () => {
    // PINNED PRE-CHANGE: both produced [], and were toEqual each other.
    s.chainBalanceThrows = AUTH_FAULT;
    const authAlerts = await getTreasuryAlerts();
    s.chainBalanceThrows = PERMISSION_FAULT;
    const permAlerts = await getTreasuryAlerts();

    expect(types(authAlerts)).toContain("LND_FAULT");
    expect(types(permAlerts)).toContain("LND_FAULT");

    const a = authAlerts.find((x) => x.type === "LND_FAULT")!;
    const p = permAlerts.find((x) => x.type === "LND_FAULT")!;
    expect(a.data.kinds).not.toEqual(p.data.kinds);
    expect(a.message).not.toBe(p.message);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT (b), INVERTED — a skipped reserve check is now separable from a pass.
// ═══════════════════════════════════════════════════════════════════════════

describe("defect (b) fixed: a skipped reserve check is distinguishable from a passing one", () => {
  it("emits ONCHAIN_RESERVE_CHECK_SKIPPED when the check could not run", async () => {
    // PINNED PRE-CHANGE: nothing recorded that the check had not run.
    s.chainBalanceThrows = PERMISSION_FAULT;
    const alerts = await getTreasuryAlerts();
    expect(types(alerts)).toContain("ONCHAIN_RESERVE_CHECK_SKIPPED");
    expect(
      alerts.find((a) => a.type === "ONCHAIN_RESERVE_CHECK_SKIPPED")!.severity,
    ).toBe("critical");
  });

  it("⚠ THE CORE PIN, FLIPPED: fault output is no longer identical to a healthy reserve", async () => {
    // PINNED PRE-CHANGE this assertion was `expect(faulted).toEqual(healthy)` and
    // it PASSED — both were []. That equality WAS the defect: a broken credential
    // and a comfortably-funded treasury were the same observation to every
    // consumer. It is now an inequality.
    const healthy = await getTreasuryAlerts();

    s.chainBalanceThrows = PERMISSION_FAULT;
    const faulted = await getTreasuryAlerts();

    expect(types(healthy)).not.toEqual(types(faulted));
    expect(types(healthy)).toEqual([]);
    expect(types(faulted)).toEqual(["LND_FAULT", "ONCHAIN_RESERVE_CHECK_SKIPPED"]);
  });

  it("a PASSING reserve check emits no skipped signal — the other direction", async () => {
    s.chainBalance = RESERVE_FLOOR * 50;
    expect(types(await getTreasuryAlerts())).not.toContain("ONCHAIN_RESERVE_CHECK_SKIPPED");
  });

  it("three states where there were two: breached, passing, could-not-tell", async () => {
    s.chainBalance = RESERVE_FLOOR - 1;
    const breached = types(await getTreasuryAlerts());

    s.chainBalance = RESERVE_FLOOR * 50;
    const passing = types(await getTreasuryAlerts());

    s.chainBalanceThrows = PERMISSION_FAULT;
    const cannotTell = types(await getTreasuryAlerts());

    expect(breached).toEqual(["ONCHAIN_RESERVE_BREACHED"]);
    expect(passing).toEqual([]);
    expect(cannotTell).toEqual(["LND_FAULT", "ONCHAIN_RESERVE_CHECK_SKIPPED"]);

    // PINNED PRE-CHANGE: cannotTell equalled passing. It no longer does, and it
    // is still distinct from breached.
    expect(cannotTell).not.toEqual(passing);
    expect(cannotTell).not.toEqual(breached);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FULL THREE-SCOPE PROBE (arc decision 2)
// ═══════════════════════════════════════════════════════════════════════════

describe("the producer probes all three scopes, not just the reserve call's", () => {
  it("reports one entry per scope in LND_SCOPES order", async () => {
    s.chainBalanceThrows = PERMISSION_FAULT;
    const fault = (await getTreasuryAlerts()).find((a) => a.type === "LND_FAULT")!;
    expect(fault.data.scopes).toHaveLength(3);
    expect(fault.data.scopes.map((x: any) => x.scope)).toEqual([
      "info:read", "offchain:read", "onchain:read",
    ]);
  });

  it("surfaces a PARTIAL fault — offchain lost while onchain is alive", async () => {
    // The reserve call (onchain:read) succeeds, so the reserve check itself
    // passes and this path is not even reached. Modelled the other way round:
    // the reserve call fails and the probe shows which scopes are actually fine.
    s.chainBalanceThrows = PERMISSION_FAULT;
    const fault = (await getTreasuryAlerts()).find((a) => a.type === "LND_FAULT")!;
    const byScope = Object.fromEntries(
      fault.data.scopes.map((x: any) => [x.scope, x.kind]),
    );
    expect(byScope["onchain:read"]).toBe("permission");
    expect(fault.data.files_present).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE POLL AND THE DEADLINE.
//
// ⚠ HONEST SCOPE. The producer's probe is deadline-bound, so it cannot hang the
// poll. But getLndChainBalance() at treasury-alerts.ts:121 — the reserve call
// itself, which runs BEFORE the catch site — still carries NO deadline. Both
// directions are pinned below: what the deadline protects, and what it does not.
// The unbounded :121 call is pre-existing and out of scope for this arc.
// ═══════════════════════════════════════════════════════════════════════════

describe("the producer's deadline protects the probe", () => {
  it("a wedged offchain probe settles into an alert instead of hanging", async () => {
    // Reserve call fails fast (credential refused) so the catch site is reached;
    // then offchain:read is wedged. Without the wrapper the probe's Promise.all
    // would never resolve and the 60s poll would hang here.
    s.chainBalanceThrows = PERMISSION_FAULT;
    s.channelsHang = true;

    const call = getTreasuryAlerts().then((a) => types(a));
    const race = new Promise<"hung">((r) => globalThis.setTimeout(() => r("hung"), 8000));
    const outcome = await Promise.race([call, race]);

    expect(outcome).not.toBe("hung");
    expect(outcome).toContain("LND_FAULT");
    expect(outcome).toContain("ONCHAIN_RESERVE_CHECK_SKIPPED");
  }, 20_000);

  it("the wedged scope is reported as connectivity with ETIMEDOUT in detail", async () => {
    s.chainBalanceThrows = PERMISSION_FAULT;
    s.channelsHang = true;
    const fault = (await getTreasuryAlerts()).find((a) => a.type === "LND_FAULT")!;
    const offchain = fault.data.scopes.find((x: any) => x.scope === "offchain:read");

    expect(offchain.kind).toBe("connectivity");
    expect(offchain.detail).toContain("ETIMEDOUT");
    // Both kinds survive alongside each other.
    expect(fault.data.kinds).toEqual(["connectivity", "permission"]);
    expect(fault.severity).toBe("critical"); // permission outranks connectivity
  }, 20_000);

  it("the producer itself imposes no deadline on the reserve call", async () => {
    // ─── THIS CASE USED TO READ "RESIDUAL HAZARD, PINNED NOT FIXED" ──────────
    //
    // It was written when getLndChainBalance() had no deadline anywhere, so a
    // wedged-but-connected LND hung here forever and never reached the catch
    // site. That is no longer true: lnd.ts now bounds getLndChainBalance at
    // LND_FAST_CALL_TIMEOUT_MS (3s), so in production the wedge becomes a
    // rejection and the case below ("a timed-out reserve call…") shows what the
    // producer then does with it.
    //
    // ⚠ THE ASSERTION IS UNCHANGED AND STILL TRUE, WHICH IS EXACTLY WHY THE
    // COMMENT HAD TO CHANGE. This file mocks ../lightning/lnd wholesale, so the
    // real wrapper — and its deadline — is not in play here at all; and even in
    // production 3s is longer than this 600ms race. A test that keeps passing
    // while its explanation goes stale is worse than one that fails.
    //
    // What it still legitimately pins: getTreasuryAlerts() has no deadline of
    // its OWN. The bound lives one layer down, in the lnd.ts wrapper, and is
    // proven in lightning/lnd.deadlines.test.ts against a mocked ln-service.
    // (The old comment's ":121" / ":162" line references were stale too — the
    // calls are at treasury-alerts.ts:124 and :220.)
    s.chainBalanceHangs = true;

    const call = getTreasuryAlerts().then(() => "settled" as const);
    const race = new Promise<"hung">((r) => globalThis.setTimeout(() => r("hung"), 600));
    expect(await Promise.race([call, race])).toBe("hung");
  }, 20_000);

  it("a timed-out reserve call becomes a critical alert, not a hang", async () => {
    // The done-when for this endpoint, at the producer level: once lnd.ts turns
    // a wedge into an ETIMEDOUT rejection, the reserve check's catch site is
    // reached and the guardrail's failure is REPORTED rather than silent.
    //
    // The error shape is the one lnd.ts's withDeadline actually constructs, so
    // this exercises the same string CONNECTIVITY_RE keys on rather than an
    // invented stand-in.
    s.chainBalanceThrows = new Error(
      "ETIMEDOUT: getLndChainBalance exceeded 3000ms deadline",
    );

    const alerts = await getTreasuryAlerts();
    const types_ = types(alerts);

    expect(types_).toContain("ONCHAIN_RESERVE_CHECK_SKIPPED");
    const skipped = alerts.find((a) => a.type === "ONCHAIN_RESERVE_CHECK_SKIPPED")!;
    expect(skipped.severity).toBe("critical");

    // And the fault itself is classified rather than discarded.
    const fault = alerts.find((a) => a.type === "LND_FAULT")!;
    expect(fault.data.kinds).toContain("connectivity");
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORT-ONLY: pre-existing alerts unaffected, shape unchanged.
// ═══════════════════════════════════════════════════════════════════════════

describe("report-only: existing behaviour is unaffected", () => {
  it("still emits DAILY_LOSS_CAP_EXCEEDED independently of LND state", async () => {
    s.dailyLossSats = 2_000_000;
    expect(types(await getTreasuryAlerts())).toContain("DAILY_LOSS_CAP_EXCEEDED");
  });

  it("still emits ROTATION_CANDIDATES_PRESENT independently of LND state", async () => {
    s.rotationCandidates = [{ rotation_score: 200, channel_id: "1x1x1", reason: "idle" }];
    expect(types(await getTreasuryAlerts())).toContain("ROTATION_CANDIDATES_PRESENT");
  });

  it("a breached reserve on healthy LND still reports the breach alone", async () => {
    s.chainBalance = RESERVE_FLOOR - 1;
    expect(types(await getTreasuryAlerts())).toEqual(["ONCHAIN_RESERVE_BREACHED"]);
  });

  it("pre-existing alerts coexist with the new ones on a fault", async () => {
    s.chainBalanceThrows = PERMISSION_FAULT;
    s.dailyLossSats = 2_000_000;
    expect(types(await getTreasuryAlerts())).toEqual([
      "DAILY_LOSS_CAP_EXCEEDED", "LND_FAULT", "ONCHAIN_RESERVE_CHECK_SKIPPED",
    ]);
  });

  it("every alert still conforms to the TreasuryAlert shape", async () => {
    s.chainBalanceThrows = PERMISSION_FAULT;
    for (const a of await getTreasuryAlerts()) {
      expect(Object.keys(a).sort()).toEqual(["at", "data", "message", "severity", "type"]);
      expect(["info", "warning", "critical"]).toContain(a.severity);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHANNEL_DATA_STALE — WIRING, not classification.
//
// channelDataStaleness.test.ts proves the classifier is correct. This proves it
// is ATTACHED: that getTreasuryAlerts() actually calls it, that its two db reads
// are the ones the classifier expects, and that its alert reaches the returned
// array. A correct classifier nothing calls is the failure unit tests cannot
// see — the same reason action-confirmation.route.test.ts exists beside
// action-confirmation.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

describe("channel data staleness reaches the alerts surface", () => {
  const find = (alerts: any[]) => alerts.find((a) => a.type === "CHANNEL_DATA_STALE");

  it("(ii) PERMITS: fresh channel data produces NO staleness alert", async () => {
    // The default fixture is a healthy synced treasury. If this ever fires, the
    // alert is noise on every dashboard poll and will be tuned out.
    expect(find(await getTreasuryAlerts())).toBeUndefined();
  });

  it("(i) FIRES: stale channel rows produce the alert", async () => {
    // ⚠ THE FIXTURE IS DELIBERATELY OFF THE THRESHOLD, AND THE ASSERTION IS A
    // WINDOW RATHER THAN A FLOOR. This is a WIRING test — see the header above:
    // it proves the classifier is ATTACHED and that an age reaches the payload.
    // The exact number is incidental to that claim, and pinning it here was
    // actively wrong, because THIS surface reads the clock TWICE:
    //
    //   treasury-alerts.ts   `const now = Date.now()` is captured FIRST
    //   the fixture below    stamps `Date.now() - channelAgeMs` LATER, at the
    //                        moment readChannelDataAges() issues its SELECT
    //
    // so the observed elapsed is `channelAgeMs − (t_read − t_now)`, and
    // base/staleness.ts floors to whole seconds. With the old fixture sitting
    // exactly on 600_000ms, a gap of ONE MILLISECOND truncated the age to 599
    // and failed an assertion demanding >= 600. Measured: it passed only when
    // the two reads landed in the same millisecond, which is why it failed
    // roughly 1 run in 15 under parallel load and never in isolation.
    //
    // THE THRESHOLD ITSELF IS NOT LOSING COVERAGE BY MOVING OFF IT. It is
    // pinned three times over, at every level below this one, all with an
    // INJECTED clock and therefore no two-read problem:
    //   base/staleness.test.ts        isStaleByThreshold / classifyStaleness,
    //                                 just-below and exactly-at, both thresholds
    //   memberStatsFreshness.test.ts  channelDataFreshness "crosses into stale
    //                                 exactly at base/staleness.ts's threshold,
    //                                 not before", plus the 30-minute crossing
    //   channelDataStaleness.test.ts  the classifier: "does not fire one tick
    //                                 before the threshold" / "fires exactly AT
    //                                 the threshold"
    // An exact-threshold assertion belongs where the clock is supplied. It does
    // not belong here, where two independent Date.now() calls decide it.
    //
    // 12 minutes sits clear of BOTH thresholds — 7 minutes above stale, 18 below
    // very_stale — so `severity === "warning"` still discriminates with a wide
    // margin instead of resting on a boundary.
    //
    // The window is what keeps this a real assertion rather than one loosened
    // until green. `<= 720` is a HARD ceiling: the gap can only ever subtract,
    // so an age above the fixture value is impossible and would mean the age is
    // not derived from these rows at all. `>= 700` absorbs 20 SECONDS of
    // scheduling jitter — far beyond anything real — while still rejecting 0
    // (age not plumbed through), 2700 (the 45-minute fixture leaking from the
    // case below), 300 (wrong threshold), and 720000 (milliseconds reported as
    // seconds). It is a strictly tighter claim than the `>= 600` it replaces,
    // which would have accepted every one of those but the first.
    s.channelAgeMs = 12 * 60 * 1000;
    const a = find(await getTreasuryAlerts());
    expect(a, "no CHANNEL_DATA_STALE alert on 12-minute-old rows").toBeDefined();
    expect(a.severity).toBe("warning");
    expect(a.data.channel_data_age_seconds).toBeGreaterThanOrEqual(700);
    expect(a.data.channel_data_age_seconds).toBeLessThanOrEqual(720);
    expect(a.data.blocks_expansion).toBe(false);
  });

  it("(i) FIRES: empty table with no node info reports never_synced", async () => {
    s.channelRowCount = 0;
    s.nodeInfoAgeMs = null;
    const a = find(await getTreasuryAlerts());
    expect(a).toBeDefined();
    expect(a.data.node_info_staleness).toBe("never_synced");
    expect(a.data.indistinguishable_cases).toEqual([
      "never_synced",
      "genuinely_zero_channels",
    ]);
  });

  it("(ii) PERMITS: empty table with FRESH node info stays quiet", async () => {
    // A genuinely channel-less treasury that is syncing fine. The discriminator
    // that makes this distinguishable from never_synced is the whole reason the
    // classifier reads lnd_node_info at all.
    s.channelRowCount = 0;
    s.nodeInfoAgeMs = 5_000;
    expect(find(await getTreasuryAlerts())).toBeUndefined();
  });

  it("does not disturb the other alerts on the surface", async () => {
    // Report-only means additive. A breached reserve must still be reported
    // alongside, with its own type, when both conditions hold at once.
    s.chainBalance = 1;
    s.channelAgeMs = 45 * 60 * 1000;
    const alerts = await getTreasuryAlerts();
    expect(find(alerts)?.severity).toBe("critical");
    expect(alerts.some((a) => a.type === "ONCHAIN_RESERVE_BREACHED")).toBe(true);
  });
});
