// Whether the farmer's "Withdraw Earnings" CTA is live, and what to say when it
// is not. Derived, not inlined — same shape as ./certExpiryNotice.ts.
//
// Authority: decisions/2026-09-02-cashout-withdraw-cta-gate-and-sequencing.md
// (A/B/C decided, D deferred) and
// specs/2026-09-03-cashout-withdraw-cta-gate-spec.md. Both live in the
// bitcorn-research vault, not in this repo.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// The CTA was gated on balance alone (`local_sats >= 250_000`), so a farmer
// whose Loop daemon was down got invited to withdraw, walked to the page,
// filled the form, and only then met a failure. It is worse for a farmer below
// the 70% band: the advisor returns action "none" there, so no alert renders
// and there was no warning at all ahead of the click.
//
// The merchant CTA one block above (MemberDashboard.tsx:786) already had this
// right — it gates on the advisor's own signal rather than an invented balance
// threshold. This is the farmer half of that.
//
// ─── THE SIGNAL IS THE DAEMON FLAG, NOT THE RECOMMENDATION (decision B) ─────
//
// `loopDaemonRunning` only — never `recommendation.action === "loop_out"`.
// That alternative reads as the tidier mirror of the merchant block and is a
// behaviour regression: `action` is only "loop_out" above the 70% band, so
// gating on it would disable withdrawals for every healthy farmer who has
// earnings and every right to move them. Decision B rejected it; C2 in the
// test beside this file is the control that catches it coming back.
//
// The flag rides the advisor object already in component state
// (MemberDashboard.tsx:395, 60s poll), served whole by the API
// (liquidityAdvisorRoutes.ts:47) and typed web-side at client.ts:1139. No new
// fetch and no new endpoint.
//
// ─── DISABLED, NOT HIDDEN (decision C) ──────────────────────────────────────
//
// The caller keeps the button rendered and binds the native `disabled`
// attribute. Hiding it was rejected: App.tsx:429-441 makes that argument on
// the same page for /stablecoin — hide the entry, keep the door, explain
// inside — and the failure it names is that the member who most needs the
// explanation becomes the only one who never sees it.
//
// ─── FAIL OPEN WHILE THE SIGNAL IS UNKNOWN ──────────────────────────────────
//
// `advisor` is null until the first poll resolves, and that fetch swallows its
// own failures (MemberDashboard.tsx:395-398). Refusing on null would take
// every farmer's withdrawals offline for up to a poll interval on every page
// load — decision B's rejected regression arriving by a second route. So the
// predicate below turns on an EXPLICIT `false` and nothing else: null,
// undefined, and a missing sub-object all leave the CTA live. `!flag` would
// collapse "signal unknown" into "daemon down" and ship the refusal this
// paragraph rejects. Same direction as App.tsx's nav gating, which fails open
// while its own status is still null.
//
// Accepted cost, stated rather than buried: a farmer whose node is genuinely
// down sees a live CTA for up to one poll interval. C3 pins the behaviour so a
// fail-closed drift cannot ship green.
//
// ─── THE CAPTION IS COARSE ON PURPOSE ───────────────────────────────────────
//
// One sentence, no cause named. The API does classify why the daemon could not
// be reached (two reasons as of v1.18.10) but holds that value API-internal, so
// the web has only the boolean — and per-cause copy here would reopen a
// deferred decision rather than extend a settled one.
//
// The sentence is deliberately the one app/api already ships for its
// daemon-up-terms-unavailable arm (recommendationEngine.ts:416), not a new
// phrasing. Above the 70% band this caption paints alongside the advisor's own
// per-cause sentence (recommendationEngine.ts:141 / :151) and, on a certificate
// fault, the notice at MemberDashboard.tsx:489. Identical wording is what keeps
// a coarse claim beside a specific one reading as one app at two levels of
// detail rather than an app disagreeing with itself.
//
// ⚠ The ban list this file is held to — no cause asserted, no daemon
// internals, no transport-failure vocabulary — is enforced mechanically by the
// spec's DW5 grep over this WHOLE file, comments included. That is also why the
// phrasing v1.18.10 removed is described here and never reproduced: a comment
// quoting it would put the words back on the page for the next sweeper to read
// as live.

import type { MemberLiquidityStatusResponse } from "../api/client";

/**
 * The single sentence a farmer reads when the CTA is refused.
 *
 * Module-private on purpose. The test asserts this text as a LITERAL rather
 * than importing the constant — comparing a constant to itself would pass on
 * any wording, including none.
 */
const WITHDRAW_UNAVAILABLE = "Withdrawals are currently unavailable.";

export type WithdrawCtaGate = {
  /** Bind straight to the button's native `disabled` as `!enabled`. */
  enabled: boolean;
  /** Replaces the fee-estimate caption while refused; null while live. */
  explanation: string | null;
};

/**
 * Decide whether the farmer's withdraw CTA is live.
 *
 * Refuses on an EXPLICIT `loopDaemonRunning === false` and on nothing else —
 * see the fail-open paragraph in this file's header for why that is a
 * three-state read and not a truthiness check.
 */
export function withdrawCtaGate(
  advisor: MemberLiquidityStatusResponse | null,
): WithdrawCtaGate {
  if (advisor?.loopAvailability?.loopDaemonRunning === false) {
    return { enabled: false, explanation: WITHDRAW_UNAVAILABLE };
  }
  return { enabled: true, explanation: null };
}
