import { describe, it, expect } from "vitest";
import {
  buildRevenueLookup,
  fmtUsdCents,
  lowercaseContacts,
  topEarners,
} from "./subscriptionRevenueView";
import type { Contact, MemberRevenueRow } from "../api/client";

// 66-hex-char pubkeys (compressed secp256k1 length) so truncPubkey's
// short-string guard doesn't kick in for the fallback assertions.
const PK_A = "02" + "a".repeat(64);
const PK_B = "02" + "b".repeat(64);
const PK_C = "02" + "c".repeat(64);

function contact(pubkey: string, name: string): Contact {
  return {
    id: 1,
    pubkey,
    name,
    notes: null,
    tags: [],
    source: "manual",
    created_at: 0,
    updated_at: 0,
    channels: [],
  };
}

function revenue(
  pubkey: string,
  total_sats: number,
  extra?: Partial<MemberRevenueRow>,
): MemberRevenueRow {
  return {
    member_pubkey: pubkey,
    total_sats,
    total_usd_cents: 0,
    payment_count: 1,
    window_sats: 0,
    window_payment_count: 0,
    ...extra,
  };
}

describe("topEarners — alias join", () => {
  it("resolves a contact whose pubkey was stored uppercase (case-normalized join)", () => {
    // Revenue pubkeys are lowercased by the API; the contact was
    // entered uppercase. Without normalization this silently misses.
    const rows = topEarners([revenue(PK_A, 50_000)], [contact(PK_A.toUpperCase(), "Merchant1")]);
    expect(rows[0].name).toBe("Merchant1");
  });

  it("falls back to a truncated pubkey when no contact matches", () => {
    const rows = topEarners([revenue(PK_A, 50_000)], []);
    expect(rows[0].name).toBe(`${PK_A.slice(0, 12)}…${PK_A.slice(-6)}`);
  });

  it("ranks by total_sats DESC and applies the limit", () => {
    const members = [
      revenue(PK_A, 100_000),
      revenue(PK_B, 300_000),
      revenue(PK_C, 200_000),
    ];
    const rows = topEarners(members, [], 2);
    expect(rows.map((r) => r.member_pubkey)).toEqual([PK_B, PK_C]);
  });

  it("carries usd cents and payment count through", () => {
    const rows = topEarners(
      [revenue(PK_A, 50_000, { total_usd_cents: 3_127, payment_count: 9 })],
      [],
    );
    expect(rows[0]).toMatchObject({ total_usd_cents: 3_127, payment_count: 9 });
  });
});

describe("buildRevenueLookup", () => {
  it("keys by lowercased pubkey so mixed-case channel pubkeys still join", () => {
    const map = buildRevenueLookup([revenue(PK_A, 50_000)]);
    expect(map.get(PK_A.toUpperCase().toLowerCase())).toBeDefined();
    expect(map.get(PK_A)?.total_sats).toBe(50_000);
    expect(map.get(PK_B)).toBeUndefined();
  });
});

describe("lowercaseContacts", () => {
  it("lowercases pubkeys without touching other fields", () => {
    const [c] = lowercaseContacts([contact(PK_A.toUpperCase(), "Merchant1")]);
    expect(c.pubkey).toBe(PK_A);
    expect(c.name).toBe("Merchant1");
  });
});

describe("fmtUsdCents", () => {
  it("formats cents as dollars with two decimals", () => {
    expect(fmtUsdCents(3_127)).toBe("$31.27");
    expect(fmtUsdCents(0)).toBe("$0.00");
    expect(fmtUsdCents(123_456_789)).toBe("$1,234,567.89");
  });
});
