// Subscription pay-from-node — the backend behind the "I have BTC →
// Pay from this node" modal path.
//
// Source of truth:
//   - bitcorn-research/decisions/2026-06-11-subscription-panel-action-
//     button-behaviors.md (§ "Backend endpoint design")
//   - bitcorn-research/deltas/2026-06-11-subscription-pay-from-node-
//     implementation-deltas.md
//   - bitcorn-research/decisions/2026-11-05-pay-from-node-confirmation-by-
//     echo-settlement-guard-and-price-ceiling.md (D1–D3), and
//     decisions/2026-11-05-pay-from-node-d2-supersedes-v1-no-dedupe-ledger-
//     judgment.md; specs/2026-11-05-pay-from-node-spec.md
//
// Safety property (the whole reason this isn't a general send-coins
// endpoint): amount and destination are derived SERVER-SIDE — the amount
// from the treasury's authoritative `price_sats`, the destination from the
// member's own treasury-allocated `deposit_address`. Never add a request
// parameter that lets the caller choose the address or amount.
//
// What the manual route's body DOES carry (D1): an ECHO of the price and
// address the member was shown, which is compared against the server's own
// derivation and refused on a mismatch — never used as the destination or
// amount — plus the member's deliberate acknowledgements. Three guards sit
// on both paths (manual and auto-pay):
//   - the echo (manual only): what was shown is what is sent;
//   - the settlement marker (D2): written before broadcast, so a payment
//     not yet credited holds auto-pay and makes a manual repeat deliberate;
//   - the price ceiling (D3): never pay above the member's last
//     acknowledged price without a fresh acknowledgement.
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
  | "payment_in_flight"
  // The echo (D1, manual only): the price or address the member confirmed
  // is no longer what the server derives. Nothing is sent.
  | "pay_target_changed"
  // The settlement guard (D2): an earlier payment is not yet credited.
  // Manual without the acknowledgement:
  | "repeat_unacknowledged"
  // Auto, below the hold time (a silent deferral):
  | "settlement_pending"
  // Auto, at or past the hold time (raises AUTOPAY_SETTLEMENT_OVERDUE):
  | "settlement_overdue"
  // The price ceiling (D3): the price is above the last acknowledged one.
  // Manual (without price_acknowledged) and auto.
  | "price_above_acknowledged"
  // Auto only: no price has ever been acknowledged (a manual send fills it).
  | "price_unacknowledged";

/** App-level error code → HTTP status. 409 for a guard that refused and
 *  can be resolved by the member (in-flight lock, decision § Idempotency;
 *  the echo, the settlement marker and the price ceiling, 2026-11-05 D1–D3);
 *  503 for not-ready infrastructure (treasury proxy / LND down); 400 for a
 *  precondition the caller can't satisfy right now (insufficient on-chain
 *  balance); 502 for an upstream LND operation that failed mid-flight. */
