import { describe, it, expect } from "vitest";
import {
  INITIAL_PAY_MODAL_STATE,
  reducePayModal,
  type PayModalState,
} from "./payModalMachine";

describe("payModalMachine", () => {
  it("starts at the chooser (modal can be opened)", () => {
    expect(INITIAL_PAY_MODAL_STATE).toEqual({ step: "chooser" });
  });

  describe("this-node path", () => {
    it("chooser → confirm → sending → success", () => {
      let s: PayModalState = INITIAL_PAY_MODAL_STATE;
      s = reducePayModal(s, { t: "choose", path: "this-node" });
      expect(s.step).toBe("confirm");
      s = reducePayModal(s, { t: "confirm" });
      expect(s.step).toBe("sending");
      s = reducePayModal(s, { t: "success", txid: "abc123" });
      expect(s).toEqual({ step: "success", txid: "abc123" });
    });

    it("sending → error carries message + code", () => {
      let s: PayModalState = { step: "sending" };
      s = reducePayModal(s, { t: "error", message: "Not enough funds", code: "insufficient_funds" });
      expect(s).toEqual({ step: "error", message: "Not enough funds", code: "insufficient_funds" });
    });
  });

  describe("elsewhere path", () => {
    it("chooser → bip21", () => {
      const s = reducePayModal(INITIAL_PAY_MODAL_STATE, { t: "choose", path: "elsewhere" });
      expect(s.step).toBe("bip21");
    });
  });

  describe("guards (total + pure)", () => {
    it("ignores choose outside the chooser", () => {
      const confirm: PayModalState = { step: "confirm" };
      expect(reducePayModal(confirm, { t: "choose", path: "elsewhere" })).toBe(confirm);
    });

    it("ignores confirm unless on the confirm step", () => {
      const chooser: PayModalState = { step: "chooser" };
      expect(reducePayModal(chooser, { t: "confirm" })).toBe(chooser);
    });

    it("ignores success/error unless sending", () => {
      const confirm: PayModalState = { step: "confirm" };
      expect(reducePayModal(confirm, { t: "success", txid: "x" })).toBe(confirm);
      expect(reducePayModal(confirm, { t: "error", message: "x" })).toBe(confirm);
    });

    it("back returns to chooser from any step except sending", () => {
      expect(reducePayModal({ step: "confirm" }, { t: "back" })).toEqual({ step: "chooser" });
      expect(reducePayModal({ step: "bip21" }, { t: "back" })).toEqual({ step: "chooser" });
      expect(reducePayModal({ step: "error", message: "x" }, { t: "back" })).toEqual({ step: "chooser" });
      // Cannot abandon an in-flight send from the machine.
      const sending: PayModalState = { step: "sending" };
      expect(reducePayModal(sending, { t: "back" })).toBe(sending);
    });

    it("reset always returns to the initial chooser", () => {
      expect(reducePayModal({ step: "success", txid: "x" }, { t: "reset" })).toEqual(INITIAL_PAY_MODAL_STATE);
    });
  });
});
