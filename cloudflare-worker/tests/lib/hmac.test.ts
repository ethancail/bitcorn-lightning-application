import { describe, expect, it } from "vitest";
import { canonicalString, signHmac, verifyHmac } from "../../src/lib/hmac";

const SECRET = "test-secret-value";
const TIMESTAMP = "2026-04-17T14:32:00Z";
const BODY = '{"submitted_at":"2026-04-17T14:32:00Z","values":{"mvrv":2.1}}';

describe("canonicalString", () => {
  it("concatenates timestamp and hex SHA-256 of body with a newline", async () => {
    const s = await canonicalString(TIMESTAMP, BODY);
    // The body hash is deterministic; check shape rather than exact digest
    expect(s.startsWith(TIMESTAMP + "\n")).toBe(true);
    expect(s.length).toBe(TIMESTAMP.length + 1 + 64); // 64-char hex digest
  });
});

describe("signHmac + verifyHmac", () => {
  it("round-trips: a signature signed with SECRET verifies with SECRET", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac(SECRET, TIMESTAMP, BODY, sig);
    expect(ok).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const ok = await verifyHmac(SECRET, TIMESTAMP, BODY, "deadbeef".repeat(8));
    expect(ok).toBe(false);
  });

  it("rejects a body mutation", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac(SECRET, TIMESTAMP, BODY + " ", sig);
    expect(ok).toBe(false);
  });

  it("rejects a timestamp change", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac(SECRET, "2026-04-17T14:33:00Z", BODY, sig);
    expect(ok).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac("other-secret", TIMESTAMP, BODY, sig);
    expect(ok).toBe(false);
  });
});
