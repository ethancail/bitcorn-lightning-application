import { useEffect, useMemo, useState } from "react";
import { api, type CalendarSummary } from "../../api/client";

interface Props {
  year: number;
  month: number; // 0-11
  onSelectDay: (date: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onZoomToYear: () => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function colorForCompleteness(filled: number): string {
  if (filled === 0) return "var(--surface-2)";
  if (filled >= 8) return "rgba(34,197,94,0.25)";
  if (filled >= 6) return "rgba(132,204,22,0.25)";
  if (filled >= 4) return "rgba(250,204,21,0.25)";
  return "rgba(251,191,36,0.25)";
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export default function MonthGrid({ year, month, onSelectDay, onPrevMonth, onNextMonth, onZoomToYear }: Props) {
  const [summary, setSummary] = useState<CalendarSummary | null>(null);
  const todayUtc = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    const from = `${year}-${pad2(month + 1)}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const to = `${year}-${pad2(month + 1)}-${pad2(lastDay)}`;
    api.getValuationCalendar(from, to)
      .then(setSummary)
      .catch((err) => console.error("[MonthGrid]", err));
  }, [year, month]);

  const cells = useMemo(() => {
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: Array<{ date: string; day: number; filled: number; isFuture: boolean; exists: boolean }> = [];
    for (let i = 0; i < firstDow; i++) out.push({ date: "", day: 0, filled: 0, isFuture: false, exists: false });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${pad2(month + 1)}-${pad2(d)}`;
      out.push({
        date: dateStr,
        day: d,
        filled: summary?.days[dateStr]?.filled ?? 0,
        isFuture: dateStr > todayUtc,
        exists: true,
      });
    }
    while (out.length % 7 !== 0) out.push({ date: "", day: 0, filled: 0, isFuture: false, exists: false });
    return out;
  }, [year, month, summary, todayUtc]);

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={onPrevMonth} style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}>← Prev</button>
        <button onClick={onZoomToYear} style={{ background: "none", border: "none", fontSize: "1.125rem", fontWeight: 600, color: "var(--text-1)", cursor: "pointer" }}>
          {MONTH_NAMES[month]} {year}
        </button>
        <button onClick={onNextMonth} style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}>Next →</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {DOW_LABELS.map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-3)" }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((cell, idx) => (
          <button
            key={idx}
            disabled={!cell.exists || cell.isFuture}
            onClick={() => cell.exists && !cell.isFuture && onSelectDay(cell.date)}
            style={{
              aspectRatio: "1",
              background: cell.exists && !cell.isFuture ? colorForCompleteness(cell.filled) : "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: 4,
              cursor: cell.exists && !cell.isFuture ? "pointer" : "default",
              opacity: cell.exists ? (cell.isFuture ? 0.3 : 1) : 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              justifyContent: "space-between",
              color: "var(--text-1)",
              fontSize: "0.8125rem",
            }}
          >
            <span>{cell.exists ? cell.day : ""}</span>
            {cell.exists && !cell.isFuture && (
              <span style={{ fontSize: "0.625rem", color: "var(--text-3)", alignSelf: "flex-end" }}>
                {cell.filled > 0 ? `${cell.filled}/8` : "—"}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
