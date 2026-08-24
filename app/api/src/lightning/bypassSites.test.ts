// Every raw ln-service call site is accounted for: bounded, or deliberately held.
//
// ─── THE FAILURE THIS GUARDS ────────────────────────────────────────────────
//
// Most LND calls go through an lnd.ts wrapper, so bounding the wrappers covers
// them. Eight do not: they take `{ lnd }` straight off getLndClient() and call
// ln-service directly, skipping the wrapper layer entirely. Bounding only the
// wrappers therefore looks complete and leaves eight holes — and the holes are
// invisible in the wrapper diff, because nothing about lnd.ts mentions them.
//
// Seven are bounded. One — payViaPaymentRequest in pay.ts — is held, for the
// outcome-ambiguity reason in HELD_UNBOUNDED_CALLS.
//
// ⚠ THIS TEST IS A CENSUS, NOT A PATTERN MATCH. It fails if a NEW raw
// ln-service importer appears anywhere under src/, not merely if one of the
// known eight regresses. That is the property worth holding: the next call site
// added off getLndClient() should have to make a deliberate decision about its
// deadline rather than silently inherit "unbounded".

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

/** Files importing ln-service directly, relative to src/. */
function lnServiceImporters(): string[] {
  return walk(SRC)
    .filter((f) => /from\s+["']ln-service["']/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
    .sort();
}

// lnd.ts is the wrapper layer itself — its ln-service calls ARE the wrappers,
// covered by lnd.deadlines.test.ts and heldCalls.test.ts.
const WRAPPER_LAYER = "lightning/lnd.ts";

/** The bypass files and how many bounded / held raw calls each should hold. */
const EXPECTED_BYPASS: Record<string, { bounded: number; held: number }> = {
  "index.ts": { bounded: 2, held: 0 }, // /api/pay decode, sync-peers getNode
  "lightning/fees.ts": { bounded: 3, held: 0 }, // 2x updateRoutingFees, getChannels
  "lightning/network-payments.ts": { bounded: 2, held: 0 }, // 2x decodePaymentRequest
  "lightning/pay.ts": { bounded: 0, held: 1 }, // payViaPaymentRequest — HELD
};

describe("raw ln-service call sites", () => {
  it("the set of files importing ln-service directly is exactly the known set", () => {
    // The census. A new importer fails here and forces a deadline decision.
    expect(lnServiceImporters()).toEqual(
      [WRAPPER_LAYER, ...Object.keys(EXPECTED_BYPASS)].sort(),
    );
  });

  for (const [rel, counts] of Object.entries(EXPECTED_BYPASS)) {
    it(`${rel} binds ${counts.bounded} deadline(s) of its own`, () => {
      const src = fs.readFileSync(path.join(SRC, rel), "utf8");
      const found = (src.match(/withDeadline\(/g) ?? []).length;
      expect(
        found,
        `${rel} should carry ${counts.bounded} withDeadline call(s) for its raw ` +
          `ln-service sites; found ${found}. A raw site with no deadline does ` +
          `NOT inherit one from the lnd.ts wrappers.`,
      ).toBe(counts.bounded);
    });
  }

  it("pay.ts is the only bypass file with a held call, and binds nothing", () => {
    const src = fs.readFileSync(path.join(SRC, "lightning/pay.ts"), "utf8");
    expect(src).toContain("payViaPaymentRequest(");
    expect(src).not.toContain("withDeadline(");
    // The decision is recorded where a reader meets the call, not only in the
    // registry — a comment is closer to a mechanism than a list to remember.
    expect(src).toMatch(/HELD/);
  });
});
