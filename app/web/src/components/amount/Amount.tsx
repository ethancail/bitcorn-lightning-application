// The amount (member-first-run-ui slice 1, ruled 2026-11-13): dollars, with
// the sats ALWAYS directly under them, smaller. Nothing is hidden behind a tap.
// Copy and formats are amountDescriptor.ts (drive-mode's). Not adopted on any
// page yet; slices 2–4 do that.
//
//   rate fresh/stale → the figure line is dollars, the line under it sats.
//   rate "none", or no usd, or unread (null) → the figure line is sats, the
//     line under it the descriptor's one-line note.
//   rate undefined (loading) → sats alone; the note never shows while the
//     rate is loading (R31).
//   sats null → "—"; a negative → "—", with a development warning (the
//     caller's words carry direction, R30(2)).
//
// Sizes: "hero" is 35px over 17.5px at text 1.0 (2.5rem over 1.25rem);
// "inline" takes its figure from the surrounding text, with the sats under it
// at --t-xs.

import type { ExchangeRate } from "../../api/client";
import { NO_RATE_NOTE, UNKNOWN_AMOUNT, formatSats, formatUsd } from "./amountDescriptor";

export type AmountSize = "hero" | "inline";

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
  const usd = rate != null && rate.state !== "none" ? rate.usd : null;

  if (usd == null) {
    return (
      <span className={cls} data-sats={sats}>
        <span className="amount-figure" data-line="sats">{satsText}</span>
        {rate !== undefined && <span className="amount-note" data-line="note">{NO_RATE_NOTE}</span>}
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
