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
