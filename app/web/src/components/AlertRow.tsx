import type { ReactNode } from "react";

// X3: a treasury alert as one compact row — icon, a plain-language heading,
// the action (when the alert has one). The long detail is one tap away in a
// native <details>, so it opens from the keyboard and announces its expanded
// state with no script. Severity colours are the existing
// .alert.{critical,warning} ones; nothing here changes them. The heading is
// whatever the caller passes — for treasury alerts, the one the server set
// (SH1); this component never chooses one.
export default function AlertRow({
  severity,
  heading,
  detail,
  action,
}: {
  severity: "critical" | "warning";
  heading: string;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert-row ${severity}`}>
      <details className="alert-row-details">
        <summary>
          <span
            className="alert-icon"
            role="img"
            aria-label={severity === "critical" ? "Critical" : "Warning"}
          >
            {severity === "critical" ? "✕" : "⚠"}
          </span>
          <span className="alert-row-heading">{heading}</span>
          <span className="alert-row-more">
            <span className="alert-row-more-text">Details</span>
          </span>
        </summary>
        <div className="alert-msg alert-row-detail">{detail}</div>
      </details>
      {action && <div className="alert-row-action">{action}</div>}
    </div>
  );
}
