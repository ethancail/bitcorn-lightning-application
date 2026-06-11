// Pure state machine for the "I have BTC" payment modal.
//
// Source of truth: decisions/2026-06-11-subscription-panel-action-
// button-behaviors.md §2 (dual-path modal). Two paths from the chooser:
//
//   chooser ──choose:this-node──▶ confirm ──confirm──▶ sending ─┬─success─▶ success
//      │                                                        └─error───▶ error
//      └──choose:elsewhere──▶ bip21
//
// `back`/`reset` return to the chooser from any non-sending step (you
// can't cancel a send that's already in flight from the machine — the
// server lock is the authority). Kept pure and total: an event that
// doesn't apply to the current step returns the state unchanged.

export type PayModalState =
  | { step: "chooser" }
  | { step: "confirm" }
  | { step: "sending" }
  | { step: "success"; txid: string }
  | { step: "error"; message: string; code?: string }
  | { step: "bip21" };

export type PayModalEvent =
  | { t: "choose"; path: "this-node" | "elsewhere" }
  | { t: "confirm" }
  | { t: "success"; txid: string }
  | { t: "error"; message: string; code?: string }
  | { t: "back" }
  | { t: "reset" };

export const INITIAL_PAY_MODAL_STATE: PayModalState = { step: "chooser" };

export function reducePayModal(
  state: PayModalState,
  event: PayModalEvent,
): PayModalState {
  switch (event.t) {
    case "choose":
      // Only meaningful from the chooser.
      if (state.step !== "chooser") return state;
      return event.path === "this-node" ? { step: "confirm" } : { step: "bip21" };

    case "confirm":
      // Arm the send only from the preview/confirm step.
      if (state.step !== "confirm") return state;
      return { step: "sending" };

    case "success":
      if (state.step !== "sending") return state;
      return { step: "success", txid: event.txid };

    case "error":
      if (state.step !== "sending") return state;
      return { step: "error", message: event.message, code: event.code };

    case "back":
      // Return to the chooser from any step except an in-flight send.
      if (state.step === "sending") return state;
      return { step: "chooser" };

    case "reset":
      return INITIAL_PAY_MODAL_STATE;

    default:
      return state;
  }
}
