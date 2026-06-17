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

/** Shared LND connection-failure signature (used by both the send-phase and
 *  fee-rate classifiers). */
const LND_UNAVAILABLE_RE =
  /LND files not available|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UNAVAILABLE|FailedToConnect|No connection established|14 UNAVAILABLE|Failed to initialize LND/i;

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
  if (LND_UNAVAILABLE_RE.test(detail)) {
    return { code: "lnd_unavailable", detail };
  }
  return { code: "send_failed", detail };
}

/** Pure: classify a thrown error from the FEE-RATE estimation phase. A
 *  connection failure is `lnd_unavailable`; any other failure (no estimate
 *  available, bad target, etc.) is `fee_estimate_failed`. This is what gives
 *  AUTOPAY_FEE_ESTIMATE_FAILED a distinct producer, separate from a node-down
 *  AUTOPAY_LND_UNAVAILABLE. */
export function classifyFeeRateError(err: unknown): {
  code: Extract<PayFromNodeError, "lnd_unavailable" | "fee_estimate_failed">;
  detail: string;
} {
  const detail = lndErrorDetail(err);
  if (LND_UNAVAILABLE_RE.test(detail)) {
    return { code: "lnd_unavailable", detail };
  }
  return { code: "fee_estimate_failed", detail };
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
  // Reuse the shared member-local status fetch (memberStatusClient) so the
  // pay path and the auto-pay scheduler derive amount/destination from one
  // source of truth. Lazy import keeps this file db-free at load.
  const { fetchLocalSubscriptionStatus } = await import("./memberStatusClient");
  const result = await fetchLocalSubscriptionStatus();
  if (!result.ok) {
    return { ok: false, code: "status_unavailable", detail: result.detail };
  }
  const target = parseStatusForPayment(result.status);
  if (!target) {
    return {
      ok: false,
      code: "status_unavailable",
      detail: "treasury status not applicable or missing deposit_address/price_sats",
    };
  }
  return { ok: true, target };
}

// ─── Shared execution entry point ────────────────────────────────────────────
//
// The single orchestration shared by the HTTP route (POST /api/subscription/
// pay-from-node) and the auto-pay scheduler (§4). Both must hit the SAME
// module-level in-flight lock, derive amount/destination server-side, and
// classify errors identically — so the orchestration lives here, not inlined
// in the route handler. lnd.ts is imported lazily so the pure helpers above
// stay db/lnd-free at load (the test files import this module).

export interface ExecutePayFromNodeSuccess {
  ok: true;
  txid: string;
  /** Echoed back for alert context / logging. */
  price_sats: number;
  estimated_fee_sats: number;
}
export interface ExecutePayFromNodeFailure {
  ok: false;
  code: PayFromNodeError;
  detail: string;
  /** Best-effort context for the auto-pay alert (NULL-tolerant downstream). */
  price_sats?: number;
  balance_sats?: number;
  estimated_fee_sats?: number;
}
export type ExecutePayFromNodeResult =
  | ExecutePayFromNodeSuccess
  | ExecutePayFromNodeFailure;

/**
 * Acquire the in-flight lock, derive the server-side amount/destination, run a
 * cheap confirmed-balance pre-check (price + estimated fee), broadcast the
 * on-chain renewal, classify any failure, and always release the lock. Never
 * throws — every failure is a structured `ok: false` with a PayFromNodeError
 * code. Callers map the code to HTTP (route) or an alert type (scheduler).
 */
export async function executePayFromNode(): Promise<ExecutePayFromNodeResult> {
  if (!acquireSendLock()) {
    return {
      ok: false,
      code: "payment_in_flight",
      detail: "a subscription send is already in flight on this node",
    };
  }
  try {
    const status = await deriveLocalMemberStatus();
    if (!status.ok) {
      return { ok: false, code: status.code, detail: status.detail };
    }
    const { deposit_address, price_sats } = status.target;

    const { getLndChainBalance, getLndChainFeeRate, sendLndToChainAddress } =
      await import("../lightning/lnd");

    // Fee estimate for the pre-check. getLndChainFeeRate throws on LND-down;
    // classifyFeeRateError separates that (lnd_unavailable) from a genuine
    // estimation failure (fee_estimate_failed).
    let estimatedFeeSats: number;
    try {
      const { tokens_per_vbyte } = await getLndChainFeeRate(6);
      estimatedFeeSats = estimateFeeSats(tokens_per_vbyte);
    } catch (err) {
      const { code, detail } = classifyFeeRateError(err);
      return { ok: false, code, detail, price_sats };
    }

    // Confirmed on-chain balance pre-check — the PLAIN member-wallet balance
    // (getLndChainBalance), NOT the deploy-ratio-netted treasury figure. Avoids
    // attempting (and re-attempting) a send that can't succeed.
    let balanceSats: number;
    try {
      ({ chain_balance: balanceSats } = await getLndChainBalance());
    } catch (err) {
      const { code, detail } = classifySendError(err);
      return { ok: false, code, detail, price_sats, estimated_fee_sats: estimatedFeeSats };
    }
    const required = price_sats + estimatedFeeSats;
    if (balanceSats < required) {
      return {
        ok: false,
        code: "insufficient_funds",
        detail: `confirmed balance ${balanceSats} sats < required ${required} sats (price ${price_sats} + est. fee ${estimatedFeeSats})`,
        price_sats,
        balance_sats: balanceSats,
        estimated_fee_sats: estimatedFeeSats,
      };
    }

    // Broadcast. Even with the pre-check, the send may still report
    // insufficient_funds under a race; that classifies to the same code.
    try {
      const result = await sendLndToChainAddress(deposit_address, price_sats, 6);
      return {
        ok: true,
        txid: result.id,
        price_sats,
        estimated_fee_sats: estimatedFeeSats,
      };
    } catch (err) {
      const { code, detail } = classifySendError(err);
      return { ok: false, code, detail, price_sats, estimated_fee_sats: estimatedFeeSats };
    }
  } finally {
    releaseSendLock();
  }
}
