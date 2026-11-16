// The confirmation time of a subscription deposit output (recredit-check,
// bitcorn-research specs/2026-11-13-recredit-check-credit-from-confirmation-
// time-spec.md §3–§4, ruling O2 as amended).
//
// T_conf = nTime of the header of the block that confirmed the paying
// transaction, × 1000. A chain fact: a DB restore that replays an output
// recomputes the same T_conf, which is what makes the replay reproduce the
// original credit (spec §5).
//
// The source, as ruled (O2 (A)):
//   1. the tip, from getWalletInfo — used ONLY to size a height window;
//   2. getChainTransactions in that window — used ONLY as a txid → (block hash,
//      height) lookup. No amount and no address is read from it, so the
//      per-output problem detector.ts's header describes does not return;
//   3. the confirming block's header BY HASH, nTime at bytes 68–71 (LE);
//      getBlock by hash as the fallback, reading the block's first 80 bytes;
//   4. a process-lifetime `block hash → nTime ms` cache.
//
// ⚠ NEVER the transaction entry's own `created_at`: that is when the wallet
// learned of the transaction, which moves with LND's state (a rescan, a
// restore) and would defeat the point (spec §4.2).
//
// ⚠ NO FALLBACK TO THE DETECTION TIME (ruling O3). A lookup that fails returns
// `ok: false` with a cause; the detector skips the output this tick and
// retries next tick.

import crypto from "crypto";
import {
  getLndInfo,
  getLndChainTransactionsAfter,
  getLndBlockHeader,
  getLndBlock,
} from "../lightning/lnd";

/**
 * Blocks of slack below the lowest candidate's confirming height. Absorbs a
 * tip that moved between getUtxos and getWalletInfo; a miss is LOUD (the
 * transaction is reported absent and the output retried next tick), never an
 * off-by-one on the time, because the block is named by hash, not height.
 */
export const WINDOW_SLACK_BLOCKS = 6;

export type ConfirmationTime =
  | { ok: true; height: number; blockHash: string; timeMs: number }
  | { ok: false; cause: string; height: number | null };

const blockTimeMsByHash = new Map<string, number>();

function sha256(b: Buffer): Buffer {
  return crypto.createHash("sha256").update(b).digest();
}

function message(err: unknown): string {
  return (err as any)?.message ?? String(err);
}

/**
 * nTime × 1000 from a raw header — or from a raw block, whose first 80 bytes
 * are its header. The 80 bytes must hash to `blockHash`, so a wrong slice or a
 * different serialization cannot yield a plausible but wrong time.
 */
export function blockTimeMsFromHeader(rawHex: string, blockHash: string): number {
  const header = Buffer.from(rawHex.slice(0, 160), "hex");
  if (header.length !== 80) {
    throw new Error(`expected an 80-byte header, got ${header.length} bytes`);
  }
  const hash = Buffer.from(sha256(sha256(header))).reverse().toString("hex");
  if (hash !== blockHash.toLowerCase()) {
    throw new Error(`header hashes to ${hash}, not ${blockHash}`);
  }
  return header.readUInt32LE(68) * 1000;
}

async function blockTimeMs(blockHash: string): Promise<number> {
  const cached = blockTimeMsByHash.get(blockHash);
  if (cached !== undefined) return cached;

  let timeMs: number;
  try {
    const { header } = await getLndBlockHeader(blockHash);
    timeMs = blockTimeMsFromHeader(header, blockHash);
  } catch (headerErr) {
    try {
      const { block } = await getLndBlock(blockHash);
      timeMs = blockTimeMsFromHeader(block, blockHash);
    } catch (blockErr) {
      throw new Error(
        `header call failed (${message(headerErr)}); getBlock fallback failed (${message(blockErr)})`,
      );
    }
  }
  blockTimeMsByHash.set(blockHash, timeMs);
  return timeMs;
}

/**
 * Resolves T_conf and the confirming height for each candidate's transaction.
 * Every lookup completes before this returns, so the detector writes nothing
 * until all of a tick's times are known. Never throws: a failure becomes an
 * `ok: false` entry for each transaction it affects.
 */
export async function resolveConfirmationTimes(
  candidates: ReadonlyArray<{ txid: string; confirmation_count: number }>,
): Promise<Map<string, ConfirmationTime>> {
  const out = new Map<string, ConfirmationTime>();
  const txids = [...new Set(candidates.map((c) => c.txid))].sort();
  if (txids.length === 0) return out;

  const failAll = (cause: string) => {
    for (const txid of txids) out.set(txid, { ok: false, cause, height: null });
    return out;
  };

  let tip: number | null | undefined;
  try {
    ({ block_height: tip } = await getLndInfo());
  } catch (err) {
    return failAll(`chain tip read failed: ${message(err)}`);
  }
  if (typeof tip !== "number") return failAll("LND reported no block height");

  const maxConfirmations = Math.max(...candidates.map((c) => c.confirmation_count));
  const afterHeight = tip - maxConfirmations - WINDOW_SLACK_BLOCKS;

  let transactions: Awaited<ReturnType<typeof getLndChainTransactionsAfter>>["transactions"];
  try {
    ({ transactions } = await getLndChainTransactionsAfter(afterHeight));
  } catch (err) {
    return failAll(`chain transactions above height ${afterHeight} failed: ${message(err)}`);
  }
  const byId = new Map(transactions.map((t) => [t.id, t]));

  for (const txid of txids) {
    const tx = byId.get(txid);
    if (!tx) {
      out.set(txid, {
        ok: false,
        cause: `transaction not in LND's chain transactions above height ${afterHeight}`,
        height: null,
      });
      continue;
    }
    if (!tx.block_id || typeof tx.confirmation_height !== "number") {
      out.set(txid, { ok: false, cause: "LND reports no confirming block for the transaction", height: null });
      continue;
    }
    try {
      const timeMs = await blockTimeMs(tx.block_id);
      out.set(txid, { ok: true, height: tx.confirmation_height, blockHash: tx.block_id, timeMs });
    } catch (err) {
      out.set(txid, {
        ok: false,
        cause: `block ${tx.block_id} time unavailable: ${message(err)}`,
        height: tx.confirmation_height,
      });
    }
  }
  return out;
}
