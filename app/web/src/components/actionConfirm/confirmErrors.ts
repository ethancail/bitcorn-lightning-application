// Rendering the two confirmation refusals. Pure.
//
// Both arrive through apiFetch's shaped error, which carries `.status` and
// `.code` (the server's `error` field). See app/api/src/utils/action-confirmation.ts.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY 400 AND 409 MUST NOT SHARE COPY
//
// 400 confirmation_required — the request carried no confirmation, or the body
// was missing a field the route hashes. In this UI that means the form was
// incomplete: recoverable, and the operator's next move is to fill it in.
//
// 409 confirmation_mismatch — a confirmation arrived and did not match the
// parameters that arrived with it. Since the value is derived from the exact
// serialized body inside apiFetch, THIS CANNOT HAPPEN FROM NORMAL USE. If the
// operator sees it, the client and server disagree about what to hash — a
// version skew after a partial upgrade, or a field-map drift. It is a bug.
//
// So the 409 copy does NOT say "try again". Telling someone to retry a
// deterministic failure sends them round a loop that cannot terminate, and it
// frames a bug as a transient glitch, which is how a real defect goes
// unreported for weeks. It says what happened and that it will keep happening.
//
// ⚠ NO "ask your node operator" IN EITHER MESSAGE. On a member node the farmer
// IS the operator — member/open-channel, swaps/loop-out and swaps/loop-in are
// all member-facing. Same rule as stablecoin/secureContext.ts.
// ═══════════════════════════════════════════════════════════════════════════

export type ConfirmErrorKind = "required" | "mismatch" | "other";

export interface ConfirmErrorView {
  kind: ConfirmErrorKind;
  /** Short heading. */
  title: string;
  /** One or two sentences. No jargon the operator cannot act on. */
  detail: string;
  /** True when trying the same thing again could plausibly work. */
  retryable: boolean;
  /** True when this should be reported rather than worked around. */
  isBug: boolean;
}

interface ShapedError {
  status?: number;
  code?: string;
  detail?: string;
  message?: string;
}

/**
 * Classify an apiFetch error. Returns null when it is not a confirmation
 * failure, so callers keep their existing error handling for everything else.
 */
export function classifyConfirmError(err: unknown): ConfirmErrorView | null {
  const e = (err ?? {}) as ShapedError;

  // Match on BOTH status and code where available. Status alone is too coarse —
  // 400 is the generic bad-request code and every route uses it.
  const code = e.code;
  const status = e.status;

  if (code === "confirmation_required" || (status === 400 && code === "confirmation_required")) {
    return {
      kind: "required",
      title: "Not confirmed",
      detail:
        "This action needs a confirmation and none was sent. Check that every field is filled in, then confirm again.",
      retryable: true,
      isBug: false,
    };
  }

  if (code === "confirmation_mismatch" || (status === 409 && code === "confirmation_mismatch")) {
    return {
      kind: "mismatch",
      title: "This is a bug — nothing was sent",
      detail:
        "The confirmation did not match the details of the request, so the action was refused and no funds moved. " +
        "Repeating it will fail the same way. This node's dashboard and API disagree about this action — most " +
        "likely one of them updated and the other did not.",
      retryable: false,
      isBug: true,
    };
  }

  return null;
}

/**
 * The line under a mismatch, for someone who wants to do something about it.
 *
 * Names a version check, because a partial upgrade is by far the likeliest
 * cause and it is a thing the person reading this can actually verify. It does
 * not tell them to contact anyone.
 */
export const MISMATCH_NEXT_STEP =
  "If the dashboard was just updated, reload the page. If it keeps happening, the API and web versions differ — check them in Settings.";
