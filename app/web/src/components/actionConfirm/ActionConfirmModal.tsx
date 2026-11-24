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
//
// Rendered through a portal to document.body (ruling ll). Inline, it sat inside
// the page's `.panel.fade-in`: `.fade-in` leaves `transform: translateY(0)` on
// the panel, which makes the panel the containing block for the fixed overlay,
// and `.panel { overflow: hidden }` then cut off the card's title and buttons
// (Polar gate 1, L5). The card is capped at the viewport and only its middle
// scrolls, so the title and the buttons stay on screen at any content height.

import { Children, useReducer, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  MEMBER_DIALOG_COPY as COPY,
  challengePrompt,
  challengeSatisfied,
  memberChallengePrompt,
  type ActionSummary,
  type MemberLayout,
} from "./confirmAction";
import { Amount, usableUsd } from "../amount/Amount";
import { inlineAmount } from "../amount/inlineAmount";
import { CantUndoIcon } from "./CantUndoIcon";
import {
  INITIAL_CONFIRM_STATE,
  reduceConfirm,
  type ConfirmEvent,
  type ConfirmState,
} from "./confirmMachine";
import { classifyConfirmError, MISMATCH_NEXT_STEP } from "./confirmErrors";

/**
 * Returned by an onConfirm that sent nothing because it re-showed the modal
 * (fee-estimates O6: a stale estimate was refreshed). `run` then leaves the
 * modal as the action set it, instead of closing it as done.
 */
export const RESHOWN = Symbol("reshown");

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
      const result = await perform();
      if (result === RESHOWN) return;
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

// ─── The member layout (slice 5; opt-in through `summary.member`) ──────────
// When `on` is false each helper renders its children and nothing else, so a
// summary without `member` gets the DOM it always had.

/** The "sats" label inside the typed-amount field. */
function SatsUnit({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <div className="action-confirm-sats">
      {children}
      <span className="action-confirm-sats-unit" aria-hidden="true">{COPY.satsUnit}</span>
    </div>
  );
}

/** The buttons in source order (main first), or with the main one last. */
function MainLast({ on, children }: { on: boolean; children: ReactNode }) {
  return <>{on ? Children.toArray(children).reverse() : children}</>;
}

