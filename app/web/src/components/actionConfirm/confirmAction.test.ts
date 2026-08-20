import { describe, expect, it } from "vitest";
import {
  challengePrompt,
  challengeSatisfied,
  challengeTarget,
  summarizeApproveLiquidity,
  summarizeCloseChannel,
  summarizeLoopIn,
  summarizeLoopOut,
  summarizeOpenMemberChannel,
  summarizePayInvoice,
  summarizeTreasuryOpenChannel,
  truncId,
  type ActionSummary,
} from "./confirmAction";

const ALL: Array<[string, ActionSummary]> = [
  ["openMemberChannel", summarizeOpenMemberChannel({ capacitySats: 1_000_000 })],
  [
    "treasuryOpenChannel",
    summarizeTreasuryOpenChannel({ peerPubkey: "02b759b1552f6471599420c9aa8b7fb52c0a343ecc", capacitySats: 2_000_000 }),
  ],
  ["closeChannel coop", summarizeCloseChannel({ channelId: "842391119757312" })],
  ["closeChannel force", summarizeCloseChannel({ channelId: "842391119757312", isForceClose: true })],
  ["payInvoice", summarizePayInvoice({ amountSats: 25_000, destination: "02abcdef1234567890" })],
  ["loopOut", summarizeLoopOut({ amountSats: 500_000, destinationAddress: "bc1qxyzqabc123" })],
  ["loopIn", summarizeLoopIn({ amountSats: 250_000 })],
  ["approveLiquidity", summarizeApproveLiquidity({ recommendationId: "rec-42", amountSats: 100_000 })],
  ["approveLiquidity no amount", summarizeApproveLiquidity({ recommendationId: "rec-42" })],
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
      } else {
        expect(challengePrompt(s.challenge)).toContain(s.challenge.text);
      }
    }
  });
});

describe("every summary is usable", () => {
  for (const [label, s] of ALL) {
    it(`${label}: has a title, at least one row and a confirm label`, () => {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.rows.length).toBeGreaterThan(0);
      expect(s.confirmLabel.length).toBeGreaterThan(0);
    });

    it(`${label}: every row has a non-empty value`, () => {
      for (const r of s.rows) expect(r.value, `${label} / ${r.label}`).not.toBe("");
    });
  }

  it("an amount-bearing action challenges on the AMOUNT, not a word", () => {
    // Ethan's requirement: type the amount where there is one.
    const withAmounts: ActionSummary[] = [
      summarizeOpenMemberChannel({ capacitySats: 1_000_000 }),
      summarizeTreasuryOpenChannel({ peerPubkey: "02ab", capacitySats: 2_000_000 }),
      summarizePayInvoice({ amountSats: 25_000 }),
      summarizeLoopOut({ amountSats: 500_000, destinationAddress: "bc1q" }),
      summarizeLoopIn({ amountSats: 250_000 }),
      summarizeApproveLiquidity({ recommendationId: "r", amountSats: 100_000 }),
    ];
    for (const s of withAmounts) expect(s.challenge.kind, s.title).toBe("amount");
  });

  it("and the amount challenged is the amount SHOWN", () => {
    // A challenge on a different number than the one on screen is unpassable.
    const s = summarizeLoopOut({ amountSats: 500_000, destinationAddress: "bc1qabc" });
    expect(s.challenge).toEqual({ kind: "amount", sats: 500_000 });
    expect(s.rows.find((r) => r.label === "Amount")?.value).toBe("500,000 sats");
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

  it("loop-out leads with the destination address, the field a mistake ruins", () => {
    const s = summarizeLoopOut({ amountSats: 1000, destinationAddress: "bc1qlongaddressvalue0000" });
    expect(s.rows.map((r) => r.label).slice(0, 2)).toEqual(["Amount", "To address"]);
    expect(s.irreversible).toMatch(/address/i);
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
      const text = [s.title, s.irreversible ?? "", s.confirmLabel, ...s.rows.map((r) => `${r.label} ${r.value}`)].join(" ");
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
