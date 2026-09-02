/**
 * Loop availability detector — checks whether loopd is reachable
 * on the member node and fetches Loop Out/In terms if available.
 *
 * Never throws — always returns a result object.
 */

import {
  isLoopAvailable as checkLoopDaemon,
  getLoopOutTerms,
  type LoopUnavailableReason,
} from "../lightning/loop";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LoopTerms {
  minSats: number;
  maxSats: number;
}

export interface LoopAvailability {
  loopDaemonRunning: boolean;
  loopOutAvailable: boolean;
  loopInAvailable: boolean;
  loopOutTerms: LoopTerms | null;
  loopInTerms: LoopTerms | null;
  /**
   * Why the daemon is down, classified structurally at
   * `lightning/loop.ts`'s `isLoopAvailable()` and carried here rather than
   * re-derived. `null` whenever `loopDaemonRunning` is true — a daemon that is
   * up has no unavailability reason, which is what keeps the fourth copy case
   * below (daemon up, terms fetch failed) distinct from the two daemon-down
   * ones.
   *
   * ⚠ THIS REASON IS API-INTERNAL. Copy is rendered API-side, in
   * `recommendationEngine.ts`; nothing switches on the value and nothing may
   * start to without superseding
   * `decisions/2026-09-02-loop-unavailability-classification-taxonomy-and-copy.md`
   * D2 and adding a union type plus a test pin. `LOOP_NOT_INSTALLED` is the
   * cautionary case: emitted at `treasury-alerts.ts`, no consumer switches on
   * it, typed as a bare string, printed raw — and `docs/LOOP_SETUP.md`
   * nonetheless asserts renaming it would break an API contract. An identifier
   * with no consumer acquires a phantom contract in documentation.
   *
   * The statement lives here, on the type, and not only in the decisions
   * record, because a decisions record is not read by whoever next edits this
   * interface.
   *
   * Note the accident this is guarding against, which is real and already
   * live: `liquidityAdvisorRoutes.ts` ships this whole object to `app/web`, so
   * a field added here crosses the wire whether or not anyone intended it.
   * Crossing the wire is not the same as being a contract, and no `app/web`
   * code reads it.
   */
  unavailableReason: LoopUnavailableReason | null;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export async function checkLoopAvailability(): Promise<LoopAvailability> {
  const result: LoopAvailability = {
    loopDaemonRunning: false,
    loopOutAvailable: false,
    loopInAvailable: false,
    loopOutTerms: null,
    loopInTerms: null,
    unavailableReason: null,
  };

  // Step 1: Check if loopd is reachable
  const daemon = await checkLoopDaemon();
  if (!daemon.available) {
    // ⚠ THE CAUSE IS CARRIED, NOT DISCARDED. This early return used to be
    // `return result`, which threw away a fact loop.ts had classified
    // structurally one layer up — and that discard is the whole reason a
    // farmer whose cert had expired was told the Loop software was absent from
    // their node. (Described, not quoted: this arc removed those phrasings
    // from the copy, and a comment reproducing them verbatim would put the
    // words back on the page and read as live wording to the next grep.)
    //
    // The field is on the result, not merely computed: a reason added and then
    // dropped a line later would satisfy the description of this fix while
    // changing nothing a member reads.
    //
    // `?? "unreachable"` is a total fallback, not a guess about a case that
    // happens. loop.ts sets the reason at both of its `available: false`
    // returns, so the nullish arm is unreachable today; if a future branch
    // there forgets to classify, `unreachable` is the honest default because
    // D2 defines it as the catch-all ("everything else"), and it is the arm
    // that asserts no cause.
    result.unavailableReason = daemon.unavailableReason ?? "unreachable";
    return result;
  }

  result.loopDaemonRunning = true;

  // Step 2: Try to fetch Loop Out terms
  try {
    const terms = await getLoopOutTerms();
    if (terms.min_swap_amount > 0 && terms.max_swap_amount > 0) {
      result.loopOutAvailable = true;
      result.loopOutTerms = {
        minSats: terms.min_swap_amount,
        maxSats: terms.max_swap_amount,
      };
    }
  } catch {
    // Loop Out not available — leave as false
  }

  // Loop In availability — real gRPC check
  let loopInAvailable = false;
  let loopInTerms: { minSats: number; maxSats: number } | null = null;
  try {
    const { getLoopInTerms } = await import("../lightning/loop");
    const terms = await getLoopInTerms();
    loopInAvailable = true;
    loopInTerms = { minSats: terms.min_swap_amount, maxSats: terms.max_swap_amount };
  } catch {
    // Loop In not available
  }

  result.loopInAvailable = loopInAvailable;
  result.loopInTerms = loopInTerms;

  return result;
}
