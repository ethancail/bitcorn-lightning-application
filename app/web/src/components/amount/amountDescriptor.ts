// DRIVE-MODE OWNS THIS FILE'S COPY AND FORMATS. member-first-run-ui created it
// beside the amount component (Amount.tsx), which it builds and styles; drive-
// mode edits it from here on (amount component spec §1 item 9:
// specs/2026-11-04-drive-mode-amount-component-behaviour.md, R29/R30/R31).
//
// The display is member-first-run-ui slice 1's, ruled 2026-11-13: dollars with
// the sats ALWAYS directly under them; nothing is behind a tap. That replaces
// the spec's §1 item 5 tap; its items 3, 4 and 6 are these formats and copy.

/** §1 item 6, verbatim: the line shown when there is no exchange rate, ONCE
 *  per page by NoRateNote.tsx, never per amount (ruled 2026-11-13). The same
 *  words as api/rate.ts's RATE_NONE_SENTENCE; Amount.test.tsx holds them equal. */
export const NO_RATE_NOTE = "The bitcoin price isn't available right now, so amounts are shown in sats.";

/** §1 item 8: an unknown amount (null), and a negative one (R30(2)). */
export const UNKNOWN_AMOUNT = "—";

/** §1 item 4: "49,619 sats", "1 sat", "0 sats"; no compact forms. */
export function formatSats(sats: number): string {
  return `${sats.toLocaleString("en-US")} ${sats === 1 ? "sat" : "sats"}`;
}

/** §1 item 3: sats × usd / 100,000,000, half-up to the cent (display only);
 *  "$38.13", "$1,234,567.89", "$0.00", and "< $0.01" for a non-zero amount
 *  under a cent. The text and its spoken form ("less than $0.01", R30(4)). */
export function formatUsd(sats: number, usdPerBtc: number): { text: string; spoken: string } {
  // toFixed(6) trims float noise so an exact half cent rounds up.
  const cents = Math.round(Number(((sats * usdPerBtc) / 1_000_000).toFixed(6)));
  if (cents === 0 && sats > 0) return { text: "< $0.01", spoken: "less than $0.01" };
  const text = `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { text, spoken: text };
}
