// Pure state machine for the capital-action confirmation modal.
//
//   idle ──open──▶ confirm ──submit──▶ sending ─┬─done────▶ closed
//                     │                          └─failed──▶ failed
//                     └──cancel──▶ closed
//
// `cancel` from `sending` is IGNORED, deliberately: once the request is away the
// server owns the outcome and a modal that closes mid-flight tells the operator
// the action was abandoned when it may well have succeeded. Same reasoning as
// payModalMachine.ts, which refuses `back` from its own sending step.
//
// Total: an event that does not apply to the current step returns the state
// unchanged rather than throwing, so a double-click cannot wedge the UI.

import type { ActionSummary } from "./confirmAction";
import type { ConfirmErrorView } from "./confirmErrors";

export type ConfirmState =
  | { step: "closed" }
  | { step: "confirm"; summary: ActionSummary; typed: string }
  | { step: "sending"; summary: ActionSummary }
  | { step: "failed"; summary: ActionSummary; error: ConfirmErrorView | null; message: string };

export type ConfirmEvent =
  | { t: "open"; summary: ActionSummary }
  | { t: "type"; value: string }
  | { t: "submit" }
  | { t: "done" }
  | { t: "failed"; error: ConfirmErrorView | null; message: string }
  | { t: "retry" }
  | { t: "cancel" };

export const INITIAL_CONFIRM_STATE: ConfirmState = { step: "closed" };

export function reduceConfirm(state: ConfirmState, event: ConfirmEvent): ConfirmState {
  switch (event.t) {
    case "open":
      // Opening over an in-flight send would orphan the request.
      if (state.step === "sending") return state;
      return { step: "confirm", summary: event.summary, typed: "" };

    case "type":
      if (state.step !== "confirm") return state;
      return { ...state, typed: event.value };

    case "submit":
      // The CALLER checks challengeSatisfied before dispatching this. The
      // machine does not re-check, because it would need the challenge logic
      // and then there would be two places deciding the same thing.
      if (state.step !== "confirm") return state;
      return { step: "sending", summary: state.summary };

    case "done":
      if (state.step !== "sending") return state;
      return { step: "closed" };

    case "failed":
      if (state.step !== "sending") return state;
      return { step: "failed", summary: state.summary, error: event.error, message: event.message };

    case "retry":
      // Only from a failure, and only back to the typed challenge — never
      // straight to sending. A retry re-earns the confirmation.
      if (state.step !== "failed") return state;
      return { step: "confirm", summary: state.summary, typed: "" };

    case "cancel":
      if (state.step === "sending") return state;
      return { step: "closed" };
  }
}

/** True when the modal should be on screen. */
export function isOpen(state: ConfirmState): boolean {
  return state.step !== "closed";
}
