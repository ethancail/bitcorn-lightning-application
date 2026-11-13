// R50(4), ruled R59(1) [RELAYED — drive-mode arc chat, 2026-11-12]: the
// per-transfer fee limit is ONE dollar figure; the percent is removed from
// the code and the API. The API's half of this check, and the proofs that a
// stored percent changes nothing, are app/api/src/transfers/
// noFeePercent.test.ts. This is the web's half: nothing in app/web/src names
// the percent (the web has no migrations, so only this file is exempt).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = __dirname;
const PATTERN = /fee_limit_pct_bps|feeLimitPct|pct_bps/;
const SELF = relative(SRC, __filename);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("no fee percent in app/web/src (R59(1))", () => {
  it("no file names it", () => {
    const hits = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => rel !== SELF && PATTERN.test(readFileSync(join(SRC, rel), "utf8")));
    expect(hits).toEqual([]);
  });

  it("anti-vacuity: the scan reads the tree, and the pattern matches the column's name", () => {
    expect(walk(SRC).length).toBeGreaterThan(100);
    expect(PATTERN.test("fee_limit_pct_bps")).toBe(true);
    expect(walk(SRC).map((p) => relative(SRC, p))).toContain(join("api", "client.ts"));
  });
});
