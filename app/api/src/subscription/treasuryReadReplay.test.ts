// Pins scripts/treasury-read.sh check 3's replay rule to computeNewPaidThrough
// (recredit-check ruling O5 (a), spec §8). The script runs only by hand, on the
// treasury; no CI job runs scripts/. This test lives in app/api/src so
// pr-checks runs it, and it reads the SCRIPT'S OWN TEXT — the block between
// the REPLAY RULE markers — so an edit to the script that changes the rule
// fails here.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { computeNewPaidThrough } from "./paymentMath";

const DAY = 86_400_000;
const SCRIPT = path.resolve(__dirname, "../../../../scripts/treasury-read.sh");

type Row = {
  kind: "onchain" | "admin_override";
  received_at: number;
  confirmed_at: number | null;
  period_extension_days: number;
};
type Member = { created_at: number };

function loadReplayRule(): {
  creditTime: (r: Row) => number;
  replay: (m: Member, rs: Row[]) => number;
} {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const start = text.indexOf("// >>> REPLAY RULE");
  const end = text.indexOf("// <<< REPLAY RULE <<<");
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`REPLAY RULE markers not found in ${SCRIPT}`);
  }
  const block = text.slice(text.indexOf("\n", start) + 1, end);
  // eslint-disable-next-line no-new-func
  return new Function("DAY", `${block}\nreturn { creditTime, replay };`)(DAY);
}

/** What the detector does: fold computeNewPaidThrough in processing (id) order. */
function detectorFold(m: Member, rs: Row[]): number {
  return rs.reduce(
    (pt, r) =>
      computeNewPaidThrough(
        pt,
        r.period_extension_days,
        r.kind === "onchain" ? (r.confirmed_at as number) : r.received_at,
      ),
    m.created_at,
  );
}

const T = Date.UTC(2026, 10, 1);

// A fixture ledger in id order, covering every branch the rule must agree on.
const FIXTURE: Array<{ name: string; member: Member; rows: Row[] }> = [
  {
    name: "a pre-release row (confirmed_at = received_at), lapsed → reset",
    member: { created_at: T - 10 * DAY },
    rows: [{ kind: "onchain", received_at: T, confirmed_at: T, period_extension_days: 30 }],
  },
  {
    name: "a REPLAYED row: received_at days after confirmed_at — must fold from confirmed_at",
    member: { created_at: T - 10 * DAY },
    rows: [{ kind: "onchain", received_at: T + 3 * DAY, confirmed_at: T, period_extension_days: 30 }],
  },
  {
    name: "paid up at T_conf → stack, though detection came after paid_through",
    member: { created_at: T },
    rows: [
      { kind: "onchain", received_at: T + 60_000, confirmed_at: T, period_extension_days: 30 },
      { kind: "onchain", received_at: T + 31 * DAY, confirmed_at: T + 29 * DAY, period_extension_days: 30 },
    ],
  },
  {
    name: "the boundary: T_conf exactly equal to paid_through stacks",
    member: { created_at: T },
    rows: [
      { kind: "onchain", received_at: T, confirmed_at: T, period_extension_days: 30 },
      { kind: "onchain", received_at: T + 30 * DAY + 5_000, confirmed_at: T + 30 * DAY, period_extension_days: 30 },
    ],
  },
  {
    name: "the rescan residual: a lower T_conf processed later (id order, not time order)",
    member: { created_at: T - DAY },
    rows: [
      { kind: "onchain", received_at: T + 12 * DAY, confirmed_at: T + 12 * DAY, period_extension_days: 5 },
      { kind: "onchain", received_at: T + 12 * DAY + 1, confirmed_at: T + 10 * DAY, period_extension_days: 5 },
    ],
  },
  {
    name: "an admin_override row keeps received_at (founding credit / grandfather)",
    member: { created_at: T - 40 * DAY },
    rows: [
      { kind: "admin_override", received_at: T - 40 * DAY, confirmed_at: null, period_extension_days: 30 },
      { kind: "onchain", received_at: T + 2 * DAY, confirmed_at: T, period_extension_days: 30 },
    ],
  },
];

describe("scripts/treasury-read.sh check 3 — replay rule pinned to computeNewPaidThrough", () => {
  const { creditTime, replay } = loadReplayRule();

  for (const { name, member, rows } of FIXTURE) {
    it(name, () => {
      expect(replay(member, rows)).toBe(detectorFold(member, rows));
    });
  }

  it("on-chain rows replay from confirmed_at; admin_override rows from received_at", () => {
    expect(creditTime({ kind: "onchain", received_at: 2, confirmed_at: 1, period_extension_days: 0 })).toBe(1);
    expect(creditTime({ kind: "admin_override", received_at: 2, confirmed_at: null, period_extension_days: 0 })).toBe(2);
  });

  it("control: the old received_at rule DISAGREES on the replayed fixture (the pin can fail)", () => {
    const oldReplay = (m: Member, rs: Row[]) =>
      rs.reduce((pt, r) => Math.max(pt, r.received_at) + r.period_extension_days * DAY, m.created_at);
    const replayed = FIXTURE[1];
    expect(oldReplay(replayed.member, replayed.rows)).not.toBe(detectorFold(replayed.member, replayed.rows));
  });
});
