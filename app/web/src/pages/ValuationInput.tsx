import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import YearHeatmap from "../components/valuation/YearHeatmap";
import MonthGrid from "../components/valuation/MonthGrid";
import DayForm from "../components/valuation/DayForm";
import InputsTab from "../components/autoBuy/InputsTab";

type View = "year" | "month" | "day";

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayUtcParts(): { year: number; month: number; date: string } {
  const d = todayUtcDate();
  const [y, m] = d.split("-").map(Number);
  return { year: y, month: m - 1, date: d };
}

export default function ValuationInput() {
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayUtcParts();

  const initialDate = searchParams.get("date");
  const initialView = (searchParams.get("view") as View) || "day";
  const [view, setView] = useState<View>(initialView);
  const [year, setYear] = useState<number>(() => {
    if (initialDate) return Number(initialDate.split("-")[0]);
    return today.year;
  });
  const [month, setMonth] = useState<number>(() => {
    if (initialDate) return Number(initialDate.split("-")[1]) - 1;
    return today.month;
  });
  const [date, setDate] = useState<string>(initialDate ?? today.date);

  // Sync state to URL
  useEffect(() => {
    const next: Record<string, string> = { view };
    if (view === "day") next.date = date;
    if (view === "month") next.date = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    if (view === "year") next.date = `${year}-01-01`;
    setSearchParams(next, { replace: true });
  }, [view, year, month, date, setSearchParams]);

  const goToday = () => {
    const t = todayUtcParts();
    setYear(t.year);
    setMonth(t.month);
    setDate(t.date);
    setView("day");
  };

  return (
    <div className="page">
      <div className="page-header" style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ margin: 0 }}>Daily Valuation Inputs</h1>
          <p style={{ color: "var(--text-3)", fontSize: "0.875rem", marginTop: 4 }}>
            Browse the calendar to add, edit, or audit Glassnode metric entries by date.
          </p>
        </div>
        <button onClick={goToday} className="btn">Today</button>
      </div>

      {/* Breadcrumb */}
      <div style={{ marginBottom: 12, fontSize: "0.875rem", color: "var(--text-2)" }}>
        <button onClick={() => setView("year")} style={{ background: "none", border: "none", color: view === "year" ? "var(--text-1)" : "var(--accent)", cursor: "pointer", padding: 0, fontWeight: view === "year" ? 600 : 400 }}>{year}</button>
        {(view === "month" || view === "day") && (
          <>
            <span style={{ color: "var(--text-3)", margin: "0 6px" }}>›</span>
            <button onClick={() => setView("month")} style={{ background: "none", border: "none", color: view === "month" ? "var(--text-1)" : "var(--accent)", cursor: "pointer", padding: 0, fontWeight: view === "month" ? 600 : 400 }}>
              {new Date(year, month, 1).toLocaleString("en-US", { month: "long" })}
            </button>
          </>
        )}
        {view === "day" && (
          <>
            <span style={{ color: "var(--text-3)", margin: "0 6px" }}>›</span>
            <span style={{ color: "var(--text-1)", fontWeight: 600 }}>{date.split("-")[2]}</span>
          </>
        )}
      </div>

      {view === "year" && (
        <YearHeatmap
          year={year}
          onSelectMonth={(y, m) => { setYear(y); setMonth(m); setView("month"); }}
          onPrevYear={() => setYear((y) => y - 1)}
          onNextYear={() => setYear((y) => Math.min(y + 1, today.year))}
        />
      )}

      {view === "month" && (
        <MonthGrid
          year={year}
          month={month}
          onSelectDay={(d) => { setDate(d); setView("day"); }}
          onPrevMonth={() => {
            if (month === 0) { setYear(year - 1); setMonth(11); }
            else setMonth(month - 1);
          }}
          onNextMonth={() => {
            const isCurrent = year === today.year && month === today.month;
            if (isCurrent) return;
            if (month === 11) { setYear(year + 1); setMonth(0); }
            else setMonth(month + 1);
          }}
          onZoomToYear={() => setView("year")}
        />
      )}

      {view === "day" && (
        <DayForm date={date} onSaved={() => { /* no-op; DayForm refreshes itself */ }} />
      )}

      {/* Composite Model Inputs — read-only view of all 12 inputs */}
      <div style={{ marginTop: 48 }}>
        <h2 style={{ marginBottom: 16 }}>Composite Model Inputs</h2>
        <InputsTab />
      </div>
    </div>
  );
}
