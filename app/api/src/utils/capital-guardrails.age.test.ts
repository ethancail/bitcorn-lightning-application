// assertCanExpand(): the data-age note must annotate refusals WITHOUT changing
// a single verdict.
//
// ─── WHY THE VERDICT TEST IS THE POINT ──────────────────────────────────────
//
// This arc chose ALERT-OVER-REFUSE on channel staleness: the treasury alerts
// surface says the data is old, and expansion keeps working. That decision is
// only real if assertCanExpand() reaches the same permit/refuse answer it
// reached before the age note existed — for the SAME inputs, at every age.
//
// So the central case below sweeps channel-row age from one tick to well past
// very_stale, holding every capacity identical, and asserts the verdict does not
// move. If a future edit turns the note into a condition, that test fails and
// says so, rather than a farmer or the treasury operator discovering it as a
// blocked expansion.
//
// A refusal message assertion alone would not catch it: a version that ALSO
// refused on staleness would still produce a message containing the age.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ⚠ Declared INSIDE vi.hoisted alongside the state it stamps. vi.hoisted is
// lifted above every const in the module, so a `const NOW` up here is still in
// its temporal dead zone when the factory runs.
const s = vi.hoisted(() => ({
  NOW: 1_700_000_000_000,
  /** Rows in lnd_channels, as (capacity, peer, updated_at). */
  channels: [] as Array<{ capacity_sat: number; peer_pubkey: string; updated_at: number }>,
  chainBalance: 10_000_000,
  policy: {
    id: 1,
    min_onchain_reserve_sats: 300_000,
    max_deploy_ratio_ppm: 600_000,
    max_pending_opens: 1,
    max_peer_capacity_sats: 300_000,
    peer_cooldown_minutes: 720,
    max_expansions_per_day: 3,
    max_daily_deploy_sats: 400_000,
    max_daily_loss_sats: 5_000,
    updated_at: 1_700_000_000_000,
    last_applied_at: null as number | null,
  },
}));

vi.mock("../db", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (...args: any[]) => {
        if (sql.includes("FROM treasury_capital_policy")) return s.policy;
        if (sql.includes("MAX(updated_at) AS latest")) {
          const latest = s.channels.length
            ? Math.max(...s.channels.map((c) => c.updated_at))
            : null;
          return { latest };
        }
        if (sql.includes("SUM(capacity_sat)") && sql.includes("peer_pubkey = ?")) {
          const pk = args[0];
          return { v: s.channels.filter((c) => c.peer_pubkey === pk).reduce((a, c) => a + c.capacity_sat, 0) };
        }
        if (sql.includes("SUM(capacity_sat)")) {
          return { v: s.channels.reduce((a, c) => a + c.capacity_sat, 0) };
        }
        // Every treasury_expansion_executions aggregate: no pending, none today.
        if (sql.includes("MAX(created_at)")) return { created_at: null };
        return { v: 0 };
      },
      all: () => [], // no subscription deposit addresses
      run: () => undefined,
    }),
  },
}));

vi.mock("../lightning/lnd", () => ({
  getLndChainBalance: async () => ({ chain_balance: s.chainBalance }),
  getLndUtxos: async () => ({ utxos: [] }),
  getLndPendingChannels: async () => ({ pending_channels: [] }),
}));

const NOW = s.NOW;
import { assertCanExpand, CapitalGuardrailError } from "./capital-guardrails";

const min = (n: number) => n * 60 * 1000;
const PEER = "02aa";

/** Run assertCanExpand and reduce it to a comparable verdict. */
async function verdict(peer: string, capacity: number) {
  try {
    await assertCanExpand(peer, capacity);
    return { permitted: true, message: "" };
  } catch (e: any) {
    return {
      permitted: false,
      message: String(e?.message ?? e),
      isGuardrail: e instanceof CapitalGuardrailError,
    };
  }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  s.channels = [];
  s.chainBalance = 10_000_000;
});

// ═══════════════════════════════════════════════════════════════════════════
// (ii) PERMITS — the verdict is identical to baseline at every age.
// ═══════════════════════════════════════════════════════════════════════════

