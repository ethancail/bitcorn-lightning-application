// The public-alias outcome classifier — spec 2026-09-24-public-alias-refresh
// §4, §11.2. Table-driven: every row states what a lookup settled with and the
// one outcome it must classify as.
//
// ⚠ THE REAL-ALIAS ROWS ARE THE ANTI-VACUITY HALF. A classifier that returns
// `none_announced` for everything passes every "is not a name" row below. The
// rows that must come back `alias` — including a 20-hex string that is SOME
// OTHER node's default — are what make the forbidding rows mean something.

import { describe, expect, it } from "vitest";
import { classifyNodeLookup, type NodeAliasOutcome, type NodeLookupSettled } from "./publicAliasOutcome";

const PK = "02" + "d4".repeat(32);
const OTHER = "03" + "e5".repeat(32);
const DEFAULT = PK.slice(0, 20); // LND's default alias for PK, lowercase hex
const PLACEHOLDER = `${PK.slice(0, 8)}…${PK.slice(-6)}`;

const ok = (alias: unknown): NodeLookupSettled => ({ ok: true, alias });
const err = (error: unknown): NodeLookupSettled => ({ ok: false, error });

const CASES: ReadonlyArray<[string, string, NodeLookupSettled, NodeAliasOutcome]> = [
  // ── alias: the permitting rows ──
  ["a real alias", PK, ok("Lazy H Farms"), { outcome: "alias", alias: "Lazy H Farms" }],
  ["a real alias, trimmed", PK, ok("  Lazy H Farms  "), { outcome: "alias", alias: "Lazy H Farms" }],
  ["ANOTHER node's 20-hex default is not THIS node's default", PK, ok(OTHER.slice(0, 20)), { outcome: "alias", alias: OTHER.slice(0, 20) }],
  ["equality only: the default plus a suffix is an alias", PK, ok(`${DEFAULT}x`), { outcome: "alias", alias: `${DEFAULT}x` }],

  // ── none_announced: empty, or a pubkey-derived form ──
  ["empty alias", PK, ok(""), { outcome: "none_announced" }],
  ["whitespace-only alias", PK, ok("   "), { outcome: "none_announced" }],
  ["missing alias field", PK, ok(undefined), { outcome: "none_announced" }],
  ["LND's 20-hex default", PK, ok(DEFAULT), { outcome: "none_announced" }],
  ["the 20-hex default, uppercase", PK, ok(DEFAULT.toUpperCase()), { outcome: "none_announced" }],
  ["the 20-hex default, padded", PK, ok(` ${DEFAULT} `), { outcome: "none_announced" }],
  ["the 20-hex default against an UPPERCASE pubkey", PK.toUpperCase(), ok(DEFAULT), { outcome: "none_announced" }],
  ["the old 8…6 placeholder", PK, ok(PLACEHOLDER), { outcome: "none_announced" }],
  ["the placeholder against an UPPERCASE pubkey", PK.toUpperCase(), ok(PLACEHOLDER), { outcome: "none_announced" }],

  // ── not_in_graph: BOTH elements of ln-service's 404 ──
  ["[404, 'NodeIsUnknown']", PK, err([404, "NodeIsUnknown"]), { outcome: "not_in_graph" }],

  // ── failed, with a code and no LND free text ──
  ["a 404 with another name is not 'not in graph'", PK, err([404, "SomethingElse"]), { outcome: "failed", code: "404:SomethingElse" }],
  ["NodeIsUnknown under another status is not 'not in graph'", PK, err([503, "NodeIsUnknown"]), { outcome: "failed", code: "503:NodeIsUnknown" }],
  [
    "503 FailedToRetrieveNodeDetails — LND's detail is dropped",
    PK,
    err([503, "FailedToRetrieveNodeDetails", { err: { details: "connection reset by peer" } }]),
    { outcome: "failed", code: "503:FailedToRetrieveNodeDetails" },
  ],
  ["withDeadline's ETIMEDOUT", PK, err(new Error("ETIMEDOUT: nodeAlias:getNode exceeded 10000ms deadline")), { outcome: "failed", code: "ETIMEDOUT" }],
  ["getLndClient throwing (LND files missing)", PK, err(new Error("LND files not available: missing TLS cert")), { outcome: "failed", code: "exception" }],
  ["a non-Error throw", PK, err("boom"), { outcome: "failed", code: "exception" }],
];

describe("classifyNodeLookup — spec §4", () => {
  for (const [label, pubkey, settled, expected] of CASES) {
    it(label, () => {
      expect(classifyNodeLookup(pubkey, settled)).toEqual(expected);
    });
  }

  it("the table exercises all four outcomes", () => {
    // Keeps the table honest: dropping every row of one outcome would leave
    // that outcome's branch unpinned while the suite stays green.
    const seen = new Set(CASES.map(([, , , e]) => e.outcome));
    expect(seen).toEqual(new Set(["alias", "none_announced", "not_in_graph", "failed"]));
  });
});
