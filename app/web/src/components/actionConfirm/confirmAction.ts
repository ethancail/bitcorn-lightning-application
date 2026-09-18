// What a capital action looks like to the person about to take it, and what
// they have to type to proceed. Pure — no React, no fetch.
//
// Same shape as payModalMachine.ts / secureContext.ts / submitGuard.ts: the
// decision lives in a testable module and the component stays a renderer.
//
// ⚠ THIS IS NOT THE CONFIRMATION VALUE. The x-bitcorn-confirm header is derived
// from the serialized body inside apiFetch and nothing here touches it — see
// api/actionConfirmation.ts for why that has exactly one source. This module is
// only the human step: say what is about to happen, and make the operator type
// something that proves they read it.
//
// The two are deliberately independent. If this module were also the source of
// the hash, a copy change could alter a confirmation value, which is absurd but
// is exactly the coupling that "compute it in the form" produces.

export type Challenge =
  /**
   * Type the amount in sats.
   *
   * Used wherever the action has a SATS amount. ⚠ NOT universal any more: the
   * Auto-Buy catch-up has an amount and deliberately does not use this kind,
   * because its amount is USD with cents and this kind is integer-only
   * (`String(Math.round(c.sats))`, and `challengeSatisfied` accepts `^\d+$`).
   * See the `phrase` note below and CH-FMT in the spec.
   */
  | { kind: "amount"; sats: number }
  /**
   * Type a short word — or, since 2026-09-18, a short STRING that may be an
   * amount this kind can express and `amount` cannot.
   *
   * Originally used only where there is genuinely no amount — closing a
   * channel, approving a stored recommendation. The reasoning was: naming the
   * fallback rather than inventing a fake amount, because a number the operator
   * cannot check against anything is worse than a word, since it looks like
   * verification.
   *
   * ⚠ THAT REASONING STILL HOLDS AND IS WHY THE SECOND USE IS LEGITIMATE. The
   * Auto-Buy catch-up challenges on `"1100.00"` — a bare two-decimal USD figure
   * — while the modal shows `$1,100.00` one line above it. The hazard the
   * original note guarded against is a number with nothing to check it against;
   * here the number IS the amount, displayed adjacently, so it is checkable.
   * The catch-up uses this kind rather than `amount` because this branch trims
   * and lower-cases and strips NOTHING else, so cents survive — which is also
   * why its target must be typed character for character.
   * Spec: bitcorn-research/specs/2026-09-14-autobuy-scheduler-catchup-clamp-spec.md §5, CH-FMT/CH-DEC.
   */
  | { kind: "phrase"; text: string };

export interface ActionSummary {
  /** Imperative, specific. Becomes the modal heading. */
  title: string;
  /** Label → value rows. Amount and destination first where they exist. */
  rows: Array<{ label: string; value: string }>;
  /**
   * Free prose beneath the rows, or undefined.
   *
   * ⚠ ADDED 2026-09-18 for the Auto-Buy catch-up, whose confirm-modal body is
   * two to four sentences of copy Ethan accepted VERBATIM. The alternative was
   * splitting that prose across `rows` as label/value fragments, which was
   * rejected on the ground that the spec forbids shipping accepted copy in any
   * form but the accepted one — not on taste. `irreversible` was the only other
   * prose slot and means something narrower (see below), so overloading it
   * would have made its own doc comment false.
   *
   * Optional, so the seven summaries that predate it are unaffected.
   */
  body?: string;
  /** One line on what cannot be undone, or undefined when nothing applies. */
  irreversible?: string;
  challenge: Challenge;
  /** Text on the go-ahead button. */
  confirmLabel: string;
}

export const fmtSats = (n: number): string =>
  Number.isFinite(n) ? `${Math.round(n).toLocaleString("en-US")} sats` : "—";

