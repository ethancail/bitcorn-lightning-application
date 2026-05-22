// Minimal Ethereum ABI encoder/decoder for the Worker's BASE proxy endpoints.
//
// This is deliberately tiny — only the read-side types we currently call into
// (address, bool, uint8, uint16, uint256, bytes32) — so the Worker bundle stays
// small. If a future endpoint needs richer types (arrays, structs, dynamic
// bytes), this file grows OR we add viem; the current set covers v1's scope.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §5
//
// Reference vectors validated against the deployed SettlementRouter on Base
// Sepolia (0xF1Bc89974f8520b7f98e7cF0C689a7077aF04c78):
//   keccak256("balanceOf(address)")[0:4] = 0x70a08231
//   keccak256("feeBps()")[0:4]           = 0x65bf94d6
//   keccak256("paused()")[0:4]           = 0x5c975abb
//   keccak256("owner()")[0:4]            = 0x8da5cb5b
//   keccak256("decimals()")[0:4]         = 0x313ce567

import { keccak_256 } from "@noble/hashes/sha3";

export type AbiType = "address" | "bool" | "uint8" | "uint16" | "uint256" | "bytes32";

const HEX_CHARS = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_CHARS[(bytes[i] >> 4) & 0x0f];
    out += HEX_CHARS[bytes[i] & 0x0f];
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i}`);
    out[i / 2] = byte;
  }
  return out;
}

/**
 * Compute the 4-byte ABI function selector for a signature like
 * `"balanceOf(address)"` or `"settle(address,uint256,bytes32)"`.
 * Returns a 0x-prefixed 10-char hex string (8 hex chars = 4 bytes).
 */
export function selector(signature: string): string {
  // Strip parameter names and whitespace — ABI selector is keccak of the
  // type-only signature (e.g. "transfer(address,uint256)"), not the named form.
  const normalized = signature.replace(/\s+/g, "");
  const hash = keccak_256(new TextEncoder().encode(normalized));
  return "0x" + bytesToHex(hash.slice(0, 4));
}

/**
 * Parse a Solidity function signature like `"balanceOf(address)"` into its
 * name and ordered argument types. Throws on malformed input.
 */
export function parseSignature(signature: string): { name: string; argTypes: AbiType[] } {
  const m = signature.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\(([^)]*)\)$/);
  if (!m) throw new Error(`invalid function signature: ${signature}`);
  const name = m[1];
  const argsRaw = m[2].trim();
  if (argsRaw === "") return { name, argTypes: [] };
  const argTypes = argsRaw.split(",").map((t) => t.trim() as AbiType);
  for (const t of argTypes) {
    if (!isSupportedType(t)) {
      throw new Error(`unsupported ABI type in signature: ${t}`);
    }
  }
  return { name, argTypes };
}

function isSupportedType(t: string): t is AbiType {
  return t === "address" || t === "bool" || t === "uint8" || t === "uint16"
    || t === "uint256" || t === "bytes32";
}

// -----------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------

/** Pad-left to 32 bytes, returns 0x-prefixed 66-char hex. */
function pad32(hexNo0x: string): string {
  if (hexNo0x.length > 64) throw new Error("value too large to fit in 32 bytes");
  return hexNo0x.padStart(64, "0");
}

function encodeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`invalid address: ${value}`);
  }
  return pad32(value.slice(2).toLowerCase());
}

function encodeUint(value: string | number | bigint, maxBits: number): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new Error("uint cannot be negative");
  const max = (1n << BigInt(maxBits)) - 1n;
  if (n > max) throw new Error(`uint${maxBits} overflow: ${n}`);
  return pad32(n.toString(16));
}

function encodeBool(value: boolean): string {
  return pad32(value ? "1" : "0");
}

function encodeBytes32(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid bytes32: ${value}`);
  }
  return value.slice(2).toLowerCase();
}

/**
 * Encode one ABI argument. Caller is responsible for concatenating multiple
 * encoded arguments and prefixing with the function selector.
 */
function encodeArg(type: AbiType, value: unknown): string {
  switch (type) {
    case "address": return encodeAddress(String(value));
    case "bool":    return encodeBool(Boolean(value));
    case "uint8":   return encodeUint(value as any, 8);
    case "uint16":  return encodeUint(value as any, 16);
    case "uint256": return encodeUint(value as any, 256);
    case "bytes32": return encodeBytes32(String(value));
  }
}

/**
 * Build the calldata for an `eth_call` invocation: 4-byte selector followed by
 * ABI-encoded arguments. Returns 0x-prefixed hex.
 */
export function encodeCallData(signature: string, args: unknown[]): string {
  const { argTypes } = parseSignature(signature);
  if (args.length !== argTypes.length) {
    throw new Error(`expected ${argTypes.length} args, got ${args.length}`);
  }
  let encoded = selector(signature).slice(2);
  for (let i = 0; i < args.length; i++) {
    encoded += encodeArg(argTypes[i], args[i]);
  }
  return "0x" + encoded;
}

// -----------------------------------------------------------------------
// Decoding
// -----------------------------------------------------------------------

function decodeWord(hex: string, offset: number, type: AbiType): unknown {
  const word = hex.slice(offset, offset + 64);
  switch (type) {
    case "address": return "0x" + word.slice(24);
    case "bool":    return BigInt("0x" + word) !== 0n;
    case "uint8":
    case "uint16":
    case "uint256": return BigInt("0x" + word);
    case "bytes32": return "0x" + word;
  }
}

/**
 * Decode an `eth_call` return value into a tuple of typed values. `returnTypes`
 * is the ordered list of static types the call returns. Returns the values in
 * the same order. Reverts are surfaced as the empty string `0x` by upstream
 * providers; callers should check for that before decoding.
 */
export function decodeReturn(returnHex: string, returnTypes: AbiType[]): unknown[] {
  const clean = returnHex.startsWith("0x") ? returnHex.slice(2) : returnHex;
  if (returnTypes.length === 0) return [];
  if (clean.length < returnTypes.length * 64) {
    throw new Error(
      `return data too short: need ${returnTypes.length * 64} hex chars, got ${clean.length}`,
    );
  }
  const out: unknown[] = [];
  for (let i = 0; i < returnTypes.length; i++) {
    out.push(decodeWord(clean, i * 64, returnTypes[i]));
  }
  return out;
}

// -----------------------------------------------------------------------
// Higher-level helpers
// -----------------------------------------------------------------------

/**
 * Validate that an arbitrary string looks like a 20-byte EVM address.
 * Case-insensitive; does not enforce EIP-55 checksum.
 */
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Lower-case + 0x-prefix normalize an address (no checksum). */
export function normalizeAddress(value: string): string {
  if (!isAddress(value)) throw new Error(`invalid address: ${value}`);
  return value.toLowerCase();
}

// Re-export for callers that want to do their own hex work.
export { bytesToHex, hexToBytes };
