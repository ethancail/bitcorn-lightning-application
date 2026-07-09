// Shared error-state block — the "couldn't load X" pattern: dim-red alert +
// optional raw detail + "Try again →" retry.
//
// Extracted 2026-07-09 (U24 pre-work) from two byte-identical private copies:
// pages/SubscriptionPayments.tsx (ErrorState) and pages/AdminMembers.tsx
// (ErrorView — same JSX, but derived its message from an error code first).
// Consumers derive the human message (differentiating e.g. treasury_unreachable
// from generic failures) and pass it in; this component owns only the
// rendering. Same extraction pattern as ./Pill.tsx.
//
// U24 note: this is the template for fixing fake-empty-on-failure surfaces —
// render this from a discriminated { kind: "error" } view state; never let a
// fetch failure collapse into an empty data value that renders as "No X yet."

export default function ErrorState({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <section className="sub-panel">
      <div className="sub-alert sub-alert-dim-red">
        <span className="sub-alert-icon" aria-hidden>✕</span>
        <div className="sub-alert-body">
          {message}
          {detail && <span className="sub-error-detail"> ({detail})</span>}
        </div>
      </div>
      <div className="sub-actions">
        <button className="sub-btn" onClick={onRetry}>
          Try again <span aria-hidden>→</span>
        </button>
      </div>
    </section>
  );
}
