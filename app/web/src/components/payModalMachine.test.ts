import { describe, it, expect } from "vitest";
import {
  INITIAL_PAY_MODAL_STATE,
  acksOf,
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

  // pay-from-node, 2026-11-05: the refusals the member can resolve.
  describe("the guard steps", () => {
    const marker = { created_at: 1, amount_sats: 50_000, txid: "abc" };
    const sending: PayModalState = { step: "sending" };

    it("repeat_unacknowledged → repeat_ack naming the earlier payment; acknowledging re-arms sending with repeat", () => {
      const s = reducePayModal(sending, { t: "refused_repeat", marker });
      expect(s).toEqual({ step: "repeat_ack", marker });
      const next = reducePayModal(s, { t: "ack_repeat" });
      expect(next.step).toBe("sending");
      expect(acksOf(next)).toEqual({ repeat: true, price: false });
    });

    it("price_above_acknowledged → price_ack with both prices; accepting re-arms sending with price", () => {
      const s = reducePayModal(sending, { t: "refused_price", previousPrice: 40_000, newPrice: 50_000 });
      expect(s).toEqual({ step: "price_ack", previousPrice: 40_000, newPrice: 50_000 });
      const next = reducePayModal(s, { t: "ack_price" });
      expect(next.step).toBe("sending");
      expect(acksOf(next)).toEqual({ repeat: false, price: true });
    });

    it("pay_target_changed → back to confirm, marked as changed", () => {
      expect(reducePayModal(sending, { t: "target_changed" })).toEqual({ step: "confirm", detailsChanged: true });
    });

    it("the acknowledgement events apply only on their own step", () => {
      const confirm: PayModalState = { step: "confirm" };
      expect(reducePayModal(confirm, { t: "ack_repeat" })).toBe(confirm);
      expect(reducePayModal(confirm, { t: "ack_price" })).toBe(confirm);
      expect(reducePayModal(confirm, { t: "refused_repeat", marker })).toBe(confirm);
    });
  });

  describe("ruling B: acknowledgements accumulate within one session; reopening starts clean", () => {
    it("repeat first, then price: the second send carries both", () => {
      let s: PayModalState = { step: "sending" };
      s = reducePayModal(s, { t: "refused_repeat", marker: { created_at: 1, amount_sats: 1, txid: null } });
      s = reducePayModal(s, { t: "ack_repeat" });
      s = reducePayModal(s, { t: "refused_price", previousPrice: 1, newPrice: 2 });
      s = reducePayModal(s, { t: "ack_price" });
      expect(s.step).toBe("sending");
      expect(acksOf(s)).toEqual({ repeat: true, price: true });
    });

    it("a retry after an error keeps the acknowledgements given", () => {
      let s: PayModalState = { step: "sending", acks: { repeat: true, price: false } };
      s = reducePayModal(s, { t: "error", message: "x" });
      s = reducePayModal(s, { t: "back" });
      s = reducePayModal(s, { t: "choose", path: "this-node" });
      s = reducePayModal(s, { t: "confirm" });
      expect(acksOf(s)).toEqual({ repeat: true, price: false });
    });

    it("changed details drop the price acknowledgement and keep the repeat one", () => {
      const s = reducePayModal({ step: "sending", acks: { repeat: true, price: true } }, { t: "target_changed" });
      expect(acksOf(s)).toEqual({ repeat: true, price: false });
    });

    it("a fresh machine (reopening the modal) and reset carry none", () => {
      expect(acksOf(INITIAL_PAY_MODAL_STATE)).toEqual({ repeat: false, price: false });
      expect(acksOf(reducePayModal({ step: "error", message: "x", acks: { repeat: true, price: true } }, { t: "reset" })))
        .toEqual({ repeat: false, price: false });
    });
  });
});
