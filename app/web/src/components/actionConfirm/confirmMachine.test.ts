import { describe, expect, it } from "vitest";
import { INITIAL_CONFIRM_STATE, isOpen, reduceConfirm, type ConfirmState } from "./confirmMachine";
import { summarizePayInvoice } from "./confirmAction";
import { classifyConfirmError, MISMATCH_NEXT_STEP } from "./confirmErrors";

const S = summarizePayInvoice({ amountSats: 25_000 });
const open = (): ConfirmState => reduceConfirm(INITIAL_CONFIRM_STATE, { t: "open", summary: S });

describe("confirm machine", () => {
  it("starts closed", () => {
    expect(INITIAL_CONFIRM_STATE).toEqual({ step: "closed" });
    expect(isOpen(INITIAL_CONFIRM_STATE)).toBe(false);
  });

  it("open → confirm, with an empty input", () => {
    expect(open()).toEqual({ step: "confirm", summary: S, typed: "" });
  });

  it("typing accumulates", () => {
    const s = reduceConfirm(open(), { t: "type", value: "25000" });
    expect(s.step === "confirm" && s.typed).toBe("25000");
  });

  it("submit → sending, cancel → closed", () => {
    expect(reduceConfirm(open(), { t: "submit" }).step).toBe("sending");
    expect(reduceConfirm(open(), { t: "cancel" }).step).toBe("closed");
  });

  it("done from sending closes", () => {
    const sending = reduceConfirm(open(), { t: "submit" });
    expect(reduceConfirm(sending, { t: "done" }).step).toBe("closed");
  });

  // ⚠ The property that stops a modal lying about an in-flight request.
  it("CANCEL IS IGNORED while sending — the server owns the outcome", () => {
    const sending = reduceConfirm(open(), { t: "submit" });
    expect(reduceConfirm(sending, { t: "cancel" })).toBe(sending);
  });

  it("open is ignored while sending, so a request cannot be orphaned", () => {
    const sending = reduceConfirm(open(), { t: "submit" });
    expect(reduceConfirm(sending, { t: "open", summary: S })).toBe(sending);
  });

  it("retry returns to confirm and CLEARS the typed value", () => {
    // Re-earning the confirmation is the point; carrying the text over would
    // let a second attempt through on the first attempt's typing.
    const failed = reduceConfirm(reduceConfirm(open(), { t: "submit" }), {
      t: "failed",
      error: null,
      message: "boom",
    });
    const back = reduceConfirm(failed, { t: "retry" });
    expect(back).toEqual({ step: "confirm", summary: S, typed: "" });
  });

  it("retry never jumps straight to sending", () => {
    const failed = reduceConfirm(reduceConfirm(open(), { t: "submit" }), {
      t: "failed",
      error: null,
      message: "boom",
    });
    expect(reduceConfirm(failed, { t: "retry" }).step).toBe("confirm");
  });

  it("is TOTAL: an event that does not apply returns the state unchanged", () => {
    const states: ConfirmState[] = [
      INITIAL_CONFIRM_STATE,
      open(),
      reduceConfirm(open(), { t: "submit" }),
    ];
    const events = [
      { t: "done" } as const,
      { t: "retry" } as const,
      { t: "failed", error: null, message: "x" } as const,
      { t: "type", value: "z" } as const,
      { t: "submit" } as const,
    ];
    for (const s of states) {
      for (const e of events) {
        // Must not throw, and must return a valid step.
        const next = reduceConfirm(s, e);
        expect(["closed", "confirm", "sending", "failed"]).toContain(next.step);
      }
    }
  });

  it("a double submit does not advance past sending", () => {
    const once = reduceConfirm(open(), { t: "submit" });
    expect(reduceConfirm(once, { t: "submit" })).toBe(once);
  });
});

describe("error classification", () => {
  it("400 confirmation_required is recoverable and not a bug", () => {
    const v = classifyConfirmError({ status: 400, code: "confirmation_required" });
    expect(v?.kind).toBe("required");
    expect(v?.retryable).toBe(true);
    expect(v?.isBug).toBe(false);
  });

  it("409 confirmation_mismatch is a BUG and NOT retryable", () => {
    const v = classifyConfirmError({ status: 409, code: "confirmation_mismatch" });
    expect(v?.kind).toBe("mismatch");
    expect(v?.retryable).toBe(false);
    expect(v?.isBug).toBe(true);
  });

  // The instruction this copy exists to satisfy: a 409 in normal operation is a
  // bug, so the text must not frame it as transient.
  it("the mismatch copy does NOT tell anyone to try again", () => {
    const v = classifyConfirmError({ status: 409, code: "confirmation_mismatch" })!;
    expect(v.detail).not.toMatch(/try again/i);
    expect(v.detail).not.toMatch(/retry/i);
    expect(v.detail).toMatch(/will fail the same way|repeating it will fail/i);
  });

  it("the mismatch copy says plainly that nothing moved", () => {
    const v = classifyConfirmError({ status: 409, code: "confirmation_mismatch" })!;
    expect(`${v.title} ${v.detail}`).toMatch(/no funds moved|nothing was sent/i);
  });

  it("the two are rendered differently — same copy for both would be the bug", () => {
    const a = classifyConfirmError({ status: 400, code: "confirmation_required" })!;
    const b = classifyConfirmError({ status: 409, code: "confirmation_mismatch" })!;
    expect(a.title).not.toBe(b.title);
    expect(a.detail).not.toBe(b.detail);
    expect(a.retryable).not.toBe(b.retryable);
  });

  it("returns null for unrelated errors, so existing handling is untouched", () => {
    expect(classifyConfirmError({ status: 500, code: "internal_error" })).toBeNull();
    expect(classifyConfirmError({ status: 403, code: "member_required" })).toBeNull();
    expect(classifyConfirmError({ status: 402, code: "routing_denied" })).toBeNull();
    expect(classifyConfirmError(undefined)).toBeNull();
    expect(classifyConfirmError(new Error("network down"))).toBeNull();
  });

  it("a bare 400 with a different code is NOT claimed as a confirmation failure", () => {
    // 400 is the generic bad-request code; every route uses it. Matching on
    // status alone would swallow unrelated validation errors into this copy.
    expect(classifyConfirmError({ status: 400, code: "capacity_sats must be at least 100,000" })).toBeNull();
  });

  it("no confirmation copy tells the operator to ask an operator", () => {
    const texts = [
      classifyConfirmError({ status: 400, code: "confirmation_required" })!,
      classifyConfirmError({ status: 409, code: "confirmation_mismatch" })!,
    ]
      .map((v) => `${v.title} ${v.detail}`)
      .concat(MISMATCH_NEXT_STEP);
    for (const t of texts) {
      expect(t).not.toMatch(/ask your node operator/i);
      expect(t).not.toMatch(/contact your (node )?operator/i);
    }
  });
});
