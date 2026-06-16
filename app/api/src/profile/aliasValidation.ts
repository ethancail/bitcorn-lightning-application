// Pure validation/normalization logic for member public Lightning aliases.
//
// Source: bitcorn-research/specs/2026-06-12-member-naming-and-identity-
// implementation.md §5 (A1 posture — no DB, no LND). The endpoint handler
// (index.ts) composes these with the `blocked_aliases` DB read; these
// functions own only the string rules so they are unit-testable in isolation.
//
// The frontend mirrors these rules in its own `aliasInputState` (web side)
// so client-side feedback agrees with the server's authoritative check.
// Byte counting differs by runtime: this module uses Buffer.byteLength
// (Node); the browser uses TextEncoder — both count UTF-8 bytes, never
// String.length (LND's cap is 32 *bytes*; multibyte chars consume >1).

// Allowed character set (§5): ASCII alphanumeric + space + . - _ ' ! ?
// Deliberately ASCII-only "alphanumeric": the stricter the set, the smaller
// the homoglyph/impersonation surface the blocklist (§4) has to defend.
const ALLOWED_ALIAS_RE = /^[A-Za-z0-9 .\-_'!?]+$/;

export const ALIAS_MAX_BYTES = 32; // LND hard cap (BOLT 7 node_announcement).

export interface AliasFormatResult {
  valid: boolean;
  error?: string;
}

/**
 * Collapse an alias to its canonical form: strip leading/trailing whitespace
 * and collapse internal whitespace runs to a single space. This is the form
 * used for BOTH storage and the LND call, so what the member sees, what is
 * stored, and what is gossiped are identical (§5).
 */
export function normalizeAlias(alias: string): string {
  return alias.replace(/\s+/g, " ").trim();
}

/**
 * Validate a (normally pre-normalized) alias against the format rules (§5).
 * Order matters: length is checked on UTF-8 *bytes* before charset, so a
 * multibyte string that is short by `.length` but over the byte budget fails
 * on the length rule specifically (the case `.length` would miss).
 *
 * The whitespace guards assume `normalizeAlias` already ran; operating on the
 * normalized form makes them a guard, not the primary cleaner.
 */
export function validateAliasFormat(alias: string): AliasFormatResult {
  const bytes = Buffer.byteLength(alias, "utf8");
  if (bytes < 1) {
    return { valid: false, error: "Alias cannot be empty." };
  }
  if (bytes > ALIAS_MAX_BYTES) {
    return { valid: false, error: `Alias is too long (${bytes}/${ALIAS_MAX_BYTES} bytes).` };
  }
  if (!ALLOWED_ALIAS_RE.test(alias)) {
    return {
      valid: false,
      error: "Alias may contain only letters, numbers, spaces, and . - _ ' ! ?",
    };
  }
  if (/^\s|\s$/.test(alias)) {
    return { valid: false, error: "Alias cannot start or end with a space." };
  }
  if (/\s{2,}/.test(alias)) {
    return { valid: false, error: "Alias cannot contain consecutive spaces." };
  }
  return { valid: true };
}

/**
 * Standard iterative Levenshtein edit distance (case-sensitive primitive).
 * Case folding for blocklist comparison lives in `isAliasBlocked`, not here.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row rolling DP — O(min) space.
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Reconstruct LND's pubkey-derived default alias: the first 10 bytes of the
 * node pubkey rendered as hex (20 hex chars). Used by the clear path (§8): LND
 * rejects an empty-string alias (proto3 scalar field presence — an empty
 * string is indistinguishable from "field unset", so LND reports "no new
 * values to update"), so clearing re-asserts this default-looking value to
 * visibly return the node to its anonymous default. Lowercased to match LND's
 * hex rendering.
 */
export function lndDefaultAlias(pubkey: string): string {
  return pubkey.slice(0, 20).toLowerCase();
}

/** Distance at or below this against any blocked entry rejects the alias (§4). */
export const ALIAS_BLOCK_DISTANCE = 2;

/**
 * True if `alias` is operator-blocked: exact match OR Levenshtein distance
 * <= ALIAS_BLOCK_DISTANCE against any blocklist entry. Comparison is
 * case-insensitive (both operands lowercased) per the Gate-1 decision, so
 * "bitcorn1" is caught against a blocked "BitCorn1". Returns true on the
 * first match. An empty blocklist never blocks (acceptable v1 posture).
 */
export function isAliasBlocked(alias: string, blockedList: string[]): boolean {
  const needle = alias.toLowerCase();
  for (const entry of blockedList) {
    const hay = entry.toLowerCase();
    if (needle === hay) return true;
    if (levenshtein(needle, hay) <= ALIAS_BLOCK_DISTANCE) return true;
  }
  return false;
}
