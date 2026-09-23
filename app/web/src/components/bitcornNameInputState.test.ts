import { describe, it, expect } from "vitest";
import { bitcornNameInputState, BITCORN_NAME_MAX_CHARS } from "./bitcornNameInputState";
import { aliasInputState } from "./aliasInputState";

// Client mirror of app/api/src/profile/nameValidation.ts — spec 2026-09-23-
// member-name-prompt §5. Same order as the server: empty → charset → length,
// so a long non-ASCII name is told "character not allowed", not "too long".

describe("bitcornNameInputState", () => {
  it("accepts an ordinary name and reports its normalized form + count", () => {
    expect(bitcornNameInputState("  Green   Acres ")).toEqual({
      valid: true,
      normalized: "Green Acres",
      charCount: 11,
    });
  });

  it("rejects empty input", () => {
    expect(bitcornNameInputState("   ")).toMatchObject({ valid: false, error: "Enter a name." });
  });

  it("rejects ':' (charset no wider than the alias's, §5.2)", () => {
    expect(bitcornNameInputState("Farm:1")).toMatchObject({
      valid: false,
      error: "Only letters, numbers, spaces, and . - _ ' ! ?",
    });
  });

  it("accepts 33..64 characters — not bound by LND's 32 bytes", () => {
    expect(bitcornNameInputState("a".repeat(33)).valid).toBe(true);
    expect(bitcornNameInputState("a".repeat(BITCORN_NAME_MAX_CHARS)).valid).toBe(true);
  });

  it("rejects 65 characters with a count", () => {
    expect(BITCORN_NAME_MAX_CHARS).toBe(64);
    expect(bitcornNameInputState("a".repeat(65))).toMatchObject({
      valid: false,
      error: "Too long — 65 / 64 characters.",
    });
  });

  it("checks charset BEFORE length: 70 non-ASCII characters → 'character not allowed'", () => {
    expect(bitcornNameInputState("é".repeat(70))).toMatchObject({
      valid: false,
      error: "Only letters, numbers, spaces, and . - _ ' ! ?",
    });
  });

  it("is a SEPARATE rule set from the alias's: a 40-char name passes here and fails as an alias", () => {
    const forty = "a".repeat(40);
    expect(bitcornNameInputState(forty).valid).toBe(true);
    expect(aliasInputState(forty).valid).toBe(false);
  });
});
