// "Technical details" expander — the demote-not-delete home for protocol
// vocabulary on member surfaces (U2; vocabulary record 2026-07-09: protocol
// terms are never primary member-facing copy, but stay available for
// advanced users and support).
//
// Matches the app's existing <details> convention (MemberDashboard's
// "Channel details" block) — no new design-system variant. Same shared-
// component pattern as ./Pill.tsx / ./ErrorState.tsx.
//
// Consumers (U1–U4 Phase 2): Payments payment-hash, ConnectToHub hub node
// ID + sat/vB fee rates, Withdraw/Top Up protocol status + fee breakdowns,
// ProfilePanel gossip/mempool.space pointer.

export default function TechnicalDetails({
  summary = "Technical details",
  children,
}: {
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <details style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>{summary}</summary>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        {children}
      </div>
    </details>
  );
}

/** Label/value row for inside the expander — mono value, wraps long hex. */
export function TechRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", wordBreak: "break-all", textAlign: "right" }}>
        {children}
      </span>
    </div>
  );
}
