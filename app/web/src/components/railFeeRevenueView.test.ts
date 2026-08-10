import { describe, expect, it } from "vitest";
import { deriveRailFeeView } from "./railFeeRevenueView";
import type { RailFeeRevenueResponse } from "../api/client";

// THE POINT OF THIS FILE: nothing has settled on the rail yet, so the treasury
// will see ZERO for days or weeks. The state that has to be provably correct is
// therefore not "renders a big number" — it is "zero, and we're confident"
// versus "we can't tell", and those two MUST NOT look the same. A panel where
// they do is worse than no panel: it teaches its reader to ignore it, and it
// finishes teaching that just as the number starts mattering.
//
// Same principle the rail's own staleness classifier already states
// (app/api/src/stablecoin/staleness.ts, classifyRailStaleness): "'Never synced'
// and 'synced, then went stale' are different facts and must render
// differently." This is that rule applied one layer up.

const ZERO = {
  fee_units_raw: "0",
  fee_human: "0.00",
  gross_units_raw: "0",
  gross_human: "0.00",
  settlement_count: 0,
};

const NONZERO = {
  fee_units_raw: "1234567",
  fee_human: "1.23",
  gross_units_raw: "493826800",
  gross_human: "493.82",
  settlement_count: 42,
};

function response(over: Partial<RailFeeRevenueResponse> = {}): RailFeeRevenueResponse {
  return {
    all_time: { ...ZERO },
    last_24h: { ...ZERO, from_block: 49_750_576, to_block: 49_793_776 },
    freshness: {
      last_synced_block_number: 49_793_776,
      last_success_at: 1_754_835_600_000,
      staleness_seconds: 41,
      staleness_label: "fresh",
    },
    basis: "delivered",
    fee_recipient_address: "0xc7a819847b3d2a4d48beb999709c6ff36bf362b7",
    currency: "USDC",
    decimals: 6,
    ...over,
  };
}

const freshness = (
  over: Partial<RailFeeRevenueResponse["freshness"]>,
): RailFeeRevenueResponse["freshness"] => ({
  last_synced_block_number: 49_793_776,
  last_success_at: 1_754_835_600_000,
  staleness_seconds: 41,
  staleness_label: "fresh",
  ...over,
});

