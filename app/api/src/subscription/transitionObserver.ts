// Tier-transition-triggered token re-issuance.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §6.5
//   - bitcorn-research/decisions/2026-05-11-subscription-stage-5a-
//     architectural-deltas.md decision #4 (generalized to any scope
//     mismatch)
//
// When the member-side status proxy observes a tier change, this
// module checks whether the cached token's `scope` claim matches what
// the new tier should produce. On mismatch, fires an out-of-band token
// refresh so the next Worker call uses a token with the correct scope.
//
// Why server-side and not UI-side (spec §6.5 mandates the former):
//   - UI absence: tier transitions happen on treasury's tier-dispatch
//     cron regardless of UI state. UI-as-observer would miss
//     transitions while the user has the panel closed.
//   - LND requirement: the refresh signs a challenge with LND's
//     identity key — server-only operation.
//   - Dedup-across-sessions: a server-side in-flight guard naturally
//     dedupes when the operator has multiple tabs open. UI-side would
//     need cross-tab coordination.
//
// Cost: per status poll, one SQL read of subscription_local_token +
// one string compare. Mismatch case fires a single fire-and-forget
// refresh; repeated mismatches during the few-second refresh-in-flight
// window are deduped via the inFlightTransitionRefresh guard.

import { getCachedToken, refreshLocalToken } from "./tokenRefresh";
import { scopeForTier } from "./tokenIssuance";

// Module-level guard. Released in `finally` on both success AND error
// paths so a failed refresh doesn't permanently silence future
// transition handling.
let inFlightTransitionRefresh = false;

/**
 * Called from the member-side /api/subscription/status proxy on every
 * successful status fetch. If the cached token's scope doesn't match
 * the scope expected for the observed tier, fires a fire-and-forget
 * token refresh. Never blocks the caller; never throws.
 *
 * The observation only meaningfully fires on actual transitions — once
 * the refresh lands, the cached token's scope matches the tier and
 * subsequent polls no-op. Between firing and landing (~few seconds),
 * the in-flight guard prevents pile-on.
 */
export function observeTierForTransition(observedTier: string): void {
  const cached = getCachedToken();
  if (!cached) return;

  const expectedScope = scopeForTier(observedTier);
  if (cached.scope === expectedScope) return;

  if (inFlightTransitionRefresh) return;

  void runTransitionRefresh(observedTier, cached.scope, expectedScope).catch(
    (err) => {
      // Belt-and-suspenders: the wrapper itself has a try/finally for
      // the guard release. This .catch is the safety net for any
      // throw that escapes the wrapper (uncaught synchronous error
      // in scheduling, rejected promise before the try block, etc.).
      console.warn(
        `[subscription-token] transition-refresh wrapper threw — ` +
          `observedTier=${observedTier}, error=${err?.message ?? err}`,
      );
    },
  );
}

async function runTransitionRefresh(
  observedTier: string,
  cachedScope: string,
  expectedScope: string,
): Promise<void> {
  inFlightTransitionRefresh = true;
  try {
    console.log(
      `[subscription-token] tier-transition detected — observedTier=${observedTier}, ` +
        `cachedScope=${cachedScope}, expectedScope=${expectedScope}; ` +
        `triggering out-of-band refresh`,
    );
    const result = await refreshLocalToken();
    if (result.ok) {
      console.log(
        `[subscription-token] transition refresh ok — ` +
          `observedTier=${observedTier}, newScope=${result.scope}`,
      );
    } else {
      // refreshLocalToken returns a structured RefreshDenied rather
      // than throwing. Log the operational signal for observability.
      console.warn(
        `[subscription-token] transition refresh failed — ` +
          `observedTier=${observedTier}, reason=${result.reason}` +
          (result.status ? ` status=${result.status}` : "") +
          (result.error ? ` error=${result.error}` : ""),
      );
    }
  } finally {
    // Releases on success, on caught/returned failure, and on any
    // uncaught throw. Without this, a single failed refresh would
    // silently break all future transition handling.
    inFlightTransitionRefresh = false;
  }
}

/** Test-only: reset module-level state between unit tests. */
export function _resetTransitionObserverForTest(): void {
  inFlightTransitionRefresh = false;
}
