// The interim tap-for-sats amount (R59(6) [RELAYED — drive-mode arc chat,
// 2026-11-12]): "dollars first, sats on tap", per the amount component spec
// §1 items 3–8 (specs/2026-11-04-drive-mode-amount-component-behaviour.md;
// R29, R30, R31). member-first-run-ui builds the real component; until it
// ships, this one is used ON THE AUTOMATIC TRANSFERS PAGE ONLY. Other pages
// keep their own interim (dollars with sats beneath).
//
//   rate fresh/stale → a button, dollars first; a tap (click, Enter, Space —
//     a native button) shows sats, and again dollars. Its accessible name
//     carries both values. No aria-live. Per instance, not persisted.
//   rate "none", not yet read (undefined) or unread (null) → sats, not a
//     button. The page states the no-rate sentence once (rate.ts).
//   sats null → "—"; a negative → "—", with a development warning (the
//     caller's words carry direction, R30(2)).
// A toggled instance stays toggled as its value changes (R30(5)); once the
// rate goes to "none" the toggle is dropped, so a recovered rate shows
// dollars (R31).

import { useEffect, useState } from "react";
import type { ExchangeRate } from "../api/client";
import { formatSats, formatUsd } from "./amount/amountDescriptor";

// Items 3 and 4's formats live in the amount component's descriptor (one
// copy, drive-mode's); re-exported so this interim's callers are unchanged.
export { formatSats, formatUsd };

export function TapAmount({ sats, rate }: { sats: number | null; rate: ExchangeRate | null | undefined }) {
  const usd = rate != null && rate.state !== "none" && rate.usd != null ? rate.usd : null;
  const noRate = usd == null;
  const [showSats, setShowSats] = useState(false);
  // R31: no earlier toggle survives a spell without a rate.
  useEffect(() => { if (noRate) setShowSats(false); }, [noRate]);

  if (sats == null) return <span className="tap-amount-static">—</span>;
  if (sats < 0) {
    if (import.meta.env.DEV) console.warn(`TapAmount: negative amount ${sats}; direction belongs in the caller's words`);
    return <span className="tap-amount-static">—</span>;
  }
  const satsText = formatSats(sats);
  if (usd == null) return <span className="tap-amount-static" data-sats={sats}>{satsText}</span>;

  const dollars = formatUsd(sats, usd);
  return (
    <button
      type="button"
      className="tap-amount"
      data-sats={sats}
      aria-label={`${dollars.spoken}, ${satsText}`}
      onClick={() => setShowSats((s) => !s)}
    >
      {showSats ? satsText : dollars.text}
    </button>
  );
}
