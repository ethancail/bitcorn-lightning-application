// Point-of-block 402 recognition + payload extraction (Direction D).
//
// Source of truth: specs/2026-06-11-subscription-discoverability-implementation.md §4
//
// The backend's Tier 2 gate (app/api/src/subscription/tier2Gate.ts)
// answers a routing-denied request with HTTP 402 and the structured
// body { error: "subscription_routing_denied", tier, paid_through,
// deposit_address, price_sats }. apiFetch attaches the full parsed body
// to the thrown Error as `.body` (plus `.status` and `.code`), so these
// helpers are pure functions over the thrown-error-shaped object — no
// Response access, A1-testable with plain fixtures.
//
// THE TRAP (must stay pinned by tests): /api/network/pay returns 402
// for *ordinary failed payments too* (`res.writeHead(result.ok ? 200 :
// 402, …)`), with a PaymentResult body whose `error` is an arbitrary
// LND failure string. So a status-only 402 check would show "pay your
// subscription" to a member whose payment merely failed to route. We
// require BOTH status === 402 AND code === "subscription_routing_denied".

export interface RoutingDeniedPayload {
  tier: string;
  paid_through: number | null;
  deposit_address: string | null;
  price_sats: number;
}

interface ErrorShape {
  status?: unknown;
  code?: unknown;
  body?: unknown;
}

function asErrorShape(err: unknown): ErrorShape | null {
  if (err == null || typeof err !== "object") return null;
  return err as ErrorShape;
}

/**
 * True only for the subscription routing-denial 402 — both the 402
 * status AND the discriminating error code. The status alone is not
 * sufficient (see THE TRAP above).
 */
export function is402SubscriptionDenied(err: unknown): boolean {
  const e = asErrorShape(err);
  if (!e) return false;
  return e.status === 402 && e.code === "subscription_routing_denied";
}

/**
 * Extracts the remediation payload from a recognized 402 error.
 * Returns null when recognition fails or the body is unusable.
 * Tolerates missing/malformed fields: deposit_address and paid_through
 * are nullable by type; a non-numeric price_sats falls back to 0 (the
 * fmtSats null-guard convention renders "— sats" rather than NaN).
 * Never throws.
 */
export function extract402Payload(err: unknown): RoutingDeniedPayload | null {
  if (!is402SubscriptionDenied(err)) return null;
  const e = asErrorShape(err);
  const body = e && typeof e.body === "object" && e.body !== null
    ? (e.body as Record<string, unknown>)
    : null;
  if (!body) return null;

  const tier = typeof body.tier === "string" ? body.tier : null;
  // Without a tier we can't pick a severity or copy — treat as unusable.
  if (!tier) return null;

  return {
    tier,
    paid_through: typeof body.paid_through === "number" ? body.paid_through : null,
    deposit_address: typeof body.deposit_address === "string" ? body.deposit_address : null,
    price_sats: typeof body.price_sats === "number" ? body.price_sats : 0,
  };
}
