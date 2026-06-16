import { describe, it, expect } from "vitest";
import { aliasInputState, normalizeAlias, ALIAS_MAX_BYTES } from "./aliasInputState";

// Client-side mirror of the server format rules (spec §6/§7). Must agree with
// app/api/src/profile/aliasValidation.ts on what "well-formed" means.

describe("normalizeAlias (web)", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeAlias("  Ethan's   Farm  ")).toBe("Ethan's Farm");
  });
});

describe("aliasInputState", () => {
  it("flags empty / whitespace-only input as invalid with byteCount 0", () => {
    expect(aliasInputState("")).toMatchObject({ valid: false, byteCount: 0 });
    expect(aliasInputState("   ")).toMatchObject({ valid: false, byteCount: 0 });
  });

  it("counts ASCII bytes correctly", () => {
    const s = aliasInputState("Ethan's Farm");
    expect(s.valid).toBe(true);
    expect(s.normalized).toBe("Ethan's Farm");
    expect(s.byteCount).toBe("Ethan's Farm".length); // all ASCII => bytes == chars
  });

  it("counts multibyte UTF-8 bytes, not char length", () => {
    // 'é' is 2 UTF-8 bytes. (It also fails the charset, but the count is what
    // matters here — the counter must reflect bytes.)
    const s = aliasInputState("café");
    expect(s.byteCount).toBe(5); // c,a,f = 3 bytes + é = 2 bytes
  });

  it("accepts a 32-byte alias and rejects 33 bytes", () => {
    expect(aliasInputState("a".repeat(ALIAS_MAX_BYTES)).valid).toBe(true);
    const over = aliasInputState("a".repeat(ALIAS_MAX_BYTES + 1));
    expect(over.valid).toBe(false);
    expect(over.error).toMatch(/too long/i);
  });

  it("rejects disallowed characters with a specific hint", () => {
    expect(aliasInputState("bad@name").valid).toBe(false);
    expect(aliasInputState("emoji😀").valid).toBe(false);
    expect(aliasInputState("café").valid).toBe(false);
  });

  it("returns the normalized form valid input will send", () => {
    expect(aliasInputState("My   Node").normalized).toBe("My Node");
  });
});
