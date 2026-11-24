// The lock on the member confirm dialogs' "Can't be undone" line (member-first-
// run-ui, ruled 2026-11-13 §3: a plain icon line, no box; built in slice 5).
// Decorative: the words say it all, so aria-hidden. Stroke icon in
// currentColor, the house style (withdraw/ClockIcon.tsx).

export function CantUndoIcon() {
  return (
    <svg
      className="action-confirm-final-icon"
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
