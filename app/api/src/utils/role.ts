export function assertTreasury(role: string | undefined): void {
  if (role !== "treasury") {
    throw new Error("Treasury privileges required");
  }
}

export function assertNonEmpty(role: string | undefined): void {
  if (!role) {
    throw new Error("Node role required");
  }
}

// ⚠️ DO NOT "HARDEN" THIS TO `role === "member"`. See
// deltas/2026-06-11-subscription-pay-from-node-implementation-deltas.md.
//
// This gate guards POST /api/subscription/pay-from-node. Its job is to
// reject the TREASURY node (which has no subscription row and no
// deposit address to pay) — NOT to require an affirmatively-classified
// "member" role. The subscription panel renders for prepay and lapsed
// members whose role classification may still be "unknown"/pending;
// the strict `role === "member"` variant would reject exactly those
// members the pay-from-node flow exists to serve. The endpoint is
// already non-generalizable (no body, server-derived 50,000-sats-to-
// own-address), so a treasury-rejection gate is the correct strictness.
export function assertMember(role: string | undefined): void {
  if (role === "treasury") {
    throw new Error("Member node required");
  }
}
