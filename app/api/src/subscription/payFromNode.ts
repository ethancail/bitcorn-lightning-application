// Subscription pay-from-node — the backend behind the "I have BTC →
// Pay from this node" modal path.
//
// Source of truth:
//   - bitcorn-research/decisions/2026-06-11-subscription-panel-action-
//     button-behaviors.md (§ "Backend endpoint design")
//   - bitcorn-research/deltas/2026-06-11-subscription-pay-from-node-
//     implementation-deltas.md
//
// Safety property (the whole reason this isn't a general send-coins
// endpoint): the route takes NO request body. Amount and destination
// are derived SERVER-SIDE — the amount from the treasury's
// authoritative `price_sats`, the destination from the member's own
// treasury-allocated `deposit_address`. The worst a caller can do is
// pay their own subscription twice; the detector credits the overpay
// pro-rata. Never add a request parameter that lets the caller choose
// the address or amount.
//
// The preview's two halves live on different nodes (per the deltas
// record): the amount/destination are treasury-truth (fetched via the
// JWT-proxy below), and the fee estimate is member-local LND truth
// (getLndChainFeeRate) that the treasury cannot compute. That split is
// why the quote endpoint is member-local rather than folded into the
// treasury-proxied status payload.
//
// Note: tokenRefresh (and through it ../db, which opens SQLite at
// import time) is imported lazily inside deriveLocalMemberStatus so the
// pure helpers above it can be unit-tested without a database — the
// other API test files follow the same db-free-at-load discipline.

// ─── Error contract ──────────────────────────────────────────────────────

export type PayFromNodeError =
  | "insufficient_funds"
  | "fee_estimate_failed"
  | "lnd_unavailable"
  | "send_failed"
  | "status_unavailable"
  | "payment_in_flight";

/** App-level error code → HTTP status. 409 for the in-flight guard
 *  (decision § Idempotency); 503 for not-ready infrastructure
 *  (treasury proxy / LND down); 400 for a precondition the caller
 *  can't satisfy right now (insufficient on-chain balance); 502 for an
 *  upstream LND operation that failed mid-flight. */
export function errorHttpStatus(code: PayFromNodeError): number {
  switch (code) {
    case "payment_in_flight":
      return 409;
    case "status_unavailable":
    case "lnd_unavailable":
      return 503;
    case "insufficient_funds":
      return 400;
    case "fee_estimate_failed":
    case "send_failed":
      return 502;
  }
}

// ─── Amount / destination derivation (pure) ────────────────────────────────

export interface PaymentTarget {
  deposit_address: string;
  price_sats: number;
}

/** Pure: extract the payment target from a treasury subscription-status
 *  response body. Returns null when the body isn't an applicable status
 *  with a usable address + price — the caller maps null to
 *  `status_unavailable` and refuses (without a trustworthy
 *  destination/amount the endpoint must not send). */
export function parseStatusForPayment(body: unknown): PaymentTarget | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.applicable !== true) return null;
  const deposit_address = b.deposit_address;
  const price_sats = b.price_sats;
  if (typeof deposit_address !== "string" || deposit_address.length === 0) {
    return null;
  }
  if (typeof price_sats !== "number" || !Number.isFinite(price_sats) || price_sats <= 0) {
    return null;
  }
  return { deposit_address, price_sats };
}

// ─── Fee estimation (pure) ──────────────────────────────────────────────────

// Conservative vsize for one on-chain spend. A 1-input / 2-output
// native-segwit (P2WPKH) transaction is ~141 vBytes; 150 rounds up so
// the preview never under-quotes. This is a PREVIEW estimate only — the
// actual fee is whatever LND attaches at broadcast for the 6-block
// target. Precision doesn't matter here: subscription grace tiers sit
// at +7 / +30 / +60 days from paid_through (independent thresholds, not
// additive), so the longest runway is day-scale and next-block fees are
// waste. Revisit a fast-fee option only if Stage 6 close_due production
// data shows aborts missed due to slow confirmation.
export const ESTIMATED_TX_VBYTES = 150;

