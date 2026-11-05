// Pure state machine for the "I have BTC" payment modal.
//
// Source of truth: decisions/2026-06-11-subscription-panel-action-
// button-behaviors.md §2 (dual-path modal), and for the guard steps
// decisions/2026-11-05-pay-from-node-confirmation-by-echo-settlement-guard-
// and-price-ceiling.md with specs/2026-11-05-pay-from-node-spec.md §3.5, §4.
//
//   chooser ──choose:this-node──▶ confirm ──confirm──▶ sending ─┬─success────────▶ success
//      │                             ▲                         ├─error──────────▶ error
//      │                             └──────target_changed─────┤
//      │                                  repeat_ack ◀─refused_repeat─┤
//      │                                  price_ack  ◀─refused_price──┘
//      │                       repeat_ack ──ack_repeat──▶ sending
//      │                       price_ack  ──ack_price───▶ sending
//      └──choose:elsewhere──▶ bip21
//
// The server refuses a send it cannot make as shown, and each refusal the
// member can resolve becomes a step: an earlier payment not yet credited
// (repeat_ack), a price above the one last acknowledged (price_ack), or
// details that changed since the modal opened (back to confirm, marked).
//
// ACKNOWLEDGEMENTS ACCUMULATE within one modal session (ruled 2026-11-05):
// once the member says "send another payment" or accepts a new price, every
// later send from this modal carries it, so a send needing both meets
// repeat_ack and then price_ack, in the server's order. Only `reset` clears
// them; reopening the modal mounts a fresh machine and starts clean. A
// change of details drops the price acknowledgement, since the price it
// accepted may no longer be the one shown.
//
// `back`/`reset` return to the chooser from any non-sending step (you
// can't cancel a send that's already in flight from the machine — the
// server lock is the authority). Kept pure and total: an event that
// doesn't apply to the current step returns the state unchanged.

export interface PayModalAcks {
  repeat: boolean;
  price: boolean;
}

export const NO_ACKS: PayModalAcks = { repeat: false, price: false };

/** The earlier, uncredited payment the repeat step names. */
export interface PayModalMarker {
  created_at: number; // unix seconds
  amount_sats: number;
  txid: string | null;
}

export type PayModalState = (
  | { step: "chooser" }
  | { step: "confirm"; detailsChanged?: boolean }
  | { step: "sending" }
  | { step: "success"; txid: string }
  | { step: "error"; message: string; code?: string }
  | { step: "bip21" }
  | { step: "repeat_ack"; marker: PayModalMarker }
  | { step: "price_ack"; previousPrice: number | null; newPrice: number }
) & { acks?: PayModalAcks };

export type PayModalEvent =
  | { t: "choose"; path: "this-node" | "elsewhere" }
  | { t: "confirm" }
  | { t: "success"; txid: string }
  | { t: "error"; message: string; code?: string }
  | { t: "refused_repeat"; marker: PayModalMarker }
  | { t: "refused_price"; previousPrice: number | null; newPrice: number }
  | { t: "target_changed" }
  | { t: "ack_repeat" }
  | { t: "ack_price" }
  | { t: "back" }
  | { t: "reset" };

export const INITIAL_PAY_MODAL_STATE: PayModalState = { step: "chooser" };

/** The acknowledgements a state carries (none if it carries none). */
export function acksOf(state: PayModalState): PayModalAcks {
  return state.acks ?? NO_ACKS;
}

/** Attach the acknowledgements to the next state — only when one has been
 *  given, so a session with none keeps the plain step shapes. */
function carry(next: PayModalState, acks: PayModalAcks): PayModalState {
  return acks.repeat || acks.price ? { ...next, acks } : next;
}

export function reducePayModal(
  state: PayModalState,
  event: PayModalEvent,
): PayModalState {
  const acks = acksOf(state);
  switch (event.t) {
    case "choose":
      // Only meaningful from the chooser.
      if (state.step !== "chooser") return state;
      return carry(event.path === "this-node" ? { step: "confirm" } : { step: "bip21" }, acks);

    case "confirm":
      // Arm the send only from the preview/confirm step.
      if (state.step !== "confirm") return state;
      return carry({ step: "sending" }, acks);

    case "success":
      if (state.step !== "sending") return state;
      return carry({ step: "success", txid: event.txid }, acks);

    case "error":
      if (state.step !== "sending") return state;
      return carry({ step: "error", message: event.message, code: event.code }, acks);

    case "refused_repeat":
      if (state.step !== "sending") return state;
      return carry({ step: "repeat_ack", marker: event.marker }, acks);

    case "refused_price":
      if (state.step !== "sending") return state;
      return carry({ step: "price_ack", previousPrice: event.previousPrice, newPrice: event.newPrice }, acks);

    case "target_changed":
      if (state.step !== "sending") return state;
      return carry({ step: "confirm", detailsChanged: true }, { ...acks, price: false });

    case "ack_repeat":
      if (state.step !== "repeat_ack") return state;
      return carry({ step: "sending" }, { ...acks, repeat: true });

    case "ack_price":
      if (state.step !== "price_ack") return state;
      return carry({ step: "sending" }, { ...acks, price: true });

    case "back":
      // Return to the chooser from any step except an in-flight send.
      if (state.step === "sending") return state;
      return carry({ step: "chooser" }, acks);

    case "reset":
      return INITIAL_PAY_MODAL_STATE;

    default:
      return state;
  }
}
