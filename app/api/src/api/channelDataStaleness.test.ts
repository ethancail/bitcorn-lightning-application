// Behaviour of the channel-data staleness classifier.
//
// The classifier is pure and clock-injected, so every case below is exact
// rather than timing-dependent. Thresholds come from base/staleness.ts:
// 5 min -> stale, 30 min -> very_stale.
//
// The pair that matters is FIRES vs DOES-NOT-FIRE. A staleness alert that
// cannot stay quiet is worse than none: it trains the operator to ignore the
// alerts surface, and the surface carries ONCHAIN_RESERVE_BREACHED.

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { channelDataStalenessAlert } from "./channelDataStaleness";

const NOW = 1_700_000_000_000;
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// (ii) DOES NOT FIRE — the legitimate cases. Listed first deliberately.
// ═══════════════════════════════════════════════════════════════════════════

describe("stays quiet when the data is trustworthy", () => {
  it("fresh rows produce no alert", () => {
    expect(
      channelDataStalenessAlert({
        latestChannelUpdatedAt: NOW - sec(15), // one sync tick ago
        channelRowCount: 4,
        nodeInfoUpdatedAt: NOW - sec(15),
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("does not fire one tick before the threshold", () => {
    // 4m59s. An off-by-one here would alarm on an ordinary slow tick.
    expect(
      channelDataStalenessAlert({
        latestChannelUpdatedAt: NOW - (min(5) - 1000),
        channelRowCount: 2,
        nodeInfoUpdatedAt: NOW - sec(10),
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("EMPTY TABLE + FRESH NODE INFO is genuinely-zero-channels, not staleness", () => {
    // The case that would otherwise false-positive on every freshly provisioned
    // treasury: sync completed, LND reported no channels, persist-channels.ts
    // deleted the rows, and the zeros the guardrail reads are CORRECT.
    expect(
      channelDataStalenessAlert({
        latestChannelUpdatedAt: null,
        channelRowCount: 0,
        nodeInfoUpdatedAt: NOW - sec(15),
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (i) FIRES — the violating cases
// ═══════════════════════════════════════════════════════════════════════════

describe("fires when the guardrail is reading data it should not trust", () => {
  it("stale rows produce a warning naming the permissive direction", () => {
    const a = channelDataStalenessAlert({
      latestChannelUpdatedAt: NOW - min(10),
      channelRowCount: 3,
      nodeInfoUpdatedAt: NOW - min(10),
      nowMs: NOW,
    });
    expect(a).not.toBeNull();
    expect(a!.type).toBe("CHANNEL_DATA_STALE");
    expect(a!.severity).toBe("warning");
    expect(a!.data.channel_data_age_seconds).toBe(600);
    expect(a!.data.guardrail_effect).toBe("permissive");
    // The alert must say it does NOT block, or an operator reads a warning on a
    // capital surface as "expansion is halted" and starts debugging a non-event.
    expect(a!.data.blocks_expansion).toBe(false);
    expect(a!.message).toContain("NOT blocked");
  });

  it("very stale rows escalate to critical", () => {
    const a = channelDataStalenessAlert({
      latestChannelUpdatedAt: NOW - min(45),
      channelRowCount: 3,
      nodeInfoUpdatedAt: NOW - min(45),
      nowMs: NOW,
    });
    expect(a!.severity).toBe("critical");
    expect(a!.data.channel_data_staleness).toBe("very_stale");
  });

  it("fires exactly AT the threshold", () => {
    const a = channelDataStalenessAlert({
      latestChannelUpdatedAt: NOW - min(5),
      channelRowCount: 1,
      nodeInfoUpdatedAt: NOW - sec(5),
      nowMs: NOW,
    });
    expect(a, "threshold is inclusive per classifyStaleness").not.toBeNull();
  });

  it("EMPTY TABLE + NO NODE INFO says never_synced and names both cases", () => {
    const a = channelDataStalenessAlert({
      latestChannelUpdatedAt: null,
      channelRowCount: 0,
      nodeInfoUpdatedAt: null,
      nowMs: NOW,
    });
    expect(a).not.toBeNull();
    expect(a!.severity).toBe("warning");
    expect(a!.message).toContain("never been synced");
    expect(a!.data.node_info_staleness).toBe("never_synced");
    // The payload states what it could NOT determine, rather than picking one.
    expect(a!.data.indistinguishable_cases).toEqual([
      "never_synced",
      "genuinely_zero_channels",
    ]);
    expect(a!.data.blocks_expansion).toBe(false);
  });

  it("EMPTY TABLE + STALE NODE INFO is critical and admits the ambiguity", () => {
    // Sync is behind AND there are no rows. Neither "no channels" nor "never
    // synced" can be ruled out, and the alert says exactly that.
    const a = channelDataStalenessAlert({
      latestChannelUpdatedAt: null,
      channelRowCount: 0,
      nodeInfoUpdatedAt: NOW - min(40),
      nowMs: NOW,
    });
    expect(a!.severity).toBe("critical");
    expect(a!.message).toContain('cannot distinguish');
    expect(a!.data.node_info_age_seconds).toBe(2400);
  });

  it("a null max with a nonzero row count is treated as the empty case", () => {
    // Defensive: the two db reads are separate statements, so a torn read is
    // possible in principle. It must not fall through to channelDataFreshness
    // with a null and be reported as a fresh zero.
    const a = channelDataStalenessAlert({
      latestChannelUpdatedAt: null,
      channelRowCount: 5,
      nodeInfoUpdatedAt: null,
      nowMs: NOW,
    });
    expect(a).not.toBeNull();
    expect(a!.data.node_info_staleness).toBe("never_synced");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ORDERING THIS CLASSIFIER SILENTLY DEPENDS ON
// ═══════════════════════════════════════════════════════════════════════════

describe("the sync ordering the empty-table discriminator rests on", () => {
  it("persistChannels() still runs BEFORE persistNodeInfo() in sync.ts", () => {
    // "Empty table + fresh node info = genuinely zero channels" is only sound
    // while a fresh lnd_node_info row implies a tick got PAST the channel write.
    // Reversing these two calls would make a never-synced node report as a
    // zero-channel node — a stale guardrail reading as healthy, which is the
    // exact failure this module exists to make loud. Asserted against the
    // source because there is no runtime signal that would catch it.
    //
    // ⚠ ANCHORED ON THE timer.time() LABELS, NOT ON THE BARE FUNCTION NAMES.
    // The first draft searched for "persistNodeInfo(" and matched the COMMENT
    // in deriveNodeRole above it, which put the "call" earlier in the file than
    // the real one and failed on correct code. That is the same comment-matching
    // defect action-confirmation.coverage.test.ts's header records discarding a
    // regex walk over. The label strings appear only at the call sites.
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "lightning", "sync.ts"),
      "utf8",
    );
    const channelsAt = src.indexOf('timer.time("persistChannels"');
    const nodeInfoAt = src.indexOf('timer.time("persistNodeInfo"');
    expect(channelsAt, "persistChannels call site not found in sync.ts").toBeGreaterThan(-1);
    expect(nodeInfoAt, "persistNodeInfo call site not found in sync.ts").toBeGreaterThan(-1);
    expect(
      channelsAt,
      "persistNodeInfo() now runs BEFORE persistChannels() — the empty-table " +
        "discriminator in channelDataStaleness.ts is no longer sound. A fresh " +
        "lnd_node_info row no longer proves the channel write happened.",
    ).toBeLessThan(nodeInfoAt);
  });
});
