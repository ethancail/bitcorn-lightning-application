// Pure, client-side input feedback for the Bitcorn-level name field
// (BitcornNamePanel). Spec: specs/2026-09-23-member-name-prompt-spec.md §5.
//
// Mirrors the SERVER rules in app/api/src/profile/nameValidation.ts, same
// order (empty → charset → length), so a long non-ASCII name is told which
// characters are allowed rather than that it is too long. The server is still
// authoritative; its errors are specific too (there is no blocklist to hide).
//
// ⚠ A SEPARATE constant from aliasInputState's ALLOWED_ALIAS_RE, though the
// value is currently identical: the charset is held no wider than the alias's
// (which EXCLUDES ':') until the signed transport exists (§5.2), and that
// ruling is time-bound. Sharing the regex would make widening one silently
// widen the other. Not bound by LND's 32 bytes — the cap is 64 characters,
// and with an ASCII-only charset characters and bytes are equal.

const BITCORN_NAME_ALLOWED_RE = /^[A-Za-z0-9 .\-_'!?]+$/;
export const BITCORN_NAME_MAX_CHARS = 64;

/** Canonical form: trim ends, collapse internal whitespace runs to one space. */
export function normalizeBitcornName(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export interface BitcornNameInputState {
  valid: boolean;
  normalized: string;
  charCount: number;
  error?: string;
}

export function bitcornNameInputState(input: string): BitcornNameInputState {
  const normalized = normalizeBitcornName(input);
  const charCount = normalized.length;

  if (charCount < 1) {
    return { valid: false, normalized, charCount, error: "Enter a name." };
  }
  if (!BITCORN_NAME_ALLOWED_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      charCount,
      error: "Only letters, numbers, spaces, and . - _ ' ! ?",
    };
  }
  if (charCount > BITCORN_NAME_MAX_CHARS) {
    return {
      valid: false,
      normalized,
      charCount,
      error: `Too long — ${charCount} / ${BITCORN_NAME_MAX_CHARS} characters.`,
    };
  }
  return { valid: true, normalized, charCount };
}
