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

import type { ExchangeRate } from "../../api/client";

export type Challenge =
  /**
   * Type the amount in sats.
   *
   * Typing binds an OPERATOR-CHOSEN amount on a capital action: the typed step
   * exists so a mis-click cannot proceed with an amount the operator picked.
   * Pay-from-node is exempt, because its amount is treasury-set, echoed in the
   * confirmed body and server-checked, never chosen by the caller
   * (decisions/2026-11-06-pay-from-node-typed-amount-invariant-binds-operator-
   * chosen-amounts.md; the exemption and its ground are recorded in
   * wiring.test.ts's CALL_SITES). This used to say "used wherever the action
   * has a SATS amount", which pay-from-node made untrue.
   *
   * ⚠ NOT universal among amount-bearing actions either: the
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
  /** Label → value rows. Amount and destination first where they exist.
   *  `ident` marks a value that is an identifier (an ID, a pubkey, an
   *  address): the modal sets it in the identifier monospace (UI redesign Z2). */
  rows: Array<{ label: string; value: string; ident?: true }>;
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
  /**
   * The member layout (member-first-run-ui slice 5), OPT-IN: set only by the
   * member's money dialogs. When it is set the modal shows this instead of
   * `rows`/`body`/`irreversible`, prompts with `memberChallengePrompt`, labels
   * the field "sats" and puts the main button on the RIGHT. Every summary
   * without it — Kevin's treasury dialogs, Payments, the Auto-Buy catch-up —
   * renders exactly as before (ruling (8): left as they are).
   */
  member?: MemberLayout;
}

/** A row under the member layout's "Details": an amount (shown by the amount
 *  rule) or a value in words; `ident` as in `ActionSummary.rows`. */
export type MemberDetailRow =
  | { label: string; sats: number }
  | { label: string; value: string; ident?: true };

/**
 * What a member's money dialog shows. Data, not markup: the modal formats the
 * amounts with slice 1's formatter (amountDescriptor), so dollars sit over
 * sats and every figure follows the amount rule.
 */
export interface MemberLayout {
  /** The amount, shown big: dollars over sats. */
  amountSats: number;
  /** The page's exchange rate; `<Amount>` decides from it whether dollars show. */
  rate: ExchangeRate | null | undefined;
  /** The one "What it costs" line, as "about $X (N sats)"; no line when unknown. */
  costSats?: number;
  /** Where the money goes, in words ("Goes to: …"). */
  goesTo?: string;
  /** Rows kept visible below the cost (the member open's Speed row). */
  rows?: Array<{ label: string; value: string; ident?: true }>;
  /** The last line: "Can't be undone" with its icon, or a plain sentence. */
  finalLine: { kind: "cant_undo" } | { kind: "plain"; text: string };
  /** What a closed "Details" holds: rows, then sentences. */
  details: { rows: MemberDetailRow[]; notes: string[] };
}

/** The member layout's fixed words (slice 5, rulings (2)–(4)). */
export const MEMBER_DIALOG_COPY = {
  cost: "What it costs:",
  goesTo: "Goes to:",
  cantUndo: "Can't be undone",
  details: "Details",
  satsUnit: "sats",
  mostInFees: "Most you allow in fees",
} as const;

/** The member layout's prompt (ruled): "To confirm, type the sats amount: N".
 *  Ends ": N" like challengePrompt, so what is shown is what passes. */
