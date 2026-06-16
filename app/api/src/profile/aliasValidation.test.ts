import { describe, it, expect } from "vitest";
import {
  normalizeAlias,
  validateAliasFormat,
  levenshtein,
  isAliasBlocked,
  lndDefaultAlias,
  ALIAS_MAX_BYTES,
} from "./aliasValidation";

// Coverage for the member-alias pure validation logic, per spec §7
// (2026-06-12-member-naming-and-identity-implementation.md). No DB, no LND —
// these are the A1-posture pure functions the POST/DELETE handlers compose.

describe("normalizeAlias", () => {
  it("trims leading/trailing whitespace", () => {
    expect(normalizeAlias("  Ethan's Farm  ")).toBe("Ethan's Farm");
  });
  it("collapses internal whitespace runs to a single space", () => {
    expect(normalizeAlias("Ethan's    Farm")).toBe("Ethan's Farm");
    expect(normalizeAlias("a\t\tb")).toBe("a b");
  });
  it("is idempotent (normalizing twice == once)", () => {
    const once = normalizeAlias("  big   corn  farm ");
    expect(normalizeAlias(once)).toBe(once);
  });
  it("reduces all-whitespace input to empty string", () => {
    expect(normalizeAlias("     ")).toBe("");
    // ...which then fails the format length check.
    expect(validateAliasFormat(normalizeAlias("     ")).valid).toBe(false);
  });
});

describe("validateAliasFormat", () => {
  it("accepts ordinary names", () => {
    expect(validateAliasFormat("Ethan's Farm").valid).toBe(true);
    expect(validateAliasFormat("Node-1_alpha").valid).toBe(true);
    expect(validateAliasFormat("What?! Yes.").valid).toBe(true);
  });
  it("rejects empty input (length 0)", () => {
    expect(validateAliasFormat("").valid).toBe(false);
  });
  it("accepts a 32-byte alias at the boundary and rejects 33 bytes", () => {
    const at = "a".repeat(ALIAS_MAX_BYTES); // 32 ASCII bytes
    const over = "a".repeat(ALIAS_MAX_BYTES + 1); // 33 bytes
    expect(Buffer.byteLength(at, "utf8")).toBe(32);
    expect(validateAliasFormat(at).valid).toBe(true);
    expect(validateAliasFormat(over).valid).toBe(false);
  });
  it("rejects a multibyte alias that is <= 32 chars but > 32 bytes", () => {
    // 'é' is 2 bytes in UTF-8 (but not in the allowed charset either). Use a
    // string short by .length yet over the byte budget. 20 'é' = 20 chars,
    // 40 bytes. .length would pass (20 <= 32); byte length must reject it.
    const multibyte = "é".repeat(20);
    expect(multibyte.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(32);
    const result = validateAliasFormat(multibyte);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too long/i); // failed on length, not charset
  });
  it("rejects disallowed characters", () => {
    expect(validateAliasFormat("bad@name").valid).toBe(false); // @
    expect(validateAliasFormat("a/b").valid).toBe(false); // /
    expect(validateAliasFormat("emoji😀here").valid).toBe(false); // emoji
    expect(validateAliasFormat("ctrlbell").valid).toBe(false); // control char
    expect(validateAliasFormat("café").valid).toBe(false); // non-ASCII letter
  });
  it("rejects leading/trailing and consecutive internal spaces (guards)", () => {
    expect(validateAliasFormat(" leading").valid).toBe(false);
    expect(validateAliasFormat("trailing ").valid).toBe(false);
    expect(validateAliasFormat("double  space").valid).toBe(false);
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("BitCorn1", "BitCorn1")).toBe(0);
  });
  it("returns the other length when one operand is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abcd", "")).toBe(4);
  });
  it("handles single-char operands", () => {
    expect(levenshtein("a", "b")).toBe(1);
    expect(levenshtein("a", "a")).toBe(0);
  });
  it("computes standard substitution distances", () => {
    expect(levenshtein("BitCorn1", "BitC0rn1")).toBe(1); // o -> 0
    expect(levenshtein("BitCorn1", "B1tC0rn1")).toBe(2); // i->1, o->0
    expect(levenshtein("kitten", "sitting")).toBe(3); // textbook
  });
});

describe("isAliasBlocked", () => {
  const blocked = ["BitCorn1", "treasury", "Kevin"];

  it("blocks exact matches", () => {
    expect(isAliasBlocked("BitCorn1", blocked)).toBe(true);
  });
  it("blocks case variants (case-insensitive per Gate-1 decision)", () => {
    expect(isAliasBlocked("bitcorn1", blocked)).toBe(true);
    expect(isAliasBlocked("TREASURY", blocked)).toBe(true);
  });
  it("blocks distance-1 and distance-2 substitution variants", () => {
    expect(isAliasBlocked("B1tCorn1", blocked)).toBe(true); // distance 1
    expect(isAliasBlocked("B1tC0rn1", blocked)).toBe(true); // distance 2
  });
  it("allows distance-3 unrelated names", () => {
    // "treasury" vs "treadmill" is well beyond distance 2.
    expect(isAliasBlocked("treadmill", blocked)).toBe(false);
  });
  it("never blocks against an empty blocklist", () => {
    expect(isAliasBlocked("BitCorn1", [])).toBe(false);
  });
  it("intentionally blocks a legitimate name within distance 2 of a blocked entry", () => {
    // Documented §5 collateral: "Kevin" blocked => "Devin" (distance 1) and
    // "Kevon" (distance 1) are caught. Asserted on purpose so the behavior is
    // intentional, not surprising.
    expect(isAliasBlocked("Devin", blocked)).toBe(true);
    expect(isAliasBlocked("Kevon", blocked)).toBe(true);
  });
});

describe("lndDefaultAlias", () => {
  it("returns the first 10 bytes (20 hex chars) of the pubkey, lowercased", () => {
    const pubkey =
      "03B2C3DF7D60CD289A79AEA1913DCCFACBF0C133A7748FEF4C2C1C0FB513DDC052";
    expect(lndDefaultAlias(pubkey)).toBe("03b2c3df7d60cd289a79");
    expect(lndDefaultAlias(pubkey).length).toBe(20);
  });
});
