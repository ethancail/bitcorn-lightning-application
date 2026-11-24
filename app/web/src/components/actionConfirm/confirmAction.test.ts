import { describe, expect, it } from "vitest";
import * as confirmActionModule from "./confirmAction";
import {
  challengePrompt,
  challengeSatisfied,
  challengeTarget,
  memberChallengePrompt,
  summarizeCloseChannel,
  summarizeLoopIn,
  summarizeLoopOut,
  summarizeOpenMemberChannel,
  summarizePayInvoice,
  summarizeTreasuryOpenChannel,
  truncId,
  type ActionSummary,
} from "./confirmAction";

/** Every word a member layout puts on screen (slice 5), for the copy guards. */
function memberWords(s: ActionSummary): string {
  const m = s.member;
  if (!m) return "";
  return [
    m.goesTo ?? "",
    m.finalLine.kind === "plain" ? m.finalLine.text : "Can't be undone",
    ...(m.rows ?? []).map((r) => `${r.label} ${r.value}`),
    ...m.details.rows.map((r) => ("value" in r ? `${r.label} ${r.value}` : r.label)),
    ...m.details.notes,
  ].join(" ");
}

const ALL: Array<[string, ActionSummary]> = [
  ["openMemberChannel", summarizeOpenMemberChannel({ capacitySats: 1_000_000, fee: { label: "Economy", rate: 1 }, rate: null })],
  [
    "treasuryOpenChannel",
    summarizeTreasuryOpenChannel({ peerPubkey: "02b759b1552f6471599420c9aa8b7fb52c0a343ecc", capacitySats: 2_000_000, fee: { label: "Economy", rate: 1 } }),
  ],
  ["closeChannel coop", summarizeCloseChannel({ channelId: "842391119757312" })],
  ["closeChannel force", summarizeCloseChannel({ channelId: "842391119757312", isForceClose: true })],
  ["payInvoice", summarizePayInvoice({ amountSats: 25_000, destination: "02abcdef1234567890" })],
  ["loopOut", summarizeLoopOut({ amountSats: 500_000, rate: null })],
  ["loopIn", summarizeLoopIn({ amountSats: 250_000, rate: null })],
];

describe("the typed challenge", () => {
  it("an amount challenge accepts the exact digits", () => {
    expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, "1000000")).toBe(true);
  });

  it("accepts the grouped forms an operator would copy off the screen", () => {
    for (const typed of ["1,000,000", "1 000 000", "1_000_000", " 1000000 "]) {
      expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, typed), typed).toBe(true);
    }
  });

  it("rejects a near-miss — one digit off is a different amount", () => {
    expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, "100000")).toBe(false);
    expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, "10000000")).toBe(false);
  });

  it("rejects non-numeric text on an amount challenge", () => {
    for (const typed of ["1e6", "1000000sats", "yes", "0x0f4240", "1.000.000"]) {
      expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, typed), typed).toBe(false);
    }
  });

  // ⚠ The same empty-collapse shape as sync.ts:15 and the server's comparison.
  it("EMPTY never satisfies, on either side", () => {
    expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, "")).toBe(false);
    expect(challengeSatisfied({ kind: "amount", sats: 1_000_000 }, "   ")).toBe(false);
    expect(challengeSatisfied({ kind: "phrase", text: "CLOSE" }, "")).toBe(false);
    // A challenge with an empty target must not be satisfiable by empty input.
    expect(challengeSatisfied({ kind: "phrase", text: "" }, "")).toBe(false);
  });

  it("a zero-amount challenge is not satisfied by empty input", () => {
    // 0 is a legitimate target string ("0") and must be TYPED, not skipped.
    expect(challengeSatisfied({ kind: "amount", sats: 0 }, "")).toBe(false);
    expect(challengeSatisfied({ kind: "amount", sats: 0 }, "0")).toBe(true);
  });

  it("a phrase challenge is case-insensitive but must be the whole word", () => {
    const c = { kind: "phrase", text: "CLOSE" } as const;
    expect(challengeSatisfied(c, "close")).toBe(true);
    expect(challengeSatisfied(c, " Close ")).toBe(true);
    expect(challengeSatisfied(c, "clos")).toBe(false);
    expect(challengeSatisfied(c, "closed")).toBe(false);
  });

  it("FORCE and CLOSE are different words, so one cannot confirm the other", () => {
    expect(challengeSatisfied({ kind: "phrase", text: "FORCE" }, "CLOSE")).toBe(false);
    expect(challengeSatisfied({ kind: "phrase", text: "CLOSE" }, "FORCE")).toBe(false);
  });

  it("the prompt names exactly what challengeTarget expects", () => {
    // Otherwise the operator is told to type one thing and checked against
    // another — a dead end with no error message that explains it.
    for (const [, s] of ALL) {
      const target = challengeTarget(s.challenge);
      expect(challengeSatisfied(s.challenge, target), `${s.title}: own target rejected`).toBe(true);
      if (s.challenge.kind === "amount") {
        // The prompt shows a grouped number; typing what is shown must work.
        const shown = challengePrompt(s.challenge).split(": ")[1];
        expect(challengeSatisfied(s.challenge, shown), `${s.title}: prompted form rejected`).toBe(true);
        // The member layout's prompt (slice 5) ends ": N" the same way.
        const memberShown = memberChallengePrompt(s.challenge).split(": ")[1];
        expect(challengeSatisfied(s.challenge, memberShown), `${s.title}: member prompt rejected`).toBe(true);
      } else {
        expect(challengePrompt(s.challenge)).toContain(s.challenge.text);
      }
    }
  });
});

