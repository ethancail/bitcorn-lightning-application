// The strings both ends of POST /api/subscription/token sign and verify.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §3, Q3 (decision D8). The member builds them in tokenRefresh.ts; the
// treasury checks them in challengeAuth.ts and memberName.ts. One module, so
// the two ends cannot drift apart — CHALLENGE_PREFIX used to be duplicated in
// both files with nothing tying them together.
//
// ⚠ THE CHALLENGE GRAMMAR IS BYTE-IDENTICAL TO ITS PRE-D8 FORM (D8 call 1).
// Moving the constant here changed where it lives, not its bytes; a test pins
// the literal (challengeGrammar.test.ts).
//
// The name signature (D8 call 1; format and field names ACCEPTED — Ethan,
// 2026-09-28):
//
//     bitcorn:member-name:<the full challenge, exactly as sent>:<name, exactly as sent>
//
// - NAME_SIGNATURE_PREFIX does NOT start with CHALLENGE_PREFIX, so a name
//   signature can never pass the challenge parser's first check, and a
//   challenge signature never verifies as a name signature.
// - Unambiguous ONLY because the name is colon-free: the last ':' always
//   separates challenge from name. ⚠ That makes the name charset's ':'
//   exclusion PERMANENT and load-bearing (nameValidation.ts,
//   bitcornNameInputState.ts). Widening it would break this format.
// - The treasury REBUILDS this string from the two received fields and
//   verifies against it; it never parses a signed string apart.

export const CHALLENGE_PREFIX = "bitcorn:token-request:";
export const NAME_SIGNATURE_PREFIX = "bitcorn:member-name:";

export function buildNameSignedString(challenge: string, name: string): string {
  return `${NAME_SIGNATURE_PREFIX}${challenge}:${name}`;
}

// The treasury's signed status response (bitcorn-research specs/2026-11-10-
// treasury-price-trust-spec.md §1.1; decisions/2026-11-10-treasury-price-
// trust-lnd-signed-status-cap-address-pin-and-sibling-exemption-ground.md D1,
// D2). The treasury's LND signs, and the member verifies against the
// release-pinned TREASURY_PUBKEY:
//
//     bitcorn:treasury-status:v1:<member_pubkey>:<nonce>:<body_sha256>
//
// - member_pubkey: 66 lowercase hex, the member the response is for (stops a
//   response signed for one member being served to another).
// - nonce: 32 lowercase hex, drawn by the member for THIS request (stops a
//   replay). The treasury stores nothing; the member holds it for the call.
// - body_sha256: 64 lowercase hex, SHA-256 of the exact response body bytes.
//   The whole body, no canonicalisation, no field list (D2).
//
// Every field has a fixed grammar, so the string is unambiguous without
// escaping. Both ends BUILD it from their own inputs; neither parses one apart.
// The prefix starts with neither prefix above, and neither starts with it, so
// no signature over one of the three strings verifies as another.
export const TREASURY_STATUS_PREFIX = "bitcorn:treasury-status:v1:";

export function buildTreasuryStatusSignedString(
  memberPubkey: string,
  nonce: string,
  bodySha256Hex: string,
): string {
  return `${TREASURY_STATUS_PREFIX}${memberPubkey}:${nonce}:${bodySha256Hex}`;
}