/** Pure: rate (sats/vByte) → estimated total fee (sats), rounded up. */
export function estimateFeeSats(tokensPerVbyte: number): number {
  if (!Number.isFinite(tokensPerVbyte) || tokensPerVbyte <= 0) return 0;
  return Math.ceil(tokensPerVbyte * ESTIMATED_TX_VBYTES);
}

// ─── LND error classification (pure) ────────────────────────────────────────

/** Extract a human-readable detail string from an ln-service error.
 *  ln-service throws array-shaped errors like
 *  `[503, 'FailedToConnect', {err}]`; plain Errors and strings also
 *  occur. Never throws. */
export function lndErrorDetail(err: unknown): string {
  if (err == null) return "unknown error";
  if (Array.isArray(err)) {
    return err
      .map((part) =>
        typeof part === "string" || typeof part === "number"
          ? String(part)
          : part instanceof Error
            ? part.message
            : (() => {
                try {
                  return JSON.stringify(part);
                } catch {
                  return String(part);
                }
              })(),
      )
      .join(" ");
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Pure: classify a thrown LND error from the SEND phase into the
 *  app-level error contract. Insufficient balance and connection
 *  failures are recognized specifically; anything else is the generic
 *  `send_failed` (detail preserved so the UI can surface it rather than
 *  swallow it). */
export function classifySendError(err: unknown): {
  code: PayFromNodeError;
  detail: string;
} {
  const detail = lndErrorDetail(err);
  if (/insufficient|not\s*enough|InsufficientFunds|InsufficientBalance/i.test(detail)) {
    return { code: "insufficient_funds", detail };
  }
  if (
    /LND files not available|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UNAVAILABLE|FailedToConnect|No connection established|14 UNAVAILABLE|Failed to initialize LND/i.test(
      detail,
    )
  ) {
    return { code: "lnd_unavailable", detail };
  }
  return { code: "send_failed", detail };
}

// ─── In-flight guard ────────────────────────────────────────────────────────
//
// One in-flight subscription send per node (decision § Idempotency). The
// client's disabled confirm button is UX; THIS is the authoritative
// defense. In-process boolean — a double-send that slips through across
// an API restart is financially bounded (the detector credits overpay
// pro-rata), so no persistent dedupe ledger in v1.

let sendInFlight = false;

/** Try to take the single send lock. Returns false if a send is already
 *  in flight (caller maps to 409 payment_in_flight). */
export function acquireSendLock(): boolean {
  if (sendInFlight) return false;
  sendInFlight = true;
  return true;
}

export function releaseSendLock(): void {
  sendInFlight = false;
}

export function isSendInFlight(): boolean {
  return sendInFlight;
}

// ─── Status derivation (network) ────────────────────────────────────────────
//
// Replicates the member-side status proxy (index.ts /api/subscription/
// status member path): cached JWT → resolved treasury base → fetch the
// authoritative status → parse the payment target. Kept here so the
// endpoint derives amount/destination from the same source of truth the
// panel polls, rather than trusting anything client-supplied.

export type DeriveStatusResult =
  | { ok: true; target: PaymentTarget }
  | { ok: false; code: "status_unavailable"; detail: string };

export async function deriveLocalMemberStatus(): Promise<DeriveStatusResult> {
  const { getCachedToken, getResolvedTreasuryBaseUrl } = await import("./tokenRefresh");
  const cached = getCachedToken();
  if (!cached || !cached.jwt) {
    return {
      ok: false,
      code: "status_unavailable",
      detail: "no cached subscription token; tokenRefresh has not yet completed a successful tick",
    };
  }
  const treasuryBase = getResolvedTreasuryBaseUrl();
  if (!treasuryBase) {
    return {
      ok: false,
      code: "status_unavailable",
      detail: "no treasury base URL resolved; tokenRefresh has not yet completed a successful tick",
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
        code: "status_unavailable",
        detail: `treasury status ${res.status}`,
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      code: "status_unavailable",
      detail: err?.message ?? String(err),
    };
  }
  const target = parseStatusForPayment(body);
  if (!target) {
    return {
      ok: false,
      code: "status_unavailable",
      detail: "treasury status not applicable or missing deposit_address/price_sats",
    };
  }
  return { ok: true, target };
}
