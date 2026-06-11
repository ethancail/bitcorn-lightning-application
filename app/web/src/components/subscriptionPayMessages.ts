// Error-code → human message maps for the subscription action buttons.
//
// Source of truth: decisions/2026-06-11-subscription-panel-action-
// button-behaviors.md §3 (Onramp visible errors) + § Backend endpoint
// design (pay-from-node error contract). No silent failures: every code
// maps to a clear sentence, and unknown codes surface the raw `detail`
// rather than swallowing it.
//
// Codes arrive on the thrown Error's `.code` field (apiFetch sets
// `code = err.error`); `.detail` carries the raw LND/backend detail.

export function payErrorMessage(code?: string, detail?: string): string {
  switch (code) {
    case "insufficient_funds":
      return "Not enough on-chain balance in your node wallet to cover the payment plus the network fee.";
    case "fee_estimate_failed":
      return "Couldn't estimate the network fee right now. Try again in a moment.";
    case "lnd_unavailable":
      return "Your node's wallet is unavailable right now. Try again in a moment.";
    case "send_failed":
      return detail
        ? `The payment couldn't be sent: ${detail}`
        : "The payment couldn't be sent. Try again.";
    case "status_unavailable":
      return "Couldn't confirm your subscription details with the treasury. Try again in a moment.";
    case "payment_in_flight":
      return "A payment is already being sent from this node. Wait for it to finish before trying again.";
    case "member_required":
      return "This action is only available on member nodes.";
    default:
      // Unknown code: surface the detail rather than swallowing it.
      return detail ?? "Something went wrong sending the payment.";
  }
}

export function onrampErrorMessage(code?: string, fallback?: string): string {
  if (code === "coinbase_not_configured") {
    return "Coinbase Onramp is not configured on this node.";
  }
  return fallback ?? "Couldn't open Coinbase Onramp. Try again.";
}
