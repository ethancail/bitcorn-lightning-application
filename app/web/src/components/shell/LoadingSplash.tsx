// The root loading splash — shown while useAppStatus's first /api/node read is
// pending. Moved unchanged out of App.tsx's Root() (member-first-run-ui
// separation slice, B.2). Shared by the treasury and member shells.

export default function LoadingSplash() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          fontSize: "0.875rem",
          letterSpacing: "0.1em",
        }}
      >
        INITIALIZING…
      </div>
    </div>
  );
}
