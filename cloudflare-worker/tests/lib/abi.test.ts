import { describe, expect, it } from "vitest";
import {
  decodeIndexedTopic,
  decodeReturn,
  encodeCallData,
  eventTopic0,
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

describe("abi.eventTopic0", () => {
  // Reference vectors:
  //   - Settled vector cross-checked against the actual on-chain log emitted by
  //     the smoke-test settle tx on Base Sepolia (block 41851567).
  //   - Transfer / Approval vectors are canonical ERC20.
  //   - FeeBpsUpdated / Paused / Unpaused precomputed locally + verified via
  //     keccak256 from the @noble/hashes library at implementation time.
  it.each([
    [
      "Settled(address,address,uint256,uint256,bytes32)",
      "0x4a69742b8c79b607e7d6ec3e71d19c5d19a09a822a87b2339620d028f570178b",
    ],
    [
      "FeeBpsUpdated(uint16,uint16)",
      "0x8d10f5697a370f640ed5d474159aba3cc86e9bc260a5e9d2db875ad992cb1a1f",
    ],
    [
      "Paused(address)",
      "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
    ],
    [
      "Unpaused(address)",
      "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa",
    ],
    [
      "Transfer(address,address,uint256)",
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    ],
    [
      "Approval(address,address,uint256)",
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    ],
  ])("computes topic0 for %s", (sig, expected) => {
    expect(eventTopic0(sig)).toBe(expected);
  });

  it("returns the full 32-byte hash (66 hex chars including 0x)", () => {
    const topic = eventTopic0("Paused(address)");
    expect(topic).toMatch(/^0x[0-9a-f]{64}$/);
    expect(topic.length).toBe(66);
  });

  it("normalizes whitespace", () => {
    expect(eventTopic0("Paused( address )")).toBe(eventTopic0("Paused(address)"));
  });
});

describe("abi.decodeIndexedTopic", () => {
  it("decodes an indexed address (left-padded with zeros)", () => {
    // Real fixture from the smoke-test settle tx — sender topic.
    const senderTopic = "0x0000000000000000000000004842925cf6b6671e8e1a25892bdea0807b4814fd";
    expect(decodeIndexedTopic("address", senderTopic)).toBe(
      "0x4842925cf6b6671e8e1a25892bdea0807b4814fd",
    );
  });

  it("decodes an indexed bytes32 (the topic IS the bytes32, no padding)", () => {
    // Real fixture — tradeRef from the smoke-test settle tx.
    const tradeRef = "0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155";
    expect(decodeIndexedTopic("bytes32", tradeRef)).toBe(tradeRef);
  });

  it("decodes an indexed uint256", () => {
    const topic = "0x000000000000000000000000000000000000000000000000000000000001e240"; // 123456
    expect(decodeIndexedTopic("uint256", topic)).toBe(123456n);
  });

  it("decodes an indexed bool (true)", () => {
    const topic = "0x" + "0".repeat(63) + "1";
    expect(decodeIndexedTopic("bool", topic)).toBe(true);
  });

  it("decodes an indexed bool (false)", () => {
    const topic = "0x" + "0".repeat(64);
    expect(decodeIndexedTopic("bool", topic)).toBe(false);
  });

  it("rejects a topic with wrong length", () => {
    expect(() => decodeIndexedTopic("address", "0xabcd")).toThrow(/32 bytes/);
    expect(() => decodeIndexedTopic("address", "0x" + "0".repeat(63))).toThrow(/32 bytes/);
  });

  it("accepts a topic without 0x prefix (defensive)", () => {
    const senderNoPrefix = "0000000000000000000000004842925cf6b6671e8e1a25892bdea0807b4814fd";
    expect(decodeIndexedTopic("address", senderNoPrefix)).toBe(
      "0x4842925cf6b6671e8e1a25892bdea0807b4814fd",
    );
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
