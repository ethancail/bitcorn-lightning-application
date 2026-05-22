import { describe, expect, it } from "vitest";
import {
  decodeReturn,
  encodeCallData,
  isAddress,
  normalizeAddress,
  parseSignature,
  selector,
} from "../../src/lib/abi";

describe("abi.selector", () => {
  // Reference vectors — canonical ERC20 / OZ / SettlementRouter functions.
  // Cross-checked against published 4byte database entries.
  it.each([
    ["balanceOf(address)",            "0x70a08231"],
    ["transfer(address,uint256)",     "0xa9059cbb"],
    ["allowance(address,address)",    "0xdd62ed3e"],
    ["decimals()",                    "0x313ce567"],
    ["owner()",                       "0x8da5cb5b"],
    ["paused()",                      "0x5c975abb"],
    ["totalSupply()",                 "0x18160ddd"],
  ])("computes selector for %s", (sig, expected) => {
    expect(selector(sig)).toBe(expected);
  });

  it("normalizes whitespace", () => {
    expect(selector("balanceOf( address )")).toBe(selector("balanceOf(address)"));
  });
});

describe("abi.parseSignature", () => {
  it("parses no-arg function", () => {
    expect(parseSignature("owner()")).toEqual({ name: "owner", argTypes: [] });
  });
  it("parses single-arg", () => {
    expect(parseSignature("balanceOf(address)")).toEqual({
      name: "balanceOf",
      argTypes: ["address"],
    });
  });
  it("parses multi-arg", () => {
    expect(parseSignature("settle(address,uint256,bytes32)")).toEqual({
      name: "settle",
      argTypes: ["address", "uint256", "bytes32"],
    });
  });
  it("rejects unknown types", () => {
    expect(() => parseSignature("foo(string)")).toThrow(/unsupported/);
  });
  it("rejects malformed", () => {
    expect(() => parseSignature("not-a-signature")).toThrow(/invalid function/);
  });
});

describe("abi.encodeCallData", () => {
  it("encodes a balanceOf(address) call", () => {
    const data = encodeCallData("balanceOf(address)", [
      "0x4842925CF6B6671e8e1A25892bdeA0807b4814fD",
    ]);
    // 10 chars selector + 64 chars padded address = 74 chars total
    expect(data).toMatch(/^0x70a08231[0-9a-f]{64}$/);
    expect(data.endsWith("4842925cf6b6671e8e1a25892bdea0807b4814fd")).toBe(true);
  });

  it("encodes a no-arg call", () => {
    const data = encodeCallData("paused()", []);
    expect(data).toBe("0x5c975abb");
  });

  it("rejects wrong argument count", () => {
    expect(() => encodeCallData("balanceOf(address)", [])).toThrow(/expected 1 args/);
    expect(() => encodeCallData("balanceOf(address)", ["0x0", "extra"])).toThrow(/expected 1/);
  });

  it("rejects invalid address", () => {
    expect(() => encodeCallData("balanceOf(address)", ["not-an-address"])).toThrow(/invalid address/);
  });

  it("encodes uint256", () => {
    const data = encodeCallData("setFeeBps(uint256)", [123n]);
    expect(data.endsWith("000000000000000000000000000000000000000000000000000000000000007b")).toBe(true);
  });

  it("encodes bool true and false", () => {
    expect(encodeCallData("foo(bool)", [true]).endsWith(
      "0000000000000000000000000000000000000000000000000000000000000001",
    )).toBe(true);
    expect(encodeCallData("foo(bool)", [false]).endsWith(
      "0000000000000000000000000000000000000000000000000000000000000000",
    )).toBe(true);
  });

  it("encodes bytes32", () => {
    const tradeRef = "0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155";
    const data = encodeCallData("foo(bytes32)", [tradeRef]);
    expect(data.endsWith(tradeRef.slice(2))).toBe(true);
  });
});

describe("abi.decodeReturn", () => {
  it("decodes empty return for void functions", () => {
    expect(decodeReturn("0x", [])).toEqual([]);
  });

  it("decodes a single uint256", () => {
    // 20 USDC at 6 decimals = 20_000_000 = 0x1312D00
    const hex = "0x0000000000000000000000000000000000000000000000000000000001312d00";
    expect(decodeReturn(hex, ["uint256"])).toEqual([20000000n]);
  });

  it("decodes a uint16 (zero-padded)", () => {
    // fee=0 returns full 32-byte word of zeros
    expect(decodeReturn("0x" + "0".repeat(64), ["uint16"])).toEqual([0n]);
    // MAX_FEE_BPS = 100 = 0x64
    expect(decodeReturn(
      "0x0000000000000000000000000000000000000000000000000000000000000064",
      ["uint16"],
    )).toEqual([100n]);
  });

  it("decodes a bool", () => {
    expect(decodeReturn(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      ["bool"],
    )).toEqual([false]);
    expect(decodeReturn(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      ["bool"],
    )).toEqual([true]);
  });

  it("decodes an address", () => {
    expect(decodeReturn(
      "0x0000000000000000000000004842925cf6b6671e8e1a25892bdea0807b4814fd",
      ["address"],
    )).toEqual(["0x4842925cf6b6671e8e1a25892bdea0807b4814fd"]);
  });

  it("rejects short return data", () => {
    expect(() => decodeReturn("0x1234", ["uint256"])).toThrow(/too short/);
  });
});

describe("abi address helpers", () => {
  it("isAddress validates 20-byte hex", () => {
    expect(isAddress("0x4842925CF6B6671e8e1A25892bdeA0807b4814fD")).toBe(true);
    expect(isAddress("not")).toBe(false);
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress(null)).toBe(false);
  });

  it("normalizeAddress lowercases", () => {
    expect(normalizeAddress("0x4842925CF6B6671e8e1A25892bdeA0807b4814fD")).toBe(
      "0x4842925cf6b6671e8e1a25892bdea0807b4814fd",
    );
  });
});