describe("deriveRailFeeView — zero is not one state, it is three", () => {
  it("ZERO + FRESH cursor is a STATED zero (kind 'ok')", () => {
    const view = deriveRailFeeView(response(), null);
    expect(view.kind).toBe("ok");
  });

  it("ZERO + NEVER_SYNCED is NOT a stated zero — no number may be shown", () => {
    // The figure would be a fabrication: nothing was ever indexed, so "$0.00"
    // asserts something the node never looked at. This is the live treasury's
    // state on day one (PR #258 shipped; the node has not ticked yet), so it is
    // the first thing an operator will see.
    const view = deriveRailFeeView(
      response({ freshness: freshness({ last_success_at: 0, staleness_label: "never_synced" }) }),
      null,
    );
    expect(view.kind).toBe("never_synced");
  });

  it("ZERO + FRESH and ZERO + NEVER_SYNCED are DIFFERENT states", () => {
    // The assertion that actually protects the reader. The two above could each
    // pass while both returning the same thing if the mapping collapsed.
    const stated = deriveRailFeeView(response(), null);
    const unknown = deriveRailFeeView(
      response({ freshness: freshness({ last_success_at: 0, staleness_label: "never_synced" }) }),
      null,
    );
    expect(stated.kind).not.toBe(unknown.kind);
  });

  it("ZERO + STALE cursor is a DOUBTED zero, distinct from both", () => {
    const view = deriveRailFeeView(
      response({ freshness: freshness({ staleness_label: "stale", staleness_seconds: 600 }) }),
      null,
    );
    expect(view.kind).toBe("stale");
  });

  it("all three zero states are mutually distinct", () => {
    const kinds = [
      deriveRailFeeView(response(), null).kind,
      deriveRailFeeView(
        response({ freshness: freshness({ staleness_label: "stale" }) }),
        null,
      ).kind,
      deriveRailFeeView(
        response({ freshness: freshness({ last_success_at: 0, staleness_label: "never_synced" }) }),
        null,
      ).kind,
    ];
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("deriveRailFeeView — the remaining states", () => {
  it("NON-ZERO + fresh renders plainly", () => {
    const view = deriveRailFeeView(response({ all_time: { ...NONZERO } }), null);
    expect(view.kind).toBe("ok");
  });

  it("NON-ZERO + stale keeps the figure but marks it", () => {
    const view = deriveRailFeeView(
      response({
        all_time: { ...NONZERO },
        freshness: freshness({ staleness_label: "very_stale", staleness_seconds: 1800 }),
      }),
      null,
    );
    expect(view.kind).toBe("stale");
    if (view.kind === "stale") expect(view.data.all_time.fee_human).toBe("1.23");
  });

  it("fetch failure AFTER a success keeps the last-good data", () => {
    // U24 rule (components/ErrorState.tsx): never let a fetch failure collapse
    // into an empty value that renders as "no revenue".
    const prior = response({ all_time: { ...NONZERO } });
    const view = deriveRailFeeView(null, prior);
    expect(view.kind).toBe("stale");
    if (view.kind === "stale") expect(view.data.all_time.fee_human).toBe("1.23");
  });

  it("fetch failure with NO prior data is an error, never a zero", () => {
    const view = deriveRailFeeView(null, null);
    expect(view.kind).toBe("error");
  });

  it("ERROR and NEVER_SYNCED are different states — status is not failure", () => {
    // ADDITION 3's acceptance criterion, asserted rather than left to styling.
    // never_synced is a STATUS ("indexing hasn't run yet"); error is a FAILURE
    // ("we couldn't reach the API"). On day one the operator sees the former,
    // and it must not look like something broke.
    const neverSynced = deriveRailFeeView(
      response({ freshness: freshness({ last_success_at: 0, staleness_label: "never_synced" }) }),
      null,
    );
    const failed = deriveRailFeeView(null, null);
    expect(neverSynced.kind).toBe("never_synced");
    expect(failed.kind).toBe("error");
    expect(neverSynced.kind).not.toBe(failed.kind);
  });

  it("never_synced wins over prior data — it is not a staleness degree", () => {
    // A node that somehow holds prior data but reports never_synced is
    // reporting an inconsistency; trust the cursor, show no figure.
    const view = deriveRailFeeView(
      response({ freshness: freshness({ last_success_at: 0, staleness_label: "never_synced" }) }),
      response({ all_time: { ...NONZERO } }),
    );
    expect(view.kind).toBe("never_synced");
  });
});

describe("deriveRailFeeView — a payload missing its freshness block", () => {
  it("degrades to can't-tell rather than crashing or stating a zero", () => {
    // Found by negative control 3 (2026-08-10): removing `freshness` from the
    // payload made the derivation throw a TypeError, which would take the panel
    // down during an API/bundle version skew. Fail-closed was satisfied; fail
    // GRACEFULLY was not. A number without its confidence is not renderable, so
    // the honest degradation is the same state as never_synced.
    const noFreshness = { ...response(), freshness: undefined } as unknown as RailFeeRevenueResponse;
    expect(() => deriveRailFeeView(noFreshness, null)).not.toThrow();
    expect(deriveRailFeeView(noFreshness, null).kind).toBe("never_synced");
  });

  it("still degrades even when prior data exists — never states a stale figure", () => {
    const noFreshness = { ...response(), freshness: undefined } as unknown as RailFeeRevenueResponse;
    const prior = response();
    expect(deriveRailFeeView(noFreshness, prior).kind).toBe("never_synced");
  });
});