/** Middle-truncate a long identifier so both ends stay checkable. */
export function truncId(s: string, keep = 8): string {
  if (!s) return "—";
  return s.length <= keep * 2 + 1 ? s : `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The typed challenge
// ─────────────────────────────────────────────────────────────────────────────

/** What the operator must type, as they must type it. */
export function challengeTarget(c: Challenge): string {
  return c.kind === "amount" ? String(Math.round(c.sats)) : c.text;
}

/**
 * Does what they typed match?
 *
 * Amounts: digit-compared after stripping separators and whitespace, so
 * "1,000,000", "1 000 000" and "1000000" all pass. The operator is being asked
 * to demonstrate they read the number, not to guess a format.
 *
 * ⚠ EMPTY NEVER MATCHES, on either side. `"" === ""` passing is the same bug
 * shape as sync.ts:15 and the server's confirmation comparison; it is guarded
 * here too because this is a second place the pattern could appear.
 */
export function challengeSatisfied(c: Challenge, typed: string): boolean {
  const target = challengeTarget(c);
  if (!target) return false;
  if (c.kind === "amount") {
    const norm = (s: string) => s.replace(/[\s,_']/g, "");
    const t = norm(typed);
    if (t === "") return false;
    if (!/^\d+$/.test(t)) return false;
    return t === norm(target);
  }
  const t = typed.trim();
  if (t === "") return false;
  // Case-insensitive: the word is a speed bump, not a password.
  return t.toLowerCase() === target.toLowerCase();
}

/** Prompt above the input. */
export function challengePrompt(c: Challenge): string {
  return c.kind === "amount"
    ? `Type the amount to confirm: ${Math.round(c.sats).toLocaleString("en-US")}`
    : `Type ${c.text} to confirm`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-action summaries.
//
// Copy rules, argued and worth keeping:
//   · No "ask your node operator" anywhere. On a member node the farmer IS the
//     operator, so that phrasing routes them back to themselves. Same rule as
//     stablecoin/secureContext.ts.
//   · Name what is irreversible, once, plainly. Channel opens and on-chain
//     sends cost fees that do not come back; Lightning payments cannot be
//     recalled.
//   · Amount and destination lead, because those are what a mis-click gets
//     wrong.
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeOpenMemberChannel(p: {
  capacitySats: number;
  partnerSocket?: string;
  hubLabel?: string;
}): ActionSummary {
  return {
    title: "Open a channel to the hub",
    rows: [
      { label: "Capacity", value: fmtSats(p.capacitySats) },
      { label: "Peer", value: p.hubLabel ?? "Bitcorn treasury hub" },
      ...(p.partnerSocket ? [{ label: "Address", value: p.partnerSocket }] : []),
    ],
    irreversible:
      "Funding a channel is an on-chain transaction. The mining fee is spent whether or not you close the channel later.",
    challenge: { kind: "amount", sats: p.capacitySats },
    confirmLabel: "Open channel",
  };
}

export function summarizeTreasuryOpenChannel(p: {
  peerPubkey: string;
  capacitySats: number;
  peerAlias?: string;
}): ActionSummary {
  return {
    title: "Open a treasury channel",
    rows: [
      { label: "Capacity", value: fmtSats(p.capacitySats) },
      { label: "Peer", value: p.peerAlias ? `${p.peerAlias} (${truncId(p.peerPubkey)})` : truncId(p.peerPubkey) },
    ],
    irreversible: "On-chain funding transaction. The mining fee is not recoverable.",
    challenge: { kind: "amount", sats: p.capacitySats },
    confirmLabel: "Open channel",
  };
}

export function summarizeCloseChannel(p: {
  channelId: string;
  isForceClose?: boolean;
  capacitySats?: number;
  peerAlias?: string;
}): ActionSummary {
  const force = p.isForceClose === true;
  return {
    title: force ? "Force-close this channel" : "Close this channel",
    rows: [
      { label: "Channel", value: truncId(p.channelId) },
      ...(p.peerAlias ? [{ label: "Peer", value: p.peerAlias }] : []),
      ...(p.capacitySats !== undefined ? [{ label: "Capacity", value: fmtSats(p.capacitySats) }] : []),
      { label: "Type", value: force ? "Force close" : "Cooperative close" },
    ],
    irreversible: force
      ? "A force close pays on-chain fees now and locks your balance behind a timelock — typically days before the funds are spendable."
      : "Closing settles the channel on-chain and pays a mining fee. Reopening later costs another one.",
    // No amount leaves the node here, so an amount challenge would be a number
    // with nothing to check it against. The word states which act is happening.
    challenge: { kind: "phrase", text: force ? "FORCE" : "CLOSE" },
    confirmLabel: force ? "Force close" : "Close channel",
  };
}

export function summarizePayInvoice(p: {
  amountSats: number;
  destination?: string;
  memo?: string;
}): ActionSummary {
  return {
    title: "Send this payment",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      ...(p.destination ? [{ label: "To", value: truncId(p.destination) }] : []),
      ...(p.memo ? [{ label: "Memo", value: p.memo }] : []),
    ],
    irreversible: "A Lightning payment cannot be recalled once it settles.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Send payment",
  };
}

export function summarizeLoopOut(p: {
  amountSats: number;
  destinationAddress: string;
  feeSats?: number;
}): ActionSummary {
  return {
    title: "Move funds on-chain",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      { label: "To address", value: truncId(p.destinationAddress, 10) },
      ...(p.feeSats !== undefined ? [{ label: "Estimated fee", value: fmtSats(p.feeSats) }] : []),
    ],
    irreversible:
      "The address above is where the coins land. A wrong address cannot be reversed by anyone.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Withdraw",
  };
}

export function summarizeLoopIn(p: { amountSats: number; feeSats?: number }): ActionSummary {
  return {
    title: "Refill this channel",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      ...(p.feeSats !== undefined ? [{ label: "Estimated fee", value: fmtSats(p.feeSats) }] : []),
    ],
    irreversible: "The swap fee is spent even if the swap does not complete.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Refill",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Buy catch-up (spec §4 A3; §5 M-full / M-partial / M-labels; CH-FMT/CH-DEC)
//
// ⚠ EVERY STRING BELOW IS ACCEPTED COPY, REPRODUCED CHARACTER-EXACT. Ethan
// accepted these words; the spec is explicit that the implementer does not ship
// copy it has not marked ACCEPTED, and by the same rule does not reword what it
// has. Edit only against a new acceptance.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The amount as the member TYPES it: a bare decimal, always two places.
 *
 * No `$`, no thousands separator (CH-FMT), and two decimals even when the
 * amount is whole (CH-DEC — `1100.00`, not `1100`). Both matter because the
 * `phrase` branch of `challengeSatisfied` strips nothing, so `1100`,
 * `1,100.00` and `$1100.00` are each a DIFFERENT challenge from `1100.00`.
 */
export const catchUpChallengeTarget = (usd: number): string => usd.toFixed(2);

/** The amount as the member READS it, one line above the input. */
export const fmtUsd = (usd: number): string =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function summarizeCatchUp(p: {
  /** Total unclaimed missed intervals. */
  intervals: number;
  /** The portion being bought now — equals `intervals` unless the caps bind. */
  fitsIntervals: number;
  /** USD for the portion being bought now. This is what is challenged. */
  fitsUsd: number;
  /** Intervals left claimable; 0 when nothing is withheld. */
  remainderIntervals: number;
}): ActionSummary {
  const partial = p.remainderIntervals > 0;
  // The remainder sentence is the toast's exact words (decision (3)): one fact
  // stated identically wherever it appears, rather than two that drift.
  const remainderSentence = `${p.remainderIntervals} missed ${plural(p.remainderIntervals, "buy", "buys")} remain and can be bought once the limit frees up.`;
  const persistence = "This is a one-time action; it does not change your schedule.";

  return {
    title: partial
      ? `Buy ${p.fitsIntervals} of ${p.intervals} missed intervals now?`
      : `Buy ${p.intervals} missed intervals?`,
    rows: [{ label: "Amount", value: fmtUsd(p.fitsUsd) }],
    body: partial
      ? `One market buy of about ${fmtUsd(p.fitsUsd)} on Coinbase, then the usual 72h hold and weekly sweep. ${remainderSentence} ${persistence}`
      : `One market buy of about ${fmtUsd(p.fitsUsd)} on Coinbase, then the usual 72h hold and weekly sweep. ${persistence}`,
    // A USD amount in the `phrase` kind — see that kind's note at the top.
    challenge: { kind: "phrase", text: catchUpChallengeTarget(p.fitsUsd) },
    confirmLabel: "Buy now",
  };
}

export function summarizeApproveLiquidity(p: {
  recommendationId: string;
  amountSats?: number;
  peerAlias?: string;
}): ActionSummary {
  return {
    title: "Approve this liquidity action",
    rows: [
      ...(p.amountSats !== undefined ? [{ label: "Amount", value: fmtSats(p.amountSats) }] : []),
      ...(p.peerAlias ? [{ label: "Peer", value: p.peerAlias }] : []),
      { label: "Recommendation", value: truncId(p.recommendationId) },
    ],
    irreversible: "Approving moves funds. The routing fee is spent on completion.",
    challenge:
      p.amountSats !== undefined
        ? { kind: "amount", sats: p.amountSats }
        : { kind: "phrase", text: "APPROVE" },
    confirmLabel: "Approve",
  };
}
