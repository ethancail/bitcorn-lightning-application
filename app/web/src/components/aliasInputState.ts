// Pure, client-side alias input feedback for the Profile panel (spec §6).
//
// Mirrors the SERVER format rules in app/api/src/profile/aliasValidation.ts so
// well-formed input is the normal case by the time it reaches the API. The
// server still owns the authoritative (and deliberately generic) rejection —
// this only provides SPECIFIC, helpful format hints client-side, where format
// rules are public anyway and there is no blocklist secret to protect.
//
// Byte counting uses TextEncoder (UTF-8 bytes), never String.length: LND's cap
// is 32 *bytes* and multibyte characters consume more than one. The API uses
// Buffer.byteLength for the same count.

const ALLOWED_ALIAS_RE = /^[A-Za-z0-9 .\-_'!?]+$/;
export const ALIAS_MAX_BYTES = 32;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Canonical form: trim ends, collapse internal whitespace runs to one space. */
export function normalizeAlias(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export interface AliasInputState {
  valid: boolean;
  normalized: string;
  byteCount: number;
  error?: string;
}

/**
 * Compute live feedback for the alias input: the normalized form, its UTF-8
 * byte count (for the "X / 32 bytes" counter), validity, and a specific format
 * error. Operates on the normalized form, so whitespace guards are unnecessary
 * (normalization already collapses/trims them).
 */
export function aliasInputState(input: string): AliasInputState {
  const normalized = normalizeAlias(input);
  const byteCount = utf8ByteLength(normalized);

  if (byteCount < 1) {
    return { valid: false, normalized, byteCount, error: "Enter an alias." };
  }
  if (byteCount > ALIAS_MAX_BYTES) {
    return {
      valid: false,
      normalized,
      byteCount,
      error: `Too long — ${byteCount} / ${ALIAS_MAX_BYTES} bytes.`,
    };
  }
  if (!ALLOWED_ALIAS_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      byteCount,
      error: "Only letters, numbers, spaces, and . - _ ' ! ?",
    };
  }
  return { valid: true, normalized, byteCount };
}
