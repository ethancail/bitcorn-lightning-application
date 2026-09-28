// Pure validation/normalization for the member's Bitcorn-level name
// (member_profile.bitcorn_name, migration 055).
//
// Source: bitcorn-research/specs/2026-09-23-member-name-prompt-spec.md §5.
// The alias rules (aliasValidation.ts) MINUS the LND-only parts (32-byte cap,
// byte counting, lndDefaultAlias) and MINUS the blocklist: on a member node
// `blocked_aliases` is the farmer's own, never-seeded table, so it defends
// nothing here (§5.3) and is deliberately not wired. With no blocklist there
// is nothing to hide, so errors are SPECIFIC (accepted 2026-09-23).
//
// The TREASURY applies these same two functions to the name each member sends
// (subscription/memberName.ts, D8) and THEN checks its own operator's
// blocked_aliases — there the answer is a generic "rejected", never why.
//
// The frontend mirrors these rules in bitcornNameInputState.ts (web side).

// ⚠ A SEPARATE constant from the alias's ALLOWED_ALIAS_RE, even though the
// value is currently identical. ⚠ THE ':' EXCLUSION IS PERMANENT AND
// LOAD-BEARING. It began as a time-bound ruling (§5.2 of the 2026-09-23 spec:
// "until the signed transport exists"). The transport now exists (D8), and its
// name signature is `bitcorn:member-name:<challenge>:<name>` — unambiguous
// ONLY because the name has no ':', so the last colon always separates
// challenge from name (subscription/challengeGrammar.ts). Admitting ':' here
// would break that format. Importing the alias regex by reference would still
// make widening one silently widen the other, hence the separate constant.
const BITCORN_NAME_ALLOWED_RE = /^[A-Za-z0-9 .\-_'!?]+$/;

// Characters, not bytes: the charset is ASCII-only, so they are equal here.
export const BITCORN_NAME_MAX_CHARS = 64;

export interface BitcornNameResult {
  valid: boolean;
  error?: string;
}

/** Canonical form, used for storage: trim ends, collapse whitespace runs. */
export function normalizeBitcornName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Validate a (normally pre-normalized) name. Order: empty → charset →
 * whitespace guards → length. Charset precedes length (Ethan, 2026-09-23) so a
 * long non-ASCII name is told which characters are allowed, not that it is
 * too long — the error the member can act on.
 */
export function validateBitcornName(name: string): BitcornNameResult {
  if (name.length < 1) {
    return { valid: false, error: "Name cannot be empty." };
  }
  if (!BITCORN_NAME_ALLOWED_RE.test(name)) {
    return {
      valid: false,
      error: "Name may contain only letters, numbers, spaces, and . - _ ' ! ?",
    };
  }
  if (/^\s|\s$/.test(name)) {
    return { valid: false, error: "Name cannot start or end with a space." };
  }
  if (/\s{2,}/.test(name)) {
    return { valid: false, error: "Name cannot contain consecutive spaces." };
  }
  if (name.length > BITCORN_NAME_MAX_CHARS) {
    return {
      valid: false,
      error: `Name is too long (${name.length}/${BITCORN_NAME_MAX_CHARS} characters).`,
    };
  }
  return { valid: true };
}
