// Subscription deposit-address labels (Path B / V8 fallback).
//
// Bitcoind direct RPC is unavailable in the deployment, so subscription
// receipts live in LND's hot wallet rather than a separately-derived
// xpub. The segregation is logical-only: each member's deposit address
// is recorded in the `subscription` table, and a per-member label
// string is stored in `subscription.derivation_path` for operator-side
// debugging via `lncli wallettransactions --label-filter`.
//
// The label is a documentation convention. Sync-loop attribution joins
// on `subscription.deposit_address` directly; the label is not consulted
// by the application code path.

const SUBSCRIPTION_LABEL_PREFIX = "bitcorn:subscription:";

/**
 * Returns the operator-visible label string for a member's subscription
 * deposit address. The first 16 hex chars of the pubkey is enough to
 * disambiguate within any plausible cluster size while keeping the
 * label short enough to fit in `lncli` output.
 */
export function subscriptionLabel(memberPubkey: string): string {
  return `${SUBSCRIPTION_LABEL_PREFIX}${memberPubkey.slice(0, 16)}`;
}

/**
 * Returns true if the given label looks like a subscription label.
 * Used for safety checks (e.g., refusing to delete subscription rows
 * that have receipts in the LND wallet).
 */
export function isSubscriptionLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && label.startsWith(SUBSCRIPTION_LABEL_PREFIX);
}
