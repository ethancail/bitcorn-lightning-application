import { describe, it, expect } from "vitest";
import { bech32, bech32m } from "bech32";
import { validateOnchainAddress } from "./btc-address";

// BIP-173 test vector — valid mainnet P2WPKH (witness v0, 20-byte program).
const P2WPKH_MAINNET = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

// Construct addresses via the library's own encoder so the checksum is always
// valid and the test exercises exactly one property at a time.
function makeAddress(
  hrp: string,
  version: number,
  programLen: number,
  enc: typeof bech32 | typeof bech32m,
): string {
  const program = new Uint8Array(programLen).fill(1);
  return enc.encode(hrp, [version, ...enc.toWords(program)], 90);
}

describe("validateOnchainAddress", () => {
  it("accepts the BIP-173 mainnet P2WPKH vector on mainnet", () => {
    expect(validateOnchainAddress(P2WPKH_MAINNET, "mainnet")).toEqual({ ok: true });
  });

  it("accepts v0 32-byte (P2WSH) bech32 per network", () => {
    expect(validateOnchainAddress(makeAddress("bc", 0, 32, bech32), "mainnet")).toEqual({ ok: true });
    expect(validateOnchainAddress(makeAddress("tb", 0, 32, bech32), "testnet")).toEqual({ ok: true });
    expect(validateOnchainAddress(makeAddress("bcrt", 0, 20, bech32), "regtest")).toEqual({ ok: true });
  });

  it("accepts v1 32-byte (P2TR) bech32m", () => {
    expect(validateOnchainAddress(makeAddress("bc", 1, 32, bech32m), "mainnet")).toEqual({ ok: true });
  });

  it("rejects an address for the wrong network", () => {
    const r = validateOnchainAddress(makeAddress("tb", 0, 20, bech32), "mainnet");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/wrong network/);
    // regtest node must reject mainnet addresses too
    expect(validateOnchainAddress(P2WPKH_MAINNET, "regtest").ok).toBe(false);
  });

  it("rejects a single-character typo (checksum failure)", () => {
    const typo = P2WPKH_MAINNET.slice(0, -1) + (P2WPKH_MAINNET.endsWith("4") ? "5" : "4");
    const r = validateOnchainAddress(typo, "mainnet");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/checksum|format/);
  });

  it("rejects legacy base58 addresses (out of scope by decision)", () => {
    expect(validateOnchainAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "mainnet").ok).toBe(false);
    expect(validateOnchainAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "mainnet").ok).toBe(false);
  });

  it("rejects wrong encoding for the witness version (BIP-350)", () => {
    // v0 must be bech32, not bech32m
    expect(validateOnchainAddress(makeAddress("bc", 0, 20, bech32m), "mainnet").ok).toBe(false);
    // v1 must be bech32m, not bech32
    expect(validateOnchainAddress(makeAddress("bc", 1, 32, bech32), "mainnet").ok).toBe(false);
  });

  it("rejects bad program lengths and unsupported versions", () => {
    expect(validateOnchainAddress(makeAddress("bc", 0, 25, bech32), "mainnet").ok).toBe(false);
    expect(validateOnchainAddress(makeAddress("bc", 1, 20, bech32m), "mainnet").ok).toBe(false);
    expect(validateOnchainAddress(makeAddress("bc", 2, 32, bech32m), "mainnet").ok).toBe(false);
  });

  it("rejects garbage and empty input", () => {
    expect(validateOnchainAddress("", "mainnet").ok).toBe(false);
    expect(validateOnchainAddress("not-an-address", "mainnet").ok).toBe(false);
    expect(validateOnchainAddress("bc1", "mainnet").ok).toBe(false);
  });

  it("unknown network value falls back to mainnet HRP", () => {
    expect(validateOnchainAddress(P2WPKH_MAINNET, "unknown-net")).toEqual({ ok: true });
  });
});