export function errorHttpStatus(code: PayFromNodeError): number {
  switch (code) {
    case "payment_in_flight":
    case "pay_target_changed":
    case "repeat_unacknowledged":
    case "settlement_pending":
    case "settlement_overdue":
    case "price_above_acknowledged":
    case "price_unacknowledged":
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

/** Pure: the status fields the settlement marker's clearing rule reads
 *  (spec §6 Q1(a)). Both exist in Case A today (statusHandler.ts); a missing
 *  or wrongly typed field reads as null, which clears nothing. */
export function parseCreditState(body: unknown): {
  paid_through: number | null;
  last_payment_txid: string | null;
} {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const pt = b.paid_through;
  const tx = b.last_payment_txid;
  return {
    paid_through: typeof pt === "number" && Number.isFinite(pt) ? pt : null,
    last_payment_txid: typeof tx === "string" && tx.length > 0 ? tx : null,
  };
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
// client's disabled confirm button is UX; this lock serializes concurrent
// sends. It is in-process, so it says nothing across an API restart or
// about a payment already broadcast and not yet credited. The v1 judgment
// that no persistent dedupe ledger was needed is SUPERSEDED by
// decisions/2026-11-05-pay-from-node-d2-supersedes-v1-no-dedupe-ledger-
// judgment.md: the durable settlement marker (sendMarker.ts) is the other
// half of the double-send defense, and this lock is kept beside it.

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
  | {
      ok: true;
      target: PaymentTarget;
      credit: { paid_through: number | null; last_payment_txid: string | null };
    }
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
  return { ok: true, target, credit: parseCreditState(result.status) };
}

// ─── Shared execution entry point ────────────────────────────────────────────
//
// The single orchestration shared by the HTTP route (POST /api/subscription/
// pay-from-node) and the auto-pay scheduler (§4). Both must hit the SAME
// module-level in-flight lock, the same settlement marker and the same price
// ceiling, derive amount/destination server-side, and classify errors
// identically — so the orchestration lives here, not inlined in the route
// handler. lnd.ts, the db and the stores are imported lazily so the pure
// helpers above stay db/lnd-free at load (the test files import this module).

export interface ExecutePayFromNodeSuccess {
  ok: true;
  txid: string;
  /** Echoed back for alert context / logging. */
  price_sats: number;
  estimated_fee_sats: number;
}
/** The active marker a settlement refusal names (spec §3.3): what the modal's
 *  repeat step and the stale-marker alert tell the member. */
export interface MarkerSummary {
  id: number;
  created_at: number; // epoch seconds
  amount_sats: number;
  txid: string | null;
}

export interface ExecutePayFromNodeFailure {
  ok: false;
  code: PayFromNodeError;
  detail: string;
  /** Best-effort context for the auto-pay alert (NULL-tolerant downstream). */
  price_sats?: number;
  balance_sats?: number;
  estimated_fee_sats?: number;
  /** The ceiling a price refusal was measured against (null = none set). */
  acknowledged_price_sats?: number | null;
  /** The marker a settlement refusal names. */
  marker?: MarkerSummary;
}
export type ExecutePayFromNodeResult =
  | ExecutePayFromNodeSuccess
  | ExecutePayFromNodeFailure;

/**
 * Who is sending, tagged by origin and REQUIRED, so no caller can drop the
 * echo by omission (spec §2.3).
 *  - manual: the route. `expected` is the echo of what the member was shown;
 *    the two flags are the member's deliberate acknowledgements, each read
 *    only when literally `true` in the confirmed body.
 *  - auto: the scheduler. No echo and no acknowledgement: auto-pay never pays
 *    twice and never pays above the acknowledged price (R3, D3).
 */
export type ExecutePayFromNodeArgs =
  | {
      origin: "manual";
      memberPubkey: string;
      expected: { amount_sats: number; deposit_address: string };
      repeatAcknowledged: boolean;
      priceAcknowledged: boolean;
    }
  | { origin: "auto"; memberPubkey: string };

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function summarize(m: {
  id: number;
  created_at: number;
  amount_sats: number;
  txid: string | null;
}): MarkerSummary {
  return { id: m.id, created_at: m.created_at, amount_sats: m.amount_sats, txid: m.txid };
}

/**
 * Acquire the in-flight lock and run the guards, in this order (ruled
 * 2026-11-05: the derive comes first so the marker can be cleared on credit
 * before it is checked, and the manual echo comes before the marker check):
 *
 *   manual: derive → clear-on-credit → echo → marker check → price ceiling
 *   auto:   derive → clear-on-credit →        marker check → price ceiling
 *   then:   fee estimate → balance pre-check → WRITE THE MARKER (and, where
 *           ruled, the acknowledged price) in one committed transaction →
 *           broadcast → txid.
 *
 * Every refusal before the write leaves nothing behind: no marker, no price.
 * Once the marker is written, only a credit clears it. An error from the
 * send call itself is ambiguous (the broadcast may have happened), so it
 * keeps the marker — decided by WHERE the error arises, never by its text
 * (an "insufficient funds" from the send call keeps it too) — and a price
 * recorded with that marker stays recorded with it.
 *
 * Never throws — every failure is a structured `ok: false` with a
 * PayFromNodeError code. Callers map the code to HTTP (route) or an alert
 * type (scheduler). Always releases the lock.
 */
export async function executePayFromNode(
  args: ExecutePayFromNodeArgs,
): Promise<ExecutePayFromNodeResult> {
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

    // Lazy: db-free at load (see the note at the top of this file).
    const { db } = await import("../db");
    const { ENV } = await import("../config/env");
    const { getMemberProfile, acknowledgePrice } = await import("../profile/profileStore");
    const { clearMarkersOnCredit, listActiveMarkers, writeMarker, setMarkerTxid } =
      await import("./sendMarker");
    const { memberPubkey } = args;

    // Clear on credit first, from the same status this send derives from.
    clearMarkersOnCredit(db, memberPubkey, status.credit, nowSec());

    // The echo (D1, manual only): what the member was shown is what is sent.
    // Compared against the SAME target this call sends with, under the lock,
    // and BEFORE the marker check (ruled 2026-11-05), so a member never
    // acknowledges a repeat of a payment whose details have since changed.
    if (args.origin === "manual") {
      const moved: string[] = [];
      if (args.expected.amount_sats !== price_sats) moved.push("amount_sats");
      if (args.expected.deposit_address !== deposit_address) moved.push("deposit_address");
      if (moved.length > 0) {
        return {
          ok: false,
          code: "pay_target_changed",
          detail: `changed since it was shown: ${moved.join(", ")}`,
        };
      }
    }

    // The settlement guard (D2).
    const active = listActiveMarkers(db, memberPubkey);
    if (active.length > 0) {
      if (args.origin === "auto") {
        const oldest = active[0]!;
        const ageMs = (nowSec() - oldest.created_at) * 1000;
        const overdue = ageMs >= ENV.autoPaySettlementAlertMs;
        return {
          ok: false,
          code: overdue ? "settlement_overdue" : "settlement_pending",
          detail: `an earlier payment of ${oldest.amount_sats} sats (marker ${oldest.id}) is not yet credited`,
          price_sats,
          marker: summarize(oldest),
        };
      }
      if (!args.repeatAcknowledged) {
        const newest = active[active.length - 1]!;
        return {
          ok: false,
          code: "repeat_unacknowledged",
          detail: `an earlier payment of ${newest.amount_sats} sats is not yet credited; sending again pays twice`,
          price_sats,
          marker: summarize(newest),
        };
      }
    }

    // The price ceiling (D3). Record the price with the marker only when it
    // fills a NULL (a confirmed manual send, §6 Q2) or raises the ceiling on
    // the member's deliberate price_acknowledged; at or below the ceiling the
    // flag is ignored, so it can never lower it.
    const profile = getMemberProfile(memberPubkey);
    const acknowledged = profile?.last_acknowledged_price ?? null;
    let recordPrice = false;
    if (acknowledged == null) {
      if (args.origin === "auto") {
        return {
          ok: false,
          code: "price_unacknowledged",
          detail: "no subscription price has been acknowledged on this node",
          price_sats,
          acknowledged_price_sats: null,
        };
      }
      recordPrice = true;
    } else if (price_sats > acknowledged) {
      if (args.origin === "manual" && args.priceAcknowledged) {
        recordPrice = true;
      } else {
        return {
          ok: false,
          code: "price_above_acknowledged",
          detail: `price ${price_sats} sats is above the last acknowledged ${acknowledged} sats`,
          price_sats,
          acknowledged_price_sats: acknowledged,
        };
      }
    }

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

    // Write the marker (and the acknowledged price, where ruled) and COMMIT
    // before the send is called. A crash between here and the broadcast
    // leaves an active marker with no txid: the guard over-holds, the safe
    // direction, until the status shows a credit.
    const markerId = db.transaction(() => {
      const id = writeMarker(db, {
        member_pubkey: memberPubkey,
        origin: args.origin,
        amount_sats: price_sats,
        deposit_address,
        paid_through_at_write: status.credit.paid_through,
        last_payment_txid_at_write: status.credit.last_payment_txid,
        created_at: nowSec(),
      });
      if (recordPrice) acknowledgePrice(memberPubkey, price_sats, nowSec());
      return id;
    })();

    // Broadcast. Even with the pre-check, the send may still report
    // insufficient_funds under a race; that classifies to the same code.
    // Any error from HERE keeps the marker active (see the doc comment).
    let txid: string;
    try {
      txid = (await sendLndToChainAddress(deposit_address, price_sats, 6)).id;
    } catch (err) {
      const { code, detail } = classifySendError(err);
      return { ok: false, code, detail, price_sats, estimated_fee_sats: estimatedFeeSats };
    }
    try {
      setMarkerTxid(db, markerId, txid);
    } catch (err) {
      // The payment is already broadcast; report the success. The marker
      // stays active without a txid and clears on paid_through instead.
      console.error("[subscription] pay-from-node: could not record txid on marker:", err);
    }
    return { ok: true, txid, price_sats, estimated_fee_sats: estimatedFeeSats };
  } finally {
    releaseSendLock();
  }
}
