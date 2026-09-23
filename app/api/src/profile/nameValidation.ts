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
// The frontend mirrors these rules in bitcornNameInputState.ts (web side).

// ⚠ A SEPARATE constant from the alias's ALLOWED_ALIAS_RE, even though the
// value is currently identical. The charset is held no wider than the alias's
// — which EXCLUDES ':' — until the signed transport exists (§5.2): the only
// signed string today is a colon-delimited challenge, so a name containing
// ':' could be stored now and then be unsendable later. That ruling is
// time-bound; importing the alias regex by reference would make widening one
// silently widen the other.
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
