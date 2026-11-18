// The Withdraw page's words (member-first-run-ui slice 3, the simplified
// Withdraw; Ethan's "recs", relayed 2026-11-17, R1–R8). Member text says
// "connection" and "BitCorn", never "channel" or "hub".
//
// Three tiers (the ruled design, 2026-11-13 §2):
//   always visible — the title and lead, "You can withdraw up to" (or, below
//     the minimum, "Nothing to withdraw yet"), what is in the connection, "How
//     much", "Goes to", and the one button with its line;
//   only when it applies — the advisor's warning word (R1), "Waiting costs
//     less" (R3; one plain line, ruled 2026-11-18), the errors, and the
//     address failure;
//   one tap away, as closed rows — "Why not all of it?", "Withdraw the most
//     now", "Limits and address", "Recent withdrawals (N)".
//
// Carried as they are, NOT rewritten: the sentences drive-mode ruled (R25's
// two max-fee sentences, the connection-down and daily-limit sentences, the
// option cards' reason and over-limit sentences, which OptionCards.tsx still
// owns for Top Up), "Why not all of it?" and its rows, the Min/Max line and
// the errors. The quote panel, tracking and the confirm dialog keep their own
// words (R8; slice 5).

import { formatSats, formatUsd } from "../amount/amountDescriptor";

/** The presets (D1.9: only those the policy accepts now are offered). */
export const AMOUNT_PRESETS = [250_000, 500_000, 1_000_000, 2_000_000];

/** An amount inside a sentence: "$29.77 (49,619 sats)", or "49,619 sats" with
 *  no usable price. `about` prefixes an estimate. */
export function inlineAmount(sats: number, usd: number | null, about = false): string {
  const lead = about ? "about " : "";
  return usd != null ? `${lead}${formatUsd(sats, usd).text} (${formatSats(sats)})` : `${lead}${formatSats(sats)}`;
}

export const WITHDRAW_COPY = {
  title: "Withdraw",
  lead: "Move money out of your connection into your node's bitcoin wallet.",
  upTo: "You can withdraw up to",
  nothingYet: "Nothing to withdraw yet",
  checkingFees: "Checking today's fees…",
  inConnection: (amount: string) => `of ${amount} in your connection`,
  howMuch: "How much",
  satsUnit: "sats",
  note: (fromPct: number, toPct: number) => `Your connection goes from ${fromPct}% to ${toPct}% full.`,
  goesTo: "Goes to:",
  goesToWhere: "Your node's bitcoin wallet",
  review: "Review withdrawal",
  reviewing: "Getting the fee…",
  reviewLine: "You'll see the exact fee before anything moves.",

  // R3: the tip, whenever the server recommends waiting. Ruled 2026-11-18: one
  // plain line with the clock icon, no box; $X and N are the server's bigger
  // amount (the wait_bigger card's amount_sats).
  tip: (bigger: string) => `Waiting costs less: once you have ${bigger} to move, the fee is a smaller share.`,
  /** NOT RULED: the server sends no bigger amount (no price, so no floor). */
  tipNoAmount: "Waiting costs less: a later, bigger transfer costs a smaller share.",
  /** The wait card's line (R2), drive-mode's wording. Ruled 2026-11-18: in
   *  "Why not all of it?". */
  tipWorthMore: (floor: string) => `Worth more once room to receive has dropped to ${floor}.`,
  /** The wait card's amount (R2). NOT RULED: this slice's wording. Ruled
   *  2026-11-18: in "Why not all of it?". */
  tipLater: (amount: string) => `A later transfer could move ${amount}.`,

  // R7: below the minimum. The connection-down and daily-limit sentences are
  // today's, verbatim but for "BitCorn".
  trigger: (trigger: string, min: string) =>
    `You can withdraw once ${trigger} is in your connection. The least you can withdraw is ${min}.`,
  leastOnly: (min: string) => `The least you can withdraw is ${min}.`,
  connectionDown:
    "Your connection to BitCorn is down, so payments can't go through it right now. It usually reconnects within a few minutes; if it's still down in an hour, restart the Lightning app.",
  dailyLimit: "You've withdrawn as much as the daily limit allows. It frees up over the next 24 hours.",

  // The closed rows.
  rowWhyNot: "Why not all of it?",
  rowMostNow: "Withdraw the most now",
  rowLimits: "Limits and address",
  rowHistory: (n: number | null) => (n == null ? "Recent withdrawals" : `Recent withdrawals (${n})`),

  // "Withdraw the most now" (the "now" card's facts; OptionCards' labels).
  mostAmount: "Amount",
  mostFee: "Fee, at today's fees",
  mostRises: (room: string) => `Room to receive rises to ${room}.`,
  allowOnce: "Allow it this once",
  useTheMost: "Use the most",
  /** R25, verbatim (R4 moves them into this row). */
  maxFeeQuoted: "This allows for today's fees; if they rise before you confirm, the quote will say so.",
  maxFeeUnquoted: "The swap's fees come out of this, so the exact amount you can withdraw is set when you get a quote.",

  // "Limits and address".
  limits: (min: number, max: number) => `Minimum: ${min.toLocaleString()} sats. Maximum: ${max.toLocaleString()} sats.`,
  addressWhere: "Your withdrawn bitcoin will be sent to this on-chain address.",
  copy: "Copy",
  copied: "Copied",
  newAddress: "New",
  addressFailed: "Failed to generate address —",
  retry: "retry",

  // The errors, today's words.
  overAvailable: (sats: number) => `The most you can withdraw right now is ${sats.toLocaleString()} sats.`,
  underMinimum: (sats: number) => `Withdrawal must be at least ${sats.toLocaleString()} sats.`,

  // "Recent withdrawals".
  historyFailed: "Couldn't load your withdrawal history.",
  historyEmpty: "No withdrawals yet",
} as const;