function MemberRows({ rows, usd }: { rows: MemberLayout["details"]["rows"]; usd: number | null }) {
  return (
    <dl className="action-confirm-rows">
      {rows.map((r) => (
        <div key={r.label} className="action-confirm-row">
          <dt>{r.label}</dt>
          <dd className={"ident" in r && r.ident ? "ident" : undefined}>
            {"sats" in r ? inlineAmount(r.sats, usd) : r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MemberSummary({ m }: { m: MemberLayout }) {
  const usd = usableUsd(m.rate);
  const { rows, notes } = m.details;
  return (
    <div className="action-confirm-member">
      <div className="action-confirm-amount">
        <Amount sats={m.amountSats} rate={m.rate} size="hero" />
      </div>
      {m.costSats !== undefined && (
        <p className="action-confirm-line">
          <span className="text-dim">{COPY.cost}</span> {inlineAmount(m.costSats, usd, true)}
        </p>
      )}
      {m.goesTo && (
        <p className="action-confirm-line">
          <span className="text-dim">{COPY.goesTo}</span> {m.goesTo}
        </p>
      )}
      {m.rows && m.rows.length > 0 && <MemberRows rows={m.rows} usd={usd} />}
      {m.finalLine.kind === "cant_undo" ? (
        <p className="action-confirm-final"><CantUndoIcon />{COPY.cantUndo}</p>
      ) : (
        <p className="action-confirm-final">{m.finalLine.text}</p>
      )}
      {(rows.length > 0 || notes.length > 0) && (
        <details className="action-confirm-details">
          <summary>{COPY.details}</summary>
          <div className="action-confirm-details-body">
            {rows.length > 0 && <MemberRows rows={rows} usd={usd} />}
            {notes.map((n) => <p key={n}>{n}</p>)}
          </div>
        </details>
      )}
    </div>
  );
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
  const member = summary.member;
  const typed = state.step === "confirm" ? state.typed : "";
  const ready = state.step === "confirm" && challengeSatisfied(summary.challenge, typed);

  return createPortal(
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={summary.title}
    >
      <div className="dialog-card action-confirm-card">
        <div className="dialog-title">{summary.title}</div>

        {/* Everything between the title and the buttons scrolls. */}
        <div className="action-confirm-scroll">
        {/* What is about to happen. Always rendered, including while sending
            and after a failure — removing it at the moment something went
            wrong is exactly when the operator most needs to see it. */}
        <div className="dialog-body">
          {member ? <MemberSummary m={member} /> : (
            <>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", margin: 0 }}>
            {summary.rows.map((r) => (
              <div key={r.label} style={{ display: "contents" }}>
                <dt style={{ opacity: 0.7 }}>{r.label}</dt>
                <dd className={r.ident ? "ident" : undefined} style={{ margin: 0, fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>

          {/* Free prose beneath the rows, for actions whose accepted copy is
              sentences rather than label/value pairs. Rendered before
              `irreversible` so the narrative reads before the warning. */}
          {summary.body && (
            <p style={{ marginTop: 12, marginBottom: 0 }}>{summary.body}</p>
          )}

          {summary.irreversible && (
            <p style={{ marginTop: 12, marginBottom: 0, opacity: 0.85 }}>{summary.irreversible}</p>
          )}
            </>
          )}
        </div>

        {state.step === "confirm" && state.notice && (typeof state.notice === "string" ? (
          <p role="status" className="action-confirm-notice" style={{ marginTop: 12, marginBottom: 0 }}>{state.notice}</p>
        ) : (
          // The member's "Fee updated" block (ruling 5 of member-first-run-ui's
          // review, 2026-11-18): the dialog's body size and its heading
          // weight, so it reads as part of the dialog (styles.css).
          <div role="status" className="action-confirm-notice action-confirm-notice-block" style={{ marginTop: 12 }}>
            <div className="action-confirm-notice-heading">{state.notice.heading}</div>
            <p className="action-confirm-notice-body" style={{ margin: "4px 0 0" }}>{state.notice.body}</p>
          </div>
        ))}

        {/* ── Typed challenge ── */}
        {state.step === "confirm" && (
          <div style={{ marginTop: 14 }}>
            <label htmlFor="action-confirm-challenge" style={{ display: "block", marginBottom: 6 }}>
              {member ? memberChallengePrompt(summary.challenge) : challengePrompt(summary.challenge)}
            </label>
            {/* The member layout labels the field "sats" (ruled), on a wrapper:
                .action-confirm-input sets only its 44px (confirmInput.test.ts). */}
            <SatsUnit on={member != null && summary.challenge.kind === "amount"}>
            <input
              id="action-confirm-challenge"
              className="form-input action-confirm-input"
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
            </SatsUnit>
          </div>
        )}

        {/* ── Failure ── */}
        {state.step === "failed" && (
          <div
            className="dialog-body"
            role="alert"
            style={{ marginTop: 12, borderTop: "1px solid var(--border-hi)", paddingTop: 12 }}
          >
            <strong>{state.error?.title ?? "The action failed"}</strong>
            <p style={{ margin: "6px 0 0" }}>{state.error?.detail ?? state.message}</p>
            {state.error?.kind === "mismatch" && (
              <p style={{ margin: "6px 0 0", opacity: 0.85 }}>{MISMATCH_NEXT_STEP}</p>
            )}
          </div>
        )}
        </div>

        {/* ── Actions ──
            The member layout puts the main button on the RIGHT (ruled, slice
            5); every other summary keeps it first. */}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          {state.step === "confirm" && (
            <MainLast on={member != null}>
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
            </MainLast>
          )}

          {state.step === "sending" && (
            // No cancel: the request is away and the server owns the outcome.
            <button className="btn btn-primary" disabled style={{ flex: 1 }}>
              Sending…
            </button>
          )}

          {state.step === "failed" && (
            <MainLast on={member != null}>
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
            </MainLast>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
