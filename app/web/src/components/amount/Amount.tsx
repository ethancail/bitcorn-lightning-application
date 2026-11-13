// The amount (member-first-run-ui slice 1, ruled 2026-11-13): dollars, with
// the sats ALWAYS directly under them, smaller. Nothing is hidden behind a tap.
// Copy and formats are amountDescriptor.ts (drive-mode's). Not adopted on any
// page yet; slices 2–4 do that.
//
//   rate fresh/stale → dollars, the sats directly under them.
//   rate "none", no usd, unread (null) or loading (undefined) → sats alone.
//     The "price isn't available" sentence is the page's, ONCE per page, not
//     per amount (ruled 2026-11-13): NoRateNote.tsx.
//   sats null → "—"; a negative → "—", with a development warning (the
//     caller's words carry direction, R30(2)).
//
// Sizes: "hero" is --t-3xl over --t-lg (31.5px over 17.5px at text 1.0);
// "inline" takes its figure from the surrounding text, with the sats under it
// at --t-xs.

import type { ExchangeRate } from "../../api/client";
import { UNKNOWN_AMOUNT, formatSats, formatUsd } from "./amountDescriptor";

export type AmountSize = "hero" | "inline";

/** The rate's usd when dollars can show; null when they can't (none, no usd,
 *  unread, or loading). Amount and NoRateNote both decide by this. */
export function usableUsd(rate: ExchangeRate | null | undefined): number | null {
  return rate != null && rate.state !== "none" ? rate.usd : null;
}

export function Amount({
  sats, rate, size = "inline",
}: {
  sats: number | null;
  rate: ExchangeRate | null | undefined;
  size?: AmountSize;
}) {
  const cls = `amount amount-${size}`;

  if (sats == null || sats < 0) {
    if (sats != null && import.meta.env.DEV) console.warn(`Amount: negative amount ${sats}; direction belongs in the caller's words`);
    return (
      <span className={cls}>
        <span className="amount-figure" data-line="unknown">{UNKNOWN_AMOUNT}</span>
      </span>
    );
  }

  const satsText = formatSats(sats);
  const usd = usableUsd(rate);

  if (usd == null) {
    return (
      <span className={cls} data-sats={sats}>
        <span className="amount-figure" data-line="sats">{satsText}</span>
      </span>
    );
  }

  return (
    <span className={cls} data-sats={sats}>
      <span className="amount-figure" data-line="usd">{formatUsd(sats, usd).text}</span>
      <span className="amount-sub" data-line="sats">{satsText}</span>
    </span>
  );
}
