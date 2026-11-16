// Test-only fake chain for the subscription detector's confirmation-time
// lookups (recredit-check spec §4, §9). Builds REAL 80-byte block headers, so
// the hash a test hands out is the double-SHA256 of the bytes it serves and the
// detector's parse of nTime (bytes 68–71, little-endian) is exercised for real.
//
// Not a test file (no `.test.ts`), so vitest does not collect it.

import crypto from "crypto";

export interface FakeBlock {
  height: number;
  /** Block hash, display order (reversed double-SHA256 of the header). */
  hash: string;
  /** Raw 80-byte header, hex. */
  header: string;
  /** nTime × 1000. Callers pass a whole-second time, so this equals it. */
  timeMs: number;
}

export function makeBlock(height: number, timeMs: number): FakeBlock {
  if (timeMs % 1000 !== 0) throw new Error("fakeChain: block time must be whole seconds");
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0); // version
  // prev hash (4..35) and merkle root (36..67) left zero, but the merkle root
  // carries the height so two blocks at the same time still hash differently.
  h.writeUInt32LE(height, 36);
  h.writeUInt32LE(timeMs / 1000, 68); // nTime
  h.writeUInt32LE(0x207fffff, 72); // bits (regtest)
  h.writeUInt32LE(height, 76); // nonce
  const hash = Buffer.from(
    crypto.createHash("sha256").update(crypto.createHash("sha256").update(h).digest()).digest(),
  )
    .reverse()
    .toString("hex");
  return { height, hash, header: h.toString("hex"), timeMs };
}

/** A whole-second ms timestamp at or before `ms`. */
export function wholeSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}
