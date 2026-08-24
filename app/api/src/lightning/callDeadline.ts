// Deadlines for LND calls.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// The LND gRPC client is constructed with cert/macaroon/socket/TLS options only
// (lnd.ts, `authenticatedLndGrpc`) — no deadline, no keepalive. So an LND that
// accepts the TCP connection but never answers — a wedged or paused process, as
// opposed to a refused port — produces no error. It produces a hung await.
//
// That is the one fault class that yields NO THROW, and almost every protection
// this app has is a catch block: the 15s sync loop's `.catch`, the per-route
// 500 handlers, /api/member/stats' `lnd_live_read_ok`, the treasury alert
// producer's ONCHAIN_RESERVE_CHECK_SKIPPED. A wedge walks past all of it in
// silence. This wrapper is not a new safety net; it is the adapter that lets the
// nets already built catch this case.
//
// ─── SIBLING TO withProbeTimeout, DELIBERATELY NOT THE SAME FUNCTION ────────
//
// lndProbeRoute.ts:86 has `withProbeTimeout`, which does the same job for the
// health probe. It is left untouched on purpose — it is the base another live
// arc builds on, and it returns a THUNK because it feeds dependency injection.
// This one is used at ordinary call sites, so it returns the promise directly.
// Same mechanism, different shape, no shared edit.
//
// ─── WHAT THIS CANNOT DO ────────────────────────────────────────────────────
//
// ⚠ Promise.race bounds how long WE wait; it cannot cancel the underlying gRPC
// call, because ln-service exposes no abort handle. A raced-out call stays
// pending in the background until it settles on its own. The timer is always
// cleared, so no handle leaks per call, but the abandoned call is not reclaimed.
// Bounding that would require an abortable client.
//
// This is also exactly why six calls are HELD below rather than bounded.
//
// ⚠ COMPOSITION — A PER-CALL DEADLINE IS NOT A PER-OPERATION BOUND. Applying
// this to N sequential calls makes the operation FINITE, not bounded by one
// deadline: it bounds each call, so the operation is bounded by N × deadline.
// The 15s sync tick makes six guaranteed sequential calls plus one per page of
// forwarding history, so at 3s each it is finite but can still exceed its own
// 15s period. That is strictly better than today — the pile-up becomes
// ⌈tick/15s⌉ concurrent runs instead of unbounded accumulation — but it is NOT
// solved. A per-tick budget is deliberately deferred; lightning/syncTiming.ts
// exists to make that budget DERIVABLE from measurement instead of argued.

/**
 * Deadline for a read against the local LND gRPC socket.
 *
 * ⚠ THIS VALUE IS DELIBERATELY EQUAL TO LND_PROBE_TIMEOUT_MS AND IS NOT
 * IMPORTED FROM IT. Both bound the same class of call, so there is one number
 * for the class, and the derivation is the one recorded at lndProbeRoute.ts:63-72
 * — 3s against a local socket is ~1000x a healthy call and sits inside every
 * poll cadence in the app (15s sync, 15s member stats, 60s dashboard).
 *
 * The import is not taken because lnd.ts imports THIS module, so importing
 * lndProbeRoute.ts here would create
 *
 *     lnd.ts -> callDeadline.ts -> lndProbeRoute.ts ⇢ lnd.ts
 *
 * and lndProbeRoute.ts's dynamic import (:113-135) exists specifically to keep
 * lnd.ts out of its import graph so its tests need neither ln-service nor
 * better-sqlite3. Equality is enforced by a test instead — see
 * callDeadline.test.ts, "the fast deadline EQUALS LND_PROBE_TIMEOUT_MS".
 */
export const LND_FAST_CALL_TIMEOUT_MS = 3_000;

/**
 * Deadline for gossip, pathfinding and invoice decode.
 *
 * ⚠ THIS NUMBER IS ARGUED, NOT DERIVED, AND THAT IS A DIFFERENT STATUS FROM THE
 * ONE ABOVE. Nothing in this repository has ever measured LND call latency, so
 * there is no p99 behind it. The argument is only that pathfinding legitimately
 * traverses the gossip graph and is therefore slower than a local state read by
 * some margin, and that 10s stays inside the 15s sync period and the 60s poll.
 * That is a plausibility bound, not evidence.
 *
 * WHAT REPLACES IT: lightning/syncTiming.ts logs per-call and per-tick wall
 * clock on every sync tick. Once that has run on a real node for a few days,
 * this constant should be re-derived from the observed distribution and this
 * paragraph replaced with the measurement. Until then, treat it as a guess with
 * a known direction of error (too generous, not too tight).
 */
export const LND_GOSSIP_CALL_TIMEOUT_MS = 10_000;

/**
 * The calls that deliberately carry NO deadline.
 *
 * ⚠ THE PARTITION IS OUTCOME AMBIGUITY, NOT "IS IT A WRITE". A deadline does not
 * cancel the underlying call (see the header). For a call that commits funds,
 * giving up waiting therefore leaves the outcome UNKNOWN — the transaction may
 * have broadcast, the HTLC may have settled — and an unknown outcome on a money
 * movement is worse than a slow one. Retrying it is a double-spend; not retrying
 * it is a lost payment; and nothing local can tell which.
 *
 * Other writes are bounded, because they are not ambiguous in the same way:
 * createLndChainAddress, connectToPeer, updateNodeAlias and updateRoutingFees
 * either have no financial consequence or are self-evident on the next poll.
 *
 * Each held call also carries a comment at its own definition pointing back
 * here, so a reader meets the reason at the call site rather than having to
 * find this list. The exclusion is pinned by heldCalls.test.ts, which fails if
 * any of these acquires a deadline.
 *
 * ⚠ NOT A RUNTIME GUARD. Nothing consults this list at runtime; it is the
 * declared contract that the structural test enforces. Adding a name here does
 * not remove a deadline from anything.
 */
export const HELD_UNBOUNDED_CALLS: readonly string[] = Object.freeze([
  // lnd.ts wrappers
  "sendLndToChainAddress",
  "openTreasuryChannel",
  "closeTreasuryChannel",
  "payViaRoutes", // inside payLndViaRoutes
  "payViaPaymentDetails", // inside keysendPush
  // raw ln-service call site
  "payViaPaymentRequest", // pay.ts
]);

/**
 * Run `call` with a deadline. Resolves as the call resolves; rejects with the
 * call's own error if it fails; rejects with an `ETIMEDOUT:`-leading Error if
 * the deadline expires first.
 *
 * The rejection message LEADS WITH "ETIMEDOUT:" to match the token
 * classifyLndError routes to `connectivity` via CONNECTIVITY_RE
 * (lndHealth.ts:182-183). ⚠ Note that errors from THIS wrapper do not reach
 * that classifier today — only the probe's do. The prefix is consistency for
 * the day one of them does, and a readable log line meanwhile; it is not a live
 * contract, and nothing here should be taken as adding a fault kind.
 *
 * The timer is cleared on every settle path, including a synchronous throw from
 * `call` — which is why the call is started inside an async IIFE rather than
 * passed straight to Promise.race. Without that, a sync throw escapes before
 * `.finally` runs and leaks the timer.
 */
export function withDeadline<T>(
  label: string,
  call: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ETIMEDOUT: ${label} exceeded ${timeoutMs}ms deadline`));
    }, timeoutMs);
  });

  // Async IIFE: converts a synchronous throw from `call` into a rejection so it
  // cannot bypass the .finally below.
  const started = (async () => call())();

  return Promise.race([started, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
