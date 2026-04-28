import { useEffect, useMemo, useState } from "react";
import { api, type CalendarSummary } from "../../api/client";

interface Props {
  year: number;
  onSelectMonth: (year: number, month: number) => void;
  onPrevYear: () => void;
  onNextYear: () => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function colorForCompleteness(filled: number): string {
  if (filled === 0) return "var(--surface-2)";
  if (filled >= 8) return "#22c55e";
  if (filled >= 6) return "#84cc16";
  if (filled >= 4) return "#facc15";
  if (filled >= 1) return "#fbbf24";
  return "var(--surface-2)";
}

export default function YearHeatmap({ year, onSelectMonth, onPrevYear, onNextYear }: Props) {
  const [summary, setSummary] = useState<CalendarSummary | null>(null);
  const todayUtc = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    api.getValuationCalendar(from, to)
      .then(setSummary)
      .catch((err) => console.error("[YearHeatmap]", err));
  }, [year]);

  const cells = useMemo(() => {
    const rows: Array<Array<{ date: string; filled: number; isFuture: boolean; exists: boolean }>> = [];
    for (let m = 0; m < 12; m++) {
      const row: typeof rows[number] = [];
      const daysInMonth = new Date(year, m + 1, 0).getDate();
      for (let d = 1; d <= 31; d++) {
        if (d > daysInMonth) {
          row.push({ date: "", filled: 0, isFuture: false, exists: false });
          continue;
        }
        const dateStr = isoDate(year, m, d);
        const cell = summary?.days[dateStr];
        row.push({
          date: dateStr,
          filled: cell?.filled ?? 0,
          isFuture: dateStr > todayUtc,
          exists: true,
        });
      }
      rows.push(row);
    }
    return rows;
  }, [year, summary, todayUtc]);

  const monthLabels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button
          onClick={onPrevYear}
          style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}
        >
          ← {year - 1}
        </button>
        <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>{year}</div>
        <button
          onClick={onNextYear}
          style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}
        >
          {year + 1} →
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8 }}>
        {cells.map((row, mIdx) => (
          <div key={mIdx} style={{ display: "contents" }}>
            <button
              onClick={() => onSelectMonth(year, mIdx)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-2)",
                fontSize: "0.8125rem",
                textAlign: "right",
                paddingRight: 8,
                cursor: "pointer",
              }}
            >
              {monthLabels[mIdx]}
            </button>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(31, 1fr)", gap: 2 }}>
              {row.map((cell, dIdx) => (
                <div
                  key={dIdx}
                  title={cell.exists ? `${cell.date}: ${cell.filled}/8` : ""}
                  onClick={() => cell.exists && !cell.isFuture && onSelectMonth(year, mIdx)}
                  style={{
                    width: "100%",
                    aspectRatio: "1",
                    background: cell.exists
                      ? (cell.isFuture ? "transparent" : colorForCompleteness(cell.filled))
                      : "transparent",
                    border: cell.exists && !cell.isFuture ? "1px solid var(--border)" : "1px solid transparent",
                    borderRadius: 2,
                    cursor: cell.exists && !cell.isFuture ? "pointer" : "default",
                    opacity: cell.isFuture ? 0.3 : 1,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 12, fontSize: "0.75rem", color: "var(--text-3)" }}>
        <span>Empty</span>
        <span style={{ color: "#fbbf24" }}>1–3</span>
        <span style={{ color: "#facc15" }}>4–5</span>
        <span style={{ color: "#84cc16" }}>6–7</span>
        <span style={{ color: "#22c55e" }}>8/8</span>
      </div>
    </div>
  );
}
