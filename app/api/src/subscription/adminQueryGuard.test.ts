import { describe, it, expect } from "vitest";
import { isAdminMemberQuery, ADMIN_QUERY_REJECTION } from "./adminQueryGuard";

// The `?member_pubkey=<hex>` admin-debug query on GET /api/subscription/status
// and /payments was gated on the treasury by assertTreasury ONLY — a node-role
// check that passes for every caller on the treasury node — so any unauthenticated
// caller could read any member's subscription state and full payment ledger.
//
// The member side already refused the parameter outright (index.ts:580-581 and
// :749-751, error "admin_query_treasury_only"). This guard mirrors that decision
// so the treasury refuses it too. It deliberately does NOT authenticate the
// parameter and does NOT validate its format — presence alone is the rejection.
//
// Fidelity note: the member side tests truthiness of
// `url.searchParams.get("member_pubkey")`, so an empty value (`?member_pubkey=`)
// reads as ABSENT there. These tests pin that same behaviour rather than a
// stricter one, so the two sides cannot diverge silently.

describe("isAdminMemberQuery — presence is the rejection", () => {
  it("absent parameter is not an admin query (the Bearer path must stay reachable)", () => {
    expect(isAdminMemberQuery(null)).toBe(false);
  });

  it("empty value reads as absent, mirroring the member side's truthiness test", () => {
    expect(isAdminMemberQuery("")).toBe(false);
  });

  it("a hex pubkey is an admin query and is refused", () => {
    expect(isAdminMemberQuery("02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca")).toBe(true);
  });

  it("refusal does not depend on the value being well-formed hex", () => {
    expect(isAdminMemberQuery("not-a-pubkey")).toBe(true);
    expect(isAdminMemberQuery("02AB")).toBe(true);
  });

  it("whitespace-only value is still a refusal — no trimming, so no bypass", () => {
    // Pinned deliberately: a future "helpful" .trim() would turn " " into ""
    // and reopen the disclosure for any caller who pads the parameter.
    expect(isAdminMemberQuery(" ")).toBe(true);
  });
});

describe("ADMIN_QUERY_REJECTION — the shared response shape", () => {
  it("is 403 with the same error code the member side already returns", () => {
    // Reuse is intentional: grep showed two producers (index.ts:581, :751) and
    // ZERO consumers, so the string is not load-bearing API. Pinning it here
    // makes any future divergence between the two sides a test failure.
    expect(ADMIN_QUERY_REJECTION.status).toBe(403);
    expect(ADMIN_QUERY_REJECTION.body).toEqual({ error: "admin_query_treasury_only" });
  });
});
