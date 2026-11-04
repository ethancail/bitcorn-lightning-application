// Swap status → history badge, shared by Top Up (RefillChannel) and Cash Out
// (WithdrawBitcoin). Both read the same swap_requests history, and
// quote_created reaches both: swapService writes it on every quote, Loop In
// and Loop Out alike. A status this map doesn't know is humanized, never
// shown raw.
//
// Top Up's history threshold (styles.css, `topup-history`) was measured from
// the widest label this map can produce — a new label means re-measuring
// (docs/UI_CONVENTIONS.md).
export function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "quote_created":
      return { label: "Quoted", cls: "badge-muted" };
    // The API's claim on a quote while its pre-checks run (loop-fee-ceilings).
    // Shorter than "In Progress", so the measured width above still holds.
    case "initiating":
      return { label: "Starting…", cls: "badge-amber" };
    case "initiated":
      return { label: "Processing", cls: "badge-amber" };
    case "executing":
      return { label: "In Progress", cls: "badge-amber" };
    case "confirming":
      return { label: "Confirming", cls: "badge-blue" };
    case "completed":
      return { label: "Complete", cls: "badge-green" };
    case "failed":
      return { label: "Failed", cls: "badge-red" };
    case "expired":
      return { label: "Expired", cls: "badge-muted" };
    default:
      return { label: humanize(status), cls: "badge-muted" };
  }
}

/**
 * The member's badge for a swap (drive-mode P2, R33 finding 9): the shared
 * map's, except that a temporary Loop failure reads "Not finished", matching
 * its sentence (loopFailureCopy.ts). loopd sets FAILURE_REASON_TEMPORARY so the
 * swap is NOT abandoned, and a restart picks it up (loopout.go:398-405,
 * loopin.go:566-571); the poller still stores it as "failed" — display only.
 * A new label, so Top Up's history threshold was re-measured for it (R34):
 * styles.css X4c and phoneTables.css.test.ts hold the readings.
 */
export function memberSwapBadge(status: string, failureReason: string | null): { label: string; cls: string } {
  if (status === "failed" && failureReason === "FAILURE_REASON_TEMPORARY") {
    return { label: "Not finished", cls: "badge-amber" };
  }
  return statusBadge(status);
}

// "some_new_status" → "Some new status".
function humanize(status: string): string {
  const words = (status ?? "").replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
