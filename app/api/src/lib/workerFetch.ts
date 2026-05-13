// Single entry point for all API → Cloudflare Worker HTTP calls.
//
// Source of truth:
//   - bitcorn-research/specs/2026-05-11-subscription-stage-5a-jwt-fix-
//     and-member-ui.md §7
//   - bitcorn-research/decisions/2026-05-11-subscription-stage-5a-
//     architectural-deltas.md (three-category Worker auth model)
//
// Attaches the cached Bearer token (if any) to outgoing requests so
// the Worker can validate per the three-category auth model:
//
//   public         (no Bearer required)
//     /treasury-info, /recommended-peers
//   subscriber-base (any valid Bearer — payment or full)
//     POST /, /prices, /prices/corn-history
//   tier-gated      (scope=full required)
//     /valuation/{current,history,inputs,manual/*}
//
// The wrapper attaches the cached JWT unconditionally when one is
// available; the Worker enforces scope per-endpoint. Public endpoints
// accept a Bearer they don't need (no-op on their side); scoped
// endpoints reject if missing or under-scoped.
//
// On 401 with reason `bad_signature` or `expired`, triggers a token
// refresh and retries once with the fresh JWT. Other 401 reasons
// (bad_subject, bad_scope) don't retry — the token is structurally
// wrong, not stale. 403 (scope_insufficient) doesn't retry either —
// the member's tier doesn't have access; refreshing won't change that.
//
// Spec §7.3: "the only path Worker calls take is through this
// wrapper." Direct fetches to COINBASE_WORKER_URL elsewhere in the
// codebase should be migrated. The one intentional exception is
// tokenRefresh's bootstrap /treasury-info discovery: that call runs
// BEFORE there's a cached token to attach and would create a
// circular dependency if it routed through here.

import { ENV } from "../config/env";
import {
  getCachedTokenIfFresh,
  refreshLocalToken,
} from "../subscription/tokenRefresh";

export class WorkerFetchError extends Error {
  constructor(
    message: string,
    public readonly reason: "not_configured" | "transport_error",
  ) {
    super(message);
    this.name = "WorkerFetchError";
  }
}

/**
 * Performs an authenticated request against the Worker. Returns the
 * raw Response — callers handle status codes + parsing.
 *
 * Throws WorkerFetchError on:
 *   - not_configured: COINBASE_WORKER_URL env var unset
 *   - transport_error: network failure (Worker unreachable, etc.)
 *
 * Does NOT throw on HTTP-level failures (4xx, 5xx). Those come back
 * as a normal Response object that the caller inspects.
 */
export async function workerFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!ENV.coinbaseWorkerUrl) {
    throw new WorkerFetchError(
      "COINBASE_WORKER_URL is not configured on this node",
      "not_configured",
    );
  }
  const baseUrl = ENV.coinbaseWorkerUrl.replace(/\/+$/, "");
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const sendOnce = async (): Promise<Response> => {
    const cached = getCachedTokenIfFresh();
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> | undefined),
    };
    if (cached?.jwt && !headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = `Bearer ${cached.jwt}`;
    }
    try {
      return await fetch(url, { ...options, headers });
    } catch (err: any) {
      throw new WorkerFetchError(
        `Worker unreachable: ${err?.message ?? String(err)}`,
        "transport_error",
      );
    }
  };

  let response = await sendOnce();

  // Retry-once on signature-validation failures. Other 401 reasons
  // (bad_subject, bad_scope, missing) don't benefit from a refresh —
  // the token is structurally wrong, not stale.
  if (response.status === 401) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    const reason = body?.error ?? "";
    if (reason === "bad_signature" || reason === "expired") {
      console.log(
        `[workerFetch] 401 ${reason} on ${path}; refreshing token + retrying once`,
      );
      const refresh = await refreshLocalToken();
      if (refresh.ok) {
        response = await sendOnce();
      } else {
        console.warn(
          `[workerFetch] refresh on 401 ${reason} failed — reason=${refresh.reason}; returning original 401`,
        );
      }
    }
  }
  return response;
}