describe("every summary is usable", () => {
  for (const [label, s] of ALL) {
    // A member-layout summary (slice 5) shows its member block instead of rows.
    it(`${label}: has a title, at least one row (or a member layout) and a confirm label`, () => {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.rows.length > 0 || s.member !== undefined).toBe(true);
      expect(s.confirmLabel.length).toBeGreaterThan(0);
    });

    it(`${label}: every row has a non-empty value`, () => {
      for (const r of s.rows) expect(r.value, `${label} / ${r.label}`).not.toBe("");
    });
  }

  it("an amount-bearing action challenges on the AMOUNT, not a word", () => {
    // Ethan's requirement: type the amount where there is one.
    const withAmounts: ActionSummary[] = [
      summarizeOpenMemberChannel({ capacitySats: 1_000_000, fee: { label: "Economy", rate: 1 }, rate: null }),
      summarizeTreasuryOpenChannel({ peerPubkey: "02ab", capacitySats: 2_000_000, fee: { label: "Economy", rate: 1 } }),
      summarizePayInvoice({ amountSats: 25_000 }),
      summarizeLoopOut({ amountSats: 500_000, rate: null }),
      summarizeLoopIn({ amountSats: 250_000, rate: null }),
    ];
    for (const s of withAmounts) expect(s.challenge.kind, s.title).toBe("amount");
  });

  it("and the amount challenged is the amount SHOWN", () => {
    // A challenge on a different number than the one on screen is unpassable.
    // Slice 5: Withdraw's amount is its member layout's big amount, not a row.
    const s = summarizeLoopOut({ amountSats: 500_000, rate: null });
    expect(s.challenge).toEqual({ kind: "amount", sats: 500_000 });
    expect(s.member?.amountSats).toBe(500_000);
    const pay = summarizePayInvoice({ amountSats: 25_000 });
    expect(pay.challenge).toEqual({ kind: "amount", sats: 25_000 });
    expect(pay.rows.find((r) => r.label === "Amount")?.value).toBe("25,000 sats");
  });

  it("a close has no amount leaving, so it challenges on a word instead", () => {
    expect(summarizeCloseChannel({ channelId: "1" }).challenge).toEqual({ kind: "phrase", text: "CLOSE" });
    expect(summarizeCloseChannel({ channelId: "1", isForceClose: true }).challenge).toEqual({
      kind: "phrase",
      text: "FORCE",
    });
  });

  it("a force close says what a force close costs, and a coop close does not", () => {
    const force = summarizeCloseChannel({ channelId: "1", isForceClose: true });
    const coop = summarizeCloseChannel({ channelId: "1" });
    expect(force.irreversible).toMatch(/timelock/i);
    expect(coop.irreversible).not.toMatch(/timelock/i);
    expect(force.title).not.toBe(coop.title);
  });

  // REWRITTEN for slice 5, ruling (2) (vault decisions/2026-11-23-member-first-
  // run-ui-slice-5-rulings-...): "Goes to: Your node's bitcoin wallet", with no
  // address row and no wrong-address sentence. This pin used to require both.
  // The address is the node's own (api.getNodeAddress), and the confirmation
  // hash is of the request body, which still carries it.
  it("Withdraw says where the money goes in words, with no address row and no wrong-address sentence", () => {
    const s = summarizeLoopOut({ amountSats: 1000, feeSats: 10, authorizedMaxSats: 20, rate: null });
    expect(s.member?.goesTo).toBe("Your node's bitcoin wallet");
    expect(s.rows).toEqual([]);
    expect(s.irreversible).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/address/i);
    expect(s.member?.finalLine).toEqual({ kind: "cant_undo" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ COPY RULE, ENFORCED. On a member node the farmer IS the operator, so
// "ask your node operator" routes them back to themselves. member/open-channel,
// swaps/loop-out and swaps/loop-in are all member-facing.
// ─────────────────────────────────────────────────────────────────────────────
describe("no copy tells the operator to ask an operator", () => {
  const BANNED = [/ask your node operator/i, /contact your (node )?operator/i, /ask the operator/i];

  it("no summary text matches the banned phrasings", () => {
    for (const [label, s] of ALL) {
      const text = [s.title, s.irreversible ?? "", s.confirmLabel, ...s.rows.map((r) => `${r.label} ${r.value}`), memberWords(s)].join(" ");
      for (const re of BANNED) expect(text, `${label} matched ${re}`).not.toMatch(re);
    }
  });

  it("the ban list itself matches the phrase it is meant to catch", () => {
    // Without this the regexes could all be wrong and every check above would
    // pass vacuously.
    expect(BANNED.some((re) => re.test("Please ask your node operator for help"))).toBe(true);
  });
});

describe("truncId", () => {
  it("keeps both ends checkable", () => {
    expect(truncId("0123456789abcdef0123456789abcdef")).toBe("01234567…89abcdef");
  });

  it("leaves short ids alone", () => {
    expect(truncId("842391119757312", 8)).toBe("842391119757312");
  });

  it("does not crash on empty input", () => {
    // fmtSats/truncPubkey have crashed on undefined here before (CLAUDE.md).
    expect(truncId("")).toBe("—");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loop-fee-ceilings §7 (F4): the confirmation shows the most the member
// authorises, and what happens to the on-chain fee once the swap has started.
// The figure is swap fee + miner fee + the two routing ceilings, the prepay
// EXCLUDED (P12 p, superseding ruling 11): Polar's L3 found the prepay to be an
// advance on the principal, not a fee. The 20% clause is Loop Out's only
// (ruling 5): the clamp is the Loop Out sweep's.
// ─────────────────────────────────────────────────────────────────────────────
describe("loop-fee-ceilings: the authorised maximum and the post-start disclosure", () => {
  // Through the namespace, so a missing helper fails on its value rather than
  // on an import error.
  const helpers = confirmActionModule as unknown as Record<string, ((...a: any[]) => any) | undefined>;

  const LO_CEILINGS = {
    max_swap_fee_sat: 835,
    max_prepay_amt_sat: 30_000,
    max_miner_fee_sat: 1_200,
    max_swap_routing_fee_sat: 2_500,
    max_prepay_routing_fee_sat: 300,
  };

  // Gate 1's Loop Out ceilings (spec §7, §10.1): 25 + 3,793 + 2,500 + 13 =
  // 6,331, with the 1,337 prepay left out. Written out, not computed by the
  // code under test.
  const GATE1_CEILINGS = {
    max_swap_fee_sat: 25,
    max_prepay_amt_sat: 1_337,
    max_miner_fee_sat: 3_793,
    max_swap_routing_fee_sat: 2_500,
    max_prepay_routing_fee_sat: 13,
  };

  it("p: Loop Out's maximum is swap + miner + the two routing ceilings, the prepay excluded", () => {
    expect(helpers.authorizedMaxSats?.(GATE1_CEILINGS)).toBe(6_331);
    expect(helpers.authorizedMaxSats?.(LO_CEILINGS)).toBe(4_835);
  });

  it("p: Loop In (no prepay) is swap + miner", () => {
    expect(helpers.authorizedMaxSats?.({ max_swap_fee_sat: 500, max_miner_fee_sat: 900 })).toBe(1_400);
  });

  it("no ceilings → no figure (never a 0 presented as a maximum)", () => {
    expect(helpers.authorizedMaxSats?.(null)).toBeUndefined();
  });

  // tt (spec §1.10, §13 item 56): Loop In's maximum lets the miner fee rise by
  // the margin the pre-initiation check allows, sent by the server as
  // miner_fee_margin_pct. Gate 1's Loop In values: 171 + ceil(3,875 × 150 / 100)
  // = 171 + ceil(5,812.5) = 171 + 5,813 = 5,984. Written out, not computed by
  // the code under test.
  const GATE1_LOOP_IN = { max_swap_fee_sat: 171, max_miner_fee_sat: 3_875 };

  it("tt: Loop In's maximum is swap + ceil(miner × (100 + margin) / 100)", () => {
    expect(helpers.authorizedMaxSats?.(GATE1_LOOP_IN, { mode: "loop_in", minerFeeMarginPct: 50 })).toBe(5_984);
  });

  it("tt: Loop In without the server's margin shows no maximum (never a guessed 50)", () => {
    const max = helpers.authorizedMaxSats?.(GATE1_LOOP_IN, { mode: "loop_in", minerFeeMarginPct: undefined });
    expect(max).toBeUndefined();
    const s = summarizeLoopIn({ amountSats: 250_000, feeSats: 4_046, authorizedMaxSats: max, rate: null });
    // Slice 5: the maximum is a Details row, "Most you allow in fees".
    expect(s.member!.details.rows.some((r) => /most you allow/i.test(r.label))).toBe(false);
  });

  it("tt guard: Loop Out's figure is unchanged", () => {
    expect(helpers.authorizedMaxSats?.(GATE1_CEILINGS)).toBe(6_331);
  });

  it("the Loop Out estimate is swap + miner, the one number the panel and the modal both show", () => {
    expect(
      helpers.loopOutEstimatedFeeSats?.({ swap_fee_sat: 835, prepay_sat: 30_000, miner_fee_sat: 1_200, total_fee_sat: 32_035 }),
    ).toBe(2_035);
  });

  it("Loop Out: shows the maximum and says the network fee follows the market, capped at 20%", () => {
    // Slice 5, ruling (2): the fee limit and the 20% rule sit under Details.
    const s = summarizeLoopOut({ amountSats: 250_000, feeSats: 2_035, authorizedMaxSats: 4_835, rate: null });
    expect(s.member!.details.rows).toEqual([{ label: "Most you allow in fees", sats: 4_835 }]);
    expect(s.member!.costSats).toBe(2_035);
    const notes = s.member!.details.notes.join(" ");
    expect(notes).toMatch(/follows the market/i);
    expect(notes).toMatch(/20% of the amount/);
  });

  it("Loop In: shows the maximum, says the network fee follows the market, and claims no 20% cap", () => {
    // Slice 5, ruling (3): the fee limit sits under Details.
    const s = summarizeLoopIn({ amountSats: 250_000, feeSats: 1_400, authorizedMaxSats: 1_400, rate: null });
    expect(s.member!.details.rows).toEqual([{ label: "Most you allow in fees", sats: 1_400 }]);
    const notes = s.member!.details.notes.join(" ");
    expect(notes).toMatch(/follows the market/i);
    expect(notes).not.toMatch(/20%/);
  });
});
