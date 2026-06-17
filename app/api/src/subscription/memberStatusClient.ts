// Member-local subscription-status client.
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §3 step 1.
//
// A member node learns its own tier only by fetching its member-local
// /api/subscription/status (which proxies to the treasury). Before auto-pay,
// that fetch happened ONLY on a browser-driven poll. This module factors the
// cached-token forward path into a callable so the auto-pay scheduler can
// observe the member's tier with the browser closed — and, as a free side
// benefit, drives observeTierForTransition() for offline members so their JWT
// scope stays correct (a latent gap before auto-pay).
//
// Shares the no-db-at-load discipline of payFromNode.ts: tokenRefresh (and
// through it ../db) and transitionObserver are imported lazily inside the
// function. The `SubscriptionStatusResponse` import below is type-only, so it
// is erased and never loads statusHandler's db import.

import type { SubscriptionStatusResponse } from "./statusHandler";

export type LocalSubscriptionStatusResult =
  | { ok: true; status: SubscriptionStatusResponse }
  | { ok: false; code: "no_local_token" | "treasury_unreachable"; detail: string };

/**
 * Fetch the member's own subscription status from the treasury using the
 * cached entitlement JWT, return the parsed discriminated body, and fire
 * observeTierForTransition() on an applicable response (token-scope self-heal,
 * browser-independent). Never throws — network/parse failures map to a
 * structured `ok: false`. The caller (scheduler) treats `ok: false` as a
 * silent deferral (no alert; retry next tick).
 */
export async function fetchLocalSubscriptionStatus(): Promise<LocalSubscriptionStatusResult> {
  const { getCachedToken, getResolvedTreasuryBaseUrl } = await import("./tokenRefresh");
  const cached = getCachedToken();
  if (!cached || !cached.jwt) {
    return {
      ok: false,
      code: "no_local_token",
      detail:
        "no cached subscription token; tokenRefresh has not yet completed a successful tick",
    };
  }
  const treasuryBase = getResolvedTreasuryBaseUrl();
  if (!treasuryBase) {
    return {
      ok: false,
      code: "treasury_unreachable",
      detail:
        "no treasury base URL resolved; tokenRefresh has not yet completed a successful tick",
    };
  }

  let body: unknown;
  try {
    const res = await fetch(
      `${treasuryBase.replace(/\/+$/, "")}/api/subscription/status`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${cached.jwt}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        code: "treasury_unreachable",
        detail: `treasury status ${res.status}`,
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      code: "treasury_unreachable",
      detail: err?.message ?? String(err),
    };
  }

  const status = body as SubscriptionStatusResponse;

  // Free side benefit: keep the cached token's scope correct for offline
  // members. Fire-and-forget, never throws into the caller.
  if (status && typeof status === "object" && (status as any).applicable === true) {
    const tier = (status as any).current_tier;
    if (typeof tier === "string") {
      try {
        const { observeTierForTransition } = await import("./transitionObserver");
        observeTierForTransition(tier);
      } catch {
        // observation is best-effort; never block the status read.
      }
    }
  }

  return { ok: true, status };
}
