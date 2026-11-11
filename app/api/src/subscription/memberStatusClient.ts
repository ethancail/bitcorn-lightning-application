// Member-local subscription-status client — THE one verifying fetch.
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §3 step 1,
// and, since treasury-price-trust, bitcorn-research specs/2026-11-10-treasury-
// price-trust-spec.md §3.1: every member-side reader of the treasury's status
// goes through fetchVerifiedTreasuryStatus — this module's cached-token path
// (auto-pay scheduler, pay-from-node, the quote, auto-pay settings, the
// open-channel gate), the status proxy to the web (index.ts), and the host
// address-acknowledgement command.
//
// THE RULE: no actor reads an unverified body. It is carried by the type: the
// verified variant (`ok: true`) carries the parsed `status`; the unverified
// variants carry the verdict and the raw bytes, and no field named `status`.
// Only the proxy parses an unverified body, for display, labelled.
//
// Verification and nonce generation run ONLY here, in the member's API —
// never in the web bundle: member nodes serve their web over plain HTTP,
// where a browser's secure-context APIs are unavailable (§3.1, [AC5]).
//
// Shares the no-db-at-load discipline of payFromNode.ts: tokenRefresh, the db,
// LND and transitionObserver are imported lazily. The `SubscriptionStatusResponse`
// import below is type-only, so it is erased and never loads statusHandler.

import type { SubscriptionStatusResponse } from "./statusHandler";
import {
  STATUS_NONCE_HEADER,
  STATUS_SIGNATURE_HEADER,
  newStatusNonce,
  parseStatusBytes,
  verifyStatusBytes,
} from "./statusSignature";

export type UnverifiedVerdict = "unsigned" | "invalid" | "unverifiable";
export type TreasurySignatureLabel = "verified" | UnverifiedVerdict;

export type VerifiedStatusResult =
  | {
      ok: true;
      verdict: "verified";
      status: SubscriptionStatusResponse;
      httpStatus: number;
      bytes: Buffer;
    }
  | {
      ok: false;
      code: "status_unverified";
      verdict: UnverifiedVerdict;
      /** Set for `unverifiable` only. */
      verification_reason?: "key_unset" | "lnd_unavailable";
      detail: string;
      httpStatus: number;
      bytes: Buffer;
    }
  | {
      ok: false;
      code: "no_local_token" | "treasury_unreachable";
      detail: string;
      /** Present when the treasury answered (a non-2xx, or a verified body
       *  that is not JSON — `status_malformed`). */
      httpStatus?: number;
      bytes?: Buffer;
    };

/** Kept for the callers that named the old result type. */
export type LocalSubscriptionStatusResult = VerifiedStatusResult;

/** The test seam (spec §11.1): LND's verifier, the expected treasury key and
 *  the nonce are injectable. Production passes nothing. */
export interface VerifyingFetchDeps {
  verify?: (message: string, signature: string) => Promise<string>;
  treasuryKey?: string;
  nonce?: () => string;
}

async function defaultVerify(message: string, signature: string): Promise<string> {
  const { lndVerifyMessage } = await import("../lightning/lnd");
  return lndVerifyMessage(message, signature);
}

async function defaultTreasuryKey(): Promise<string> {
  const { ENV } = await import("../config/env");
  return ENV.treasuryPubkey;
}

/**
 * Fetch the treasury's status with a fresh nonce and decide its verdict
 * BEFORE parsing it (§3.1):
 *   1. nonce; GET with Bearer and X-Bitcorn-Status-Nonce, 5 s timeout
 *   2. the raw bytes (never res.json(), which parsed before the status check)
 *   3. non-2xx → treasury_unreachable, bytes kept for the proxy to forward
 *   4. the verdict (statusSignature.verifyStatusBytes)
 *   5. verified only: strict UTF-8 + JSON; a failure is status_malformed,
 *      treated as unreachable
 * Never throws.
 *
 * `pinFor`: when this is THIS node's own status, its pubkey — a verified,
 * applicable body then writes the first-sight address pin (§6.2), whichever
 * reader triggered the fetch. Omitted for another member's bearer.
 */
