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

// "some_new_status" → "Some new status".
function humanize(status: string): string {
  const words = (status ?? "").replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
