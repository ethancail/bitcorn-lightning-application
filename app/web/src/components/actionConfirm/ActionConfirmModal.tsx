// The confirmation step for a capital action.
//
// A thin renderer over confirmMachine.ts / confirmAction.ts / confirmErrors.ts —
// no logic here that a test cannot reach without a DOM. Classes match the
// existing dialog idiom (PayFromNodeModal.tsx).
//
// This REPLACES window.confirm() for actions that move funds. The three
// remaining confirm() sites (StrategyTab, CoinbaseCard, DayForm) guard config
// changes and a row delete, not outflows, and are left alone.
//
// What it adds over window.confirm():
//   · states what is about to happen, in the operator's terms
//   · requires typing the amount, so a mis-click cannot proceed
//   · distinguishes a 400 from a 409, and does not tell anyone to retry a bug

import { useReducer } from "react";
import {
  challengePrompt,
  challengeSatisfied,
  type ActionSummary,
} from "./confirmAction";
import {
  INITIAL_CONFIRM_STATE,
  reduceConfirm,
  type ConfirmEvent,
  type ConfirmState,
} from "./confirmMachine";
import { classifyConfirmError, MISMATCH_NEXT_STEP } from "./confirmErrors";

export interface ActionConfirmController {
  state: ConfirmState;
  /** Show the modal for an action. */
  open: (summary: ActionSummary) => void;
  /** Run the action once the operator has confirmed. */
  run: (perform: () => Promise<unknown>) => Promise<void>;
  dispatch: (e: ConfirmEvent) => void;
}

/**
 * Hook owning one modal's state.
 *
 * `run` is where the request happens, so the failure classification lives in one
 * place rather than in each page's catch block.
 */
export function useActionConfirm(): ActionConfirmController {
  const [state, dispatch] = useReducer(reduceConfirm, INITIAL_CONFIRM_STATE);

  async function run(perform: () => Promise<unknown>): Promise<void> {
    dispatch({ t: "submit" });
    try {
      await perform();
      dispatch({ t: "done" });
    } catch (e: unknown) {
      const err = e as { message?: string };
      dispatch({
        t: "failed",
        error: classifyConfirmError(e),
        message: err?.message ?? "The action failed.",
      });
    }
  }

  return {
    state,
    open: (summary) => dispatch({ t: "open", summary }),
    run,
    dispatch,
  };
}

export default function ActionConfirmModal({
  controller,
  onConfirm,
}: {
  controller: ActionConfirmController;
  /** Performs the request. Called only after the challenge is satisfied. */
  onConfirm: () => Promise<unknown>;
}) {
  const { state, dispatch, run } = controller;
  if (state.step === "closed") return null;

  const summary: ActionSummary = state.summary;
  const typed = state.step === "confirm" ? state.typed : "";
  const ready = state.step === "confirm" && challengeSatisfied(summary.challenge, typed);

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={summary.title}
    >
      <div className="dialog-card">
        <div className="dialog-title">{summary.title}</div>

        {/* What is about to happen. Always rendered, including while sending
            and after a failure — removing it at the moment something went
            wrong is exactly when the operator most needs to see it. */}
        <div className="dialog-body">
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", margin: 0 }}>
            {summary.rows.map((r) => (
              <div key={r.label} style={{ display: "contents" }}>
                <dt style={{ opacity: 0.7 }}>{r.label}</dt>
                <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>

          {summary.irreversible && (
            <p style={{ marginTop: 12, marginBottom: 0, opacity: 0.85 }}>{summary.irreversible}</p>
          )}
        </div>

        {/* ── Typed challenge ── */}
        {state.step === "confirm" && (
          <div style={{ marginTop: 14 }}>
            <label htmlFor="action-confirm-challenge" style={{ display: "block", marginBottom: 6 }}>
              {challengePrompt(summary.challenge)}
            </label>
            <input
              id="action-confirm-challenge"
              type="text"
              inputMode={summary.challenge.kind === "amount" ? "numeric" : "text"}
              autoComplete="off"
              autoFocus
              value={typed}
              onChange={(e) => dispatch({ t: "type", value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) void run(onConfirm);
                if (e.key === "Escape") dispatch({ t: "cancel" });
              }}
              style={{ width: "100%", fontVariantNumeric: "tabular-nums" }}
            />
          </div>
        )}

        {/* ── Failure ── */}
        {state.step === "failed" && (
          <div
            className="dialog-body"
            role="alert"
            style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 12 }}
          >
            <strong>{state.error?.title ?? "The action failed"}</strong>
            <p style={{ margin: "6px 0 0" }}>{state.error?.detail ?? state.message}</p>
            {state.error?.kind === "mismatch" && (
              <p style={{ margin: "6px 0 0", opacity: 0.85 }}>{MISMATCH_NEXT_STEP}</p>
            )}
          </div>
        )}

        {/* ── Actions ── */}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          {state.step === "confirm" && (
            <>
              <button
                className="btn btn-primary"
                disabled={!ready}
                onClick={() => void run(onConfirm)}
                style={{ flex: 1 }}
              >
                {summary.confirmLabel}
              </button>
              <button className="btn btn-outline" onClick={() => dispatch({ t: "cancel" })}>
                Cancel
              </button>
            </>
          )}

          {state.step === "sending" && (
            // No cancel: the request is away and the server owns the outcome.
            <button className="btn btn-primary" disabled style={{ flex: 1 }}>
              Sending…
            </button>
          )}

          {state.step === "failed" && (
            <>
              {/* A mismatch is deterministic — offering "Try again" would send
                  the operator round a loop that cannot terminate. */}
              {state.error?.retryable !== false && (
                <button className="btn btn-primary" onClick={() => dispatch({ t: "retry" })} style={{ flex: 1 }}>
                  Try again
                </button>
              )}
              <button
                className="btn btn-outline"
                onClick={() => dispatch({ t: "cancel" })}
                style={state.error?.retryable === false ? { flex: 1 } : undefined}
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
