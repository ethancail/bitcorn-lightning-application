// Moved unchanged out of App.tsx (member-first-run-ui separation slice, B.2).
// Shared by the treasury and member shells.
//
// U24 shell fix — full-screen state for "the browser can't reach the API at
// all." Mirrors the INITIALIZING… splash's minimal styling; reassures about
// funds and self-heals via useAppStatus's 15s auto-retry.
export default function ApiUnreachableScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div style={{ fontFamily: "var(--mono)", color: "var(--red)", fontSize: "0.875rem", letterSpacing: "0.1em" }}>
        CAN'T REACH YOUR BITCORN NODE
      </div>
      <div style={{ color: "var(--text-3)", fontSize: "0.8125rem", maxWidth: 420, textAlign: "center", fontFamily: "var(--sans)", lineHeight: 1.5 }}>
        The app can't reach the Bitcorn API. Your node and funds are unaffected —
        this is a connection problem. Retrying automatically every 15 seconds.
      </div>
      <button className="btn btn-outline btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
