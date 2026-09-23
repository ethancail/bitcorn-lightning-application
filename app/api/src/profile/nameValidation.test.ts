import { describe, it, expect } from "vitest";
import {
  BITCORN_NAME_MAX_CHARS,
  normalizeBitcornName,
  validateBitcornName,
} from "./nameValidation";

// Server rules for the Bitcorn-level member name — spec 2026-09-23-member-
// name-prompt §5. The alias rules minus LND's 32-byte cap and minus the
// blocklist; charset no wider than the alias's, which EXCLUDES ':'.
//
// Error strings are hardcoded here on purpose: specific errors were accepted
// (§5.3), so a change to what the member is told should fail a test.

describe("normalizeBitcornName", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeBitcornName("  Green   Acres\tFarm  ")).toBe("Green Acres Farm");
  });
  it("reduces all-whitespace input to the empty string", () => {
    expect(normalizeBitcornName(" \t\n ")).toBe("");
  });
});

describe("validateBitcornName", () => {
  it("accepts ordinary names", () => {
    expect(validateBitcornName("Green Acres Farm")).toEqual({ valid: true });
    expect(validateBitcornName("O'Brien Bros. Co-op!")).toEqual({ valid: true });
  });

  it("rejects the empty string (an empty name must not count as stored)", () => {
    expect(validateBitcornName("")).toEqual({ valid: false, error: "Name cannot be empty." });
  });

  it("rejects ':' — the charset must stay no wider than the alias's until the transport exists (§5.2)", () => {
    expect(validateBitcornName("Farm:1")).toEqual({
      valid: false,
      error: "Name may contain only letters, numbers, spaces, and . - _ ' ! ?",
    });
  });

  it("rejects other characters outside the set", () => {
    for (const bad of ["Farm/1", "Farm@home", "Farm#1", "a<b>"]) {
      expect(validateBitcornName(bad).valid, bad).toBe(false);
    }
  });

  it("is NOT bound by LND's 32 bytes: 33..64 characters are accepted", () => {
    expect(validateBitcornName("a".repeat(33))).toEqual({ valid: true });
    expect(validateBitcornName("a".repeat(BITCORN_NAME_MAX_CHARS))).toEqual({ valid: true });
  });

  it("caps at 64 characters: 65 is rejected with the count", () => {
    expect(BITCORN_NAME_MAX_CHARS).toBe(64);
    expect(validateBitcornName("a".repeat(65))).toEqual({
      valid: false,
      error: "Name is too long (65/64 characters).",
    });
  });

  it("checks charset BEFORE length: a long non-ASCII name is told 'character not allowed', not 'too long'", () => {
    const longNonAscii = "é".repeat(70);
    expect(validateBitcornName(longNonAscii)).toEqual({
      valid: false,
      error: "Name may contain only letters, numbers, spaces, and . - _ ' ! ?",
    });
  });

  it("rejects leading/trailing and consecutive spaces (guards behind normalization)", () => {
    expect(validateBitcornName(" Farm").error).toBe("Name cannot start or end with a space.");
    expect(validateBitcornName("Farm ").error).toBe("Name cannot start or end with a space.");
    expect(validateBitcornName("Green  Acres").error).toBe("Name cannot contain consecutive spaces.");
  });
});