export function memberChallengePrompt(c: Challenge): string {
  return c.kind === "amount"
    ? `To confirm, type the sats amount: ${Math.round(c.sats).toLocaleString("en-US")}`
    : challengePrompt(c);
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

// fee-estimates CONFIRM-RULING (2026-11-17): each of the three channel
// summaries carries ONE row with the live rate it will send, for every
// option, Economy included. That rate is the request's fee_rate, which the
// confirmation hashes — a pin holds the row's rate equal to the hashed one.
// The words are member-first-run-ui's to review.

/** The fee option a channel summary shows: its label and the integer sat/vB it sends. */
export type SummaryFee = { label: string; rate: number };

// The member's open (Connect to BitCorn), through the member layout (slice 5,
// ruling (4), option C): the size as dollars over sats; "What it costs" = the
// live estimate's network fee; the Speed row KEPT, still the rate the request
// sends and the confirmation hashes (the CONFIRM-RULING pin); the address
// under Details. The "Fee updated" reshow is the hook's (useConnectToHub).
export function summarizeOpenMemberChannel(p: {
  capacitySats: number;
  partnerSocket?: string;
  fee: SummaryFee;
  /** The live estimate's network fee for the open, in sats (cost_sats.open). */
  feeSats?: number;
  rate: ExchangeRate | null | undefined;
}): ActionSummary {
  return {
    title: "Connect to BitCorn",
    rows: [],
    challenge: { kind: "amount", sats: p.capacitySats },
    confirmLabel: "Connect",
    member: {
      amountSats: p.capacitySats,
      rate: p.rate,
      costSats: p.feeSats,
      rows: [{ label: "Speed", value: `${p.fee.label} (about ${p.fee.rate} sat/vB)` }],
      finalLine: { kind: "plain", text: "The network fee is spent even if you close the connection later." },
      details: {
        rows: p.partnerSocket ? [{ label: "Address", value: p.partnerSocket, ident: true }] : [],
        notes: [],
      },
    },
  };
}

export function summarizeTreasuryOpenChannel(p: {
  peerPubkey: string;
  capacitySats: number;
  peerAlias?: string;
  fee: SummaryFee;
}): ActionSummary {
  return {
    title: "Open a treasury channel",
    rows: [
      { label: "Capacity", value: fmtSats(p.capacitySats) },
      { label: "Peer", value: p.peerAlias ? `${p.peerAlias} (${truncId(p.peerPubkey)})` : truncId(p.peerPubkey), ident: true },
      { label: "Fee rate", value: `${p.fee.label}, ~${p.fee.rate} sat/vB` },
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
  /** A cooperative close's proposed rate (R2). A force close sends none (F1). */
  fee?: SummaryFee;
}): ActionSummary {
  const force = p.isForceClose === true;
  return {
    title: force ? "Force-close this channel" : "Close this channel",
    rows: [
      { label: "Channel", value: truncId(p.channelId), ident: true },
      ...(p.peerAlias ? [{ label: "Peer", value: p.peerAlias }] : []),
      ...(p.capacitySats !== undefined ? [{ label: "Capacity", value: fmtSats(p.capacitySats) }] : []),
      { label: "Type", value: force ? "Force close" : "Cooperative close" },
      ...(!force && p.fee ? [{ label: "Fee rate proposed", value: `${p.fee.label}, ~${p.fee.rate} sat/vB` }] : []),
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
  /** The server's fee limit for this payment, rounded up (drive-mode P1
   *  item 4). Omitted or null → no row (the treasury's payments). */
  maxFeeSats?: number | null;
}): ActionSummary {
  return {
    title: "Send this payment",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      ...(p.maxFeeSats != null ? [{ label: "Most in fees", value: fmtSats(p.maxFeeSats) }] : []),
      ...(p.destination ? [{ label: "To", value: truncId(p.destination), ident: true as const }] : []),
      ...(p.memo ? [{ label: "Memo", value: p.memo }] : []),
    ],
    irreversible: "A Lightning payment cannot be recalled once it settles.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Send payment",
  };
}

// ─── Loop fee ceilings (loop-fee-ceilings spec §7, F4) ───────────────────────

/**
 * The most a swap authorises in fees before it starts ("Most you authorize in
 * fees"): the swap fee + the miner fee + the two routing ceilings (P12 p,
 * superseding ruling 11). The prepay (max_prepay_amt) is EXCLUDED: it is an
 * advance on the principal, counted toward the amount withdrawn, not a fee
 * (Polar gate 1's L3). Undefined when the quote carries no ceilings — never a
 * 0 presented as a maximum.
 *
 * Loop In (ruling tt, spec §1.10): pass `{ mode: "loop_in", minerFeeMarginPct }`
 * — RefillChannel is the only caller that does. The figure is swap fee +
 * ceil(miner × (100 + pct) / 100), in whole numbers: the miner fee may rise
 * by the server's pre-initiation margin (LOOP_MINER_FEE_MARGIN_PCT, sent as
 * the quote's miner_fee_margin_pct) and the swap still starts, so the most
 * shown must include it. Without that margin from the server, undefined: no
 * maximum is shown rather than a guessed one. Loop Out passes no mode and is
 * unchanged — its sweep follows the market after the start, which the
 * "capped at 20%" body discloses.
 */
const AUTHORIZED_FEE_CEILINGS = [
  "max_swap_fee_sat",
  "max_miner_fee_sat",
  "max_swap_routing_fee_sat",
  "max_prepay_routing_fee_sat",
] as const;

export function authorizedMaxSats(
  ceilings: Record<string, number | undefined> | null | undefined,
  loopIn?: { mode: "loop_in"; minerFeeMarginPct: number | undefined },
): number | undefined {
  if (!ceilings) return undefined;
  if (loopIn) {
    const swap = ceilings.max_swap_fee_sat;
    const miner = ceilings.max_miner_fee_sat;
    const pct = loopIn.minerFeeMarginPct;
    if (typeof swap !== "number" || typeof miner !== "number" || typeof pct !== "number") return undefined;
    return swap + Math.ceil((miner * (100 + pct)) / 100);
  }
  const values = AUTHORIZED_FEE_CEILINGS.map((k) => ceilings[k]).filter(
    (v): v is number => typeof v === "number",
  );
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * The Loop Out fee estimate: swap fee + miner fee. The one figure both the
 * Withdraw panel and its confirmation show (they used to disagree: the modal
 * added the prepay). Neither counts the prepay, which is part of the
 * withdrawal, not a fee (P12 p).
 */
export function loopOutEstimatedFeeSats(q: { swap_fee_sat?: number; miner_fee_sat?: number }): number {
  return (q.swap_fee_sat ?? 0) + (q.miner_fee_sat ?? 0);
}

// Withdraw and Top Up are member-only (/withdraw, /cashout, /refill), so both
// use the member layout (slice 5, rulings (2) and (3)). The address is not
// shown: it is the node's own (api.getNodeAddress), so "Goes to" says so in
// words, and the confirmation hash is of the request body, not of this copy.

/** Withdraw's 20% rule (loop-fee-ceilings §7, ruling 5), under Details. */
export const LOOP_OUT_MARKET_NOTE =
  "Once the withdrawal starts, the Bitcoin network fee follows the market, capped at 20% of the amount.";

export function summarizeLoopOut(p: {
  amountSats: number;
  /** The quote's estimate (loopOutEstimatedFeeSats): "What it costs". */
  feeSats?: number;
  authorizedMaxSats?: number;
  rate: ExchangeRate | null | undefined;
}): ActionSummary {
  return {
    title: "Withdraw to your node's wallet",
    rows: [],
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Withdraw",
    member: {
      amountSats: p.amountSats,
      rate: p.rate,
      costSats: p.feeSats,
      goesTo: "Your node's bitcoin wallet",
      finalLine: { kind: "cant_undo" },
      details: {
        rows: p.authorizedMaxSats !== undefined
          ? [{ label: MEMBER_DIALOG_COPY.mostInFees, sats: p.authorizedMaxSats }]
          : [],
        notes: [LOOP_OUT_MARKET_NOTE],
      },
    },
  };
}

export function summarizeLoopIn(p: {
  amountSats: number;
  /** The quote's total fee: "What it costs". */
  feeSats?: number;
  authorizedMaxSats?: number;
  rate: ExchangeRate | null | undefined;
}): ActionSummary {
  return {
    title: "Top up your connection",
    rows: [],
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Top up",
    member: {
      amountSats: p.amountSats,
      rate: p.rate,
      costSats: p.feeSats,
      // Ruling (3): a plain line instead of "Can't be undone".
      finalLine: { kind: "plain", text: "The fee is spent even if the top-up doesn't finish." },
      details: {
        rows: p.authorizedMaxSats !== undefined
          ? [{ label: MEMBER_DIALOG_COPY.mostInFees, sats: p.authorizedMaxSats }]
          : [],
        // No 20% clause: that clamp exists only on the Loop Out sweep (ruling 5).
        notes: ["Once the top-up starts, the Bitcoin network fee follows the market."],
      },
    },
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
  // stated identically wherever it appears, rather than two that drift. Both
  // the noun and the VERB inflect — "1 missed buy remain" was the accepted
  // text's own edge case and reads as a defect on the one screen where the
  // member is committing money.
  const remainderSentence = `${p.remainderIntervals} missed ${plural(p.remainderIntervals, "buy", "buys")} ${plural(p.remainderIntervals, "remains", "remain")} and can be bought once the limit frees up.`;
  const persistence = "This is a one-time action; it does not change your schedule.";

  return {
    title: partial
      // "1 of 3 missed intervals" keeps the plural: the noun belongs to the 3.
      ? `Buy ${p.fitsIntervals} of ${p.intervals} missed intervals now?`
      : `Buy ${p.intervals} missed ${plural(p.intervals, "interval", "intervals")}?`,
    rows: [{ label: "Amount", value: fmtUsd(p.fitsUsd) }],
    body: partial
      ? `One market buy of about ${fmtUsd(p.fitsUsd)} on Coinbase, then the usual 72h hold and weekly sweep. ${remainderSentence} ${persistence}`
      : `One market buy of about ${fmtUsd(p.fitsUsd)} on Coinbase, then the usual 72h hold and weekly sweep. ${persistence}`,
    // A USD amount in the `phrase` kind — see that kind's note at the top.
    challenge: { kind: "phrase", text: catchUpChallengeTarget(p.fitsUsd) },
    confirmLabel: "Buy now",
  };
}
