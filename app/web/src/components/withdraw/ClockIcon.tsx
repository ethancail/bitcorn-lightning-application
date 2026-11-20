// The clock on Withdraw's "Waiting costs less" line (ruled 2026-11-18: a plain
// line with the clock icon, no box, like the confirm dialog's "Can't be undone"
// line, 2026-11-13 §3). Decorative: the sentence says it all, so aria-hidden.
// Stroke icon in currentColor, the house style (CommodityPricesPanel.tsx).

export function ClockIcon() {
  return (
    <svg
      className="withdraw-tip-icon"
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
