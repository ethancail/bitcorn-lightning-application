// On-chain destination address validation for swap flows (BIP-173 / BIP-350).
//
// Scope (decided 2026-07-08): bech32/bech32m ONLY — segwit v0 (P2WPKH/P2WSH)
// and v1 (P2TR). Legacy base58 (1…/3…) is deliberately rejected: LND generates
// bech32 addresses, and every legitimate destination in the swap flows is
// either LND-generated or a modern wallet address. The HRP must match the
// node's configured network (bcrt matters for Polar regtest).
//
// Checksum validation is the point — it catches the single-character typo in a
// hand-entered custom destination that format regexes cannot.

import { bech32, bech32m } from "bech32";

const HRP_BY_NETWORK: Record<string, string> = {
  mainnet: "bc",
  testnet: "tb",
  signet: "tb",
  regtest: "bcrt",
};

export type AddressValidation = { ok: true } | { ok: false; detail: string };

export function validateOnchainAddress(address: string, network: string): AddressValidation {
  const expectedHrp = HRP_BY_NETWORK[network] ?? "bc";

  let decoded: { prefix: string; words: number[] };
  let encoding: "bech32" | "bech32m";
  try {
    decoded = bech32.decode(address, 90);
    encoding = "bech32";
  } catch {
    try {
      decoded = bech32m.decode(address, 90);
      encoding = "bech32m";
    } catch {
      return { ok: false, detail: "not a valid bech32/bech32m address (bad format or checksum)" };
    }
  }

  if (decoded.prefix !== expectedHrp) {
    return {
      ok: false,
      detail: `address is for the wrong network (expected ${expectedHrp}1…, got ${decoded.prefix}1…)`,
    };
  }

  if (decoded.words.length === 0) {
    return { ok: false, detail: "address has no witness version" };
  }
  const [version, ...dataWords] = decoded.words;
  let program: number[];
  try {
    program = bech32.fromWords(dataWords);
  } catch {
    return { ok: false, detail: "invalid witness program padding" };
  }

  // BIP-173: witness v0 uses bech32, program must be 20 (P2WPKH) or 32 (P2WSH)
  // bytes. BIP-350: witness v1 (P2TR) uses bech32m, program must be 32 bytes.
  if (version === 0) {
    if (encoding !== "bech32") {
      return { ok: false, detail: "witness v0 addresses must use bech32 encoding" };
    }
    if (program.length !== 20 && program.length !== 32) {
      return { ok: false, detail: `witness v0 program must be 20 or 32 bytes (got ${program.length})` };
    }
    return { ok: true };
  }
  if (version === 1) {
    if (encoding !== "bech32m") {
      return { ok: false, detail: "witness v1 (taproot) addresses must use bech32m encoding" };
    }
    if (program.length !== 32) {
      return { ok: false, detail: `taproot program must be 32 bytes (got ${program.length})` };
    }
    return { ok: true };
  }
  return { ok: false, detail: `unsupported witness version ${version}` };
}