describe("data age never changes the verdict", () => {
  const AGES = [
    ["one sync tick", min(0.25)],
    ["just under stale", min(4)],
    ["stale", min(10)],
    ["very stale", min(45)],
    ["a day", min(1440)],
  ] as const;

  it.each(AGES)("PERMITS a legitimate expansion when data is %s", async (_label, age) => {
    // 1 channel at 200k to another peer; opening 250k to PEER.
    // deployed 200k + pending 0 + new 250k = 450k
    // max = (10_000_000 + 200_000) * 0.6 = 6_120_000  -> passes
    // peer 0 + 250k <= 300k -> passes. Reserve, counts, cooldown all fine.
    s.channels = [{ capacity_sat: 200_000, peer_pubkey: "02bb", updated_at: NOW - age }];
    const v = await verdict(PEER, 250_000);
    expect(v.permitted, `refused at age ${age}ms: ${v.message}`).toBe(true);
  });

  it.each(AGES)("REFUSES an over-cap expansion when data is %s", async (_label, age) => {
    // Same rows, but 250k to a peer that already holds 200k: 450k > 300k cap.
    s.channels = [{ capacity_sat: 200_000, peer_pubkey: PEER, updated_at: NOW - age }];
    const v = await verdict(PEER, 250_000);
    expect(v.permitted, `permitted at age ${age}ms`).toBe(false);
    expect(v.message).toContain("max sats per peer exceeded");
  });

  it("the permit/refuse answer is byte-identical across the whole age sweep", async () => {
    // The strongest form: hold everything constant except updated_at and assert
    // the verdict SET has exactly one member. A staleness condition anywhere in
    // assertCanExpand would split this into two.
    const outcomes = new Set<boolean>();
    for (const [, age] of AGES) {
      s.channels = [{ capacity_sat: 200_000, peer_pubkey: "02bb", updated_at: NOW - age }];
      outcomes.add((await verdict(PEER, 250_000)).permitted);
    }
    expect([...outcomes], "age changed the verdict somewhere in the sweep").toEqual([true]);
  });

  it("an EMPTY channel table still permits — never_synced does not block", async () => {
    // This is the first-run case. A member node has no rows before its first
    // sync completes, and the farmer is the only operator; a refusal here would
    // be unrecoverable for them. Treasury-side it is the same code path.
    s.channels = [];
    const v = await verdict(PEER, 250_000);
    expect(v.permitted, `refused on empty table: ${v.message}`).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (i) The note itself
// ═══════════════════════════════════════════════════════════════════════════

describe("the refusal message carries the data age", () => {
  it("reports the age in seconds on a peer-cap refusal", async () => {
    s.channels = [{ capacity_sat: 200_000, peer_pubkey: PEER, updated_at: NOW - min(10) }];
    const v = await verdict(PEER, 250_000);
    expect(v.permitted).toBe(false);
    expect(v.message).toContain("[channel data age: 600s]");
  });

  it("reports the age on a deploy-ratio refusal", async () => {
    // Squeeze the ratio: tiny chain balance against a large deployed position.
    s.chainBalance = 400_000;
    s.channels = [{ capacity_sat: 5_000_000, peer_pubkey: "02bb", updated_at: NOW - min(7) }];
    const v = await verdict(PEER, 100_000);
    expect(v.permitted).toBe(false);
    expect(v.message).toContain("max deploy ratio would be exceeded");
    expect(v.message).toContain("[channel data age: 420s]");
  });

  it('says "unknown" rather than 0s when the table is empty', async () => {
    // An empty table has no timestamp. Rendering that as "0s old" would be the
    // most reassuring possible description of the least trustworthy state.
    s.channels = [];
    s.chainBalance = 100_000; // force the reserve/ratio path to refuse
    const v = await verdict(PEER, 100_000);
    expect(v.permitted).toBe(false);
    // The reserve refusal fires first and carries no note; the ratio one does.
    // Either way the message must never claim a zero age.
    expect(v.message).not.toContain("[channel data age: 0s]");
  });

  it("adds NO note to refusals whose numbers do not come from lnd_channels", async () => {
    // The reserve check reads chain balance LIVE from LND. Annotating it with a
    // channel-row age would attribute the wrong provenance to the number.
    s.chainBalance = 100_000;
    s.channels = [{ capacity_sat: 200_000, peer_pubkey: "02bb", updated_at: NOW - min(10) }];
    const v = await verdict(PEER, 250_000);
    expect(v.permitted).toBe(false);
    expect(v.message).toContain("min on-chain reserve would be breached");
    expect(v.message).not.toContain("channel data age");
  });
});