export async function fetchVerifiedTreasuryStatus(
  args: {
    bearer: string;
    treasuryBase: string;
    expectedMemberPubkey: string | null | undefined;
    pinFor?: string | null;
  },
  deps: VerifyingFetchDeps = {},
): Promise<VerifiedStatusResult> {
  const nonce = (deps.nonce ?? newStatusNonce)();
  let httpStatus: number;
  let bytes: Buffer;
  let signatureHeader: string | null;
  try {
    const res = await fetch(`${args.treasuryBase.replace(/\/+$/, "")}/api/subscription/status`, {
      method: "GET",
      headers: { Authorization: `Bearer ${args.bearer}`, [STATUS_NONCE_HEADER]: nonce },
      signal: AbortSignal.timeout(5000),
    });
    httpStatus = res.status;
    signatureHeader = res.headers.get(STATUS_SIGNATURE_HEADER);
    bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      return { ok: false, code: "treasury_unreachable", detail: `treasury status ${res.status}`, httpStatus, bytes };
    }
  } catch (err: any) {
    return { ok: false, code: "treasury_unreachable", detail: err?.message ?? String(err) };
  }

  const verdict = await verifyStatusBytes({
    bytes,
    signatureHeader,
    expectedTreasuryKey: deps.treasuryKey ?? (await defaultTreasuryKey()),
    expectedMemberPubkey: args.expectedMemberPubkey,
    nonce,
    verify: deps.verify ?? defaultVerify,
  });
  if (verdict.verdict !== "verified") {
    return {
      ok: false,
      code: "status_unverified",
      verdict: verdict.verdict,
      ...(verdict.verdict === "unverifiable" ? { verification_reason: verdict.reason } : {}),
      detail: verdict.verdict === "unsigned" ? "the treasury status is not signed" : verdict.detail,
      httpStatus,
      bytes,
    };
  }

  const parsed = parseStatusBytes(bytes);
  if (!parsed) {
    return { ok: false, code: "treasury_unreachable", detail: "status_malformed", httpStatus, bytes };
  }
  const status = parsed as unknown as SubscriptionStatusResponse;

  if (args.pinFor && status.applicable === true && typeof status.deposit_address === "string" && status.deposit_address.length > 0) {
    try {
      const { db } = await import("../db");
      const { ensurePin } = await import("./depositAddressPin");
      ensurePin(db, args.pinFor, status.deposit_address, Math.floor(Date.now() / 1000));
    } catch (err: any) {
      // Never block the read; the send path re-checks the pin itself (E1, E2).
      console.error("[subscription] deposit-address pin not written:", err?.message ?? String(err));
    }
  }
  return { ok: true, verdict: "verified", status, httpStatus, bytes };
}

/**
 * This node's own status, through the cached entitlement JWT. Verified against
 * this node's pubkey; fires observeTierForTransition() on a VERIFIED applicable
 * response only (token-scope self-heal, browser-independent). Never throws.
 * Callers treat `treasury_unreachable` / `no_local_token` as a silent
 * deferral, and `status_unverified` as "no response" for every actor (§4).
 */
export async function fetchLocalSubscriptionStatus(
  deps: VerifyingFetchDeps = {},
): Promise<VerifiedStatusResult> {
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
  const ownPubkey = await ownNodePubkey();
  const result = await fetchVerifiedTreasuryStatus(
    { bearer: cached.jwt, treasuryBase, expectedMemberPubkey: ownPubkey, pinFor: ownPubkey },
    deps,
  );

  if (result.ok && result.status.applicable === true) {
    const tier = (result.status as { current_tier?: unknown }).current_tier;
    if (typeof tier === "string") {
      try {
        const { observeTierForTransition } = await import("./transitionObserver");
        observeTierForTransition(tier);
      } catch {
        // observation is best-effort; never block the status read.
      }
    }
  }
  return result;
}

/** This node's pubkey, lowercased, as LND reported it (lnd_node_info) — the
 *  member the cached token was minted for (tokenRefresh stores the same
 *  lowercased LND key as the token's member_pubkey). Null until known. */
export async function ownNodePubkey(): Promise<string | null> {
  try {
    const { getNodeInfo } = await import("../api/read");
    const pk = getNodeInfo()?.pubkey;
    return typeof pk === "string" && pk.length > 0 ? pk.toLowerCase() : null;
  } catch {
    return null;
  }
}
