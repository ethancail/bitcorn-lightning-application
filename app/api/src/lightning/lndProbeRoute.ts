// Route-side wiring for the LND fault classifier in ./lndHealth.
//
// WHY THIS FILE EXISTS SEPARATELY FROM index.ts. Two reasons, both structural:
//
//  1. TESTABILITY. Importing index.ts pulls in ./db, which opens SQLite at its
//     own module scope, so anything tested through index.ts needs a scratch
//     DB_DIR and loads better-sqlite3's native bindings (see
//     index.boot.test.ts). The logic worth testing — the timeout, the deps
//     wiring — has no reason to pay that, so it lives here and takes injected
//     deps. index.ts keeps only the dispatch guard and the node-role check.
//
//  2. THE FLIP OBLIGATION. The consuming branch's node-role check stays inline
//     in index.ts on purpose: the endpoint ships with NO caller authentication
//     by decision, and the recorded flip obligation is checked by grepping
//     index.ts for the route literal and reading what precedes the branch.
//     Moving the guard in here would hide it from that read.
//
// ─── THE TIMEOUT, AND WHY IT IS HERE RATHER THAN IN lndHealth.ts ────────────
//
// Neither the LND client nor runLndHealthProbe() has any deadline:
// authenticatedLndGrpc (lnd.ts:80-86) is constructed with no deadline and no
// keepalive, and runLndHealthProbe awaits a bare Promise.all (lndHealth.ts:378).
// So an LND that accepts the TCP connection but never answers — a wedged or
// paused process, as opposed to a refused port — produces no fault at all. It
// produces a hung await. On the 60s treasury-alerts poll that would hang every
// cycle, forever, which is worse than a wrong answer.
//
// The fix goes at the DEPS layer, not in the classifier. runLndHealthProbe
// takes its three calls as injected dependencies, so wrapping the deps bounds
// every probe without touching the classifier at all. That matters concretely:
// lndHealth.ts's own suite pins LndFaultKind to exactly six values
// (lndHealth.test.ts "never returns a kind outside the six-value union"), and a
// seventh kind would widen the union that test exists to hold.
//
// So a timed-out probe is reported as `connectivity`, via the classifier's
// EXISTING single funnel: withProbeTimeout rejects with a message beginning
// "ETIMEDOUT:", probeScope catches it like any other thrown value, and
// CONNECTIVITY_RE (lndHealth.ts:182-183) already lists ETIMEDOUT. No new kind,
// no new classification rule, no edit to lndHealth.ts.
//
// ⚠ THE COST OF THAT CHOICE, STATED RATHER THAN BURIED: a consumer switching
// only on `kind` cannot distinguish "LND is wedged" from "the port is refused"
// — both read `connectivity`. The distinction survives in `detail`, which is
// why the classifier preserves it (lndHealth.ts:206-208 — kind is coarse,
// code/detail are kept so the case stays diagnosable). Where the distinction
// changes what an operator would DO, the caller is expected to read `detail`
// rather than infer from `kind`.
//
// ⚠ A SECOND LIMIT, ALSO NOT SOLVED HERE: Promise.race bounds how long WE
// wait; it cannot cancel the underlying gRPC call, because ln-service exposes
// no abort handle. A raced-out call stays pending in the background until it
// settles on its own (TCP keepalive, server-side timeout). The timer itself is
// always cleared, so no handle leaks per call, but the abandoned call is not
// reclaimed until it resolves. Bounding that would require an abortable client
// and is out of scope for this arc.

import {
  runLndHealthProbe,
  type LndProbeDeps,
  type LndHealthReport,
} from "./lndHealth";

/**
 * Per-probe deadline. The three scope probes run concurrently inside
 * runLndHealthProbe (Promise.all), so this is roughly the worst-case wall
 * clock for the whole report, not a per-probe budget that sums.
 *
 * 3s against a local gRPC socket (LND_GRPC_HOST defaults to a host on the
 * Umbrel network) is ~1000x a healthy call, and well inside the 60s cadence of
 * the treasury-alerts dashboard poll that consumes this.
 */
export const LND_PROBE_TIMEOUT_MS = 3000;

/**
 * Bound one probe call with a deadline.
 *
 * The rejection message deliberately LEADS WITH "ETIMEDOUT:" so that
 * classifyLndError routes it to `connectivity` through CONNECTIVITY_RE. Do not
 * reword the token out of it: the classification depends on that string, and
 * lndProbeRoute.test.ts pins that dependency rather than assuming it.
 *
 * The timer is cleared on every settle path, so a bounded call leaves no
 * pending handle behind — load-bearing on the 60s poll, where a leaked timer
 * per probe per tick would accumulate.
 */
export function withProbeTimeout<T>(
  scope: string,
  call: () => Promise<T>,
  timeoutMs: number,
): () => Promise<T> {
  return () => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `ETIMEDOUT: ${scope} probe exceeded ${timeoutMs}ms deadline`,
          ),
        );
      }, timeoutMs);
    });

    return Promise.race([call(), deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
}

/**
 * Production deps for the probe, each bound by `timeoutMs`.
 *
 * THE IMPORT IS LAZY, AND IT IS A DYNAMIC import() RATHER THAN A require().
 * The goal is the one defaultLndProbeDeps() states (lndHealth.ts:392-396):
 * keep lnd.ts — and so ln-service's gRPC client — out of this module's import
 * graph, so a test importing withProbeTimeout drags in neither that nor
 * better-sqlite3. But the mechanism there does not survive a test runner:
 *
 *   ⚠ `require("./lnd")` resolves against the FILESYSTEM, looking for lnd.js.
 *     The source is lnd.ts, so under vitest (which serves transformed TS and
 *     never writes .js) Node's require throws "Cannot find module './lnd'". It
 *     works only against compiled dist/. defaultLndProbeDeps() has that exact
 *     shape and zero callers, so nothing ever exercised it — MEASURED here:
 *     the first route test to call this threw precisely that error.
 *
 * A dynamic import() is lazy in both worlds: nothing loads until this function
 * is called, tsc emits it as a deferred require for the CommonJS build, and
 * vite resolves it through its own resolver under test.
 *
 * Hence async: LndProbeDeps.isAvailable is synchronous by contract, so the
 * module has to be resolved before the deps object can be built rather than
 * inside each call.
 *
 * isAvailable is NOT timeout-wrapped: it is a synchronous fs.existsSync pair
 * (lnd.ts:51-59), so there is nothing to time out.
 */
export async function timeoutBoundProbeDeps(
  timeoutMs: number = LND_PROBE_TIMEOUT_MS,
): Promise<LndProbeDeps> {
  const lnd = await import("./lnd");
  return {
    isAvailable: () => lnd.isLndAvailable(),
    getWalletInfo: withProbeTimeout("info:read", () => lnd.getLndInfo(), timeoutMs),
    getChannels: withProbeTimeout("offchain:read", () => lnd.getLndChannels(), timeoutMs),
    getChainBalance: withProbeTimeout(
      "onchain:read",
      () => lnd.getLndChainBalance(),
      timeoutMs,
    ),
  };
}

/**
 * The single call index.ts makes. Returns the classifier's report UNCHANGED —
 * no translation layer, and deliberately no aggregate verdict under any name.
 * Never throws: runLndHealthProbe turns every outcome, including a timeout,
 * into a per-scope result.
 */
export async function runTimeoutBoundLndProbe(
  nowMs: number,
  timeoutMs: number = LND_PROBE_TIMEOUT_MS,
): Promise<LndHealthReport> {
  return runLndHealthProbe(await timeoutBoundProbeDeps(timeoutMs), nowMs);
}
