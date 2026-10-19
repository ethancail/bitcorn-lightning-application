// The one hover tooltip every chart uses (Kevin item 2, rulings K2/K2a).
// Box, size and colours come from the .chart-tooltip rules in styles.css, at
// the density block's label size (X2). A series name is always a text colour;
// the series colour goes on a dot beside it, and only a series the chart
// draws gets one — a row that is context (the ratio chart's BTC and corn
// prices) has no line to point at.

export type ChartTooltipRow = {
  /** Omitted for a chart's single value, e.g. the Bitcoin Price tile. */
  name?: string;
  value: string;
  /** The drawn line's colour; set only for a series on the chart. */
  dot?: string;
  /** The row the chart plots, set off below the context rows. */
  total?: boolean;
};

export default function ChartTooltip({ date, rows }: { date: string; rows: ChartTooltipRow[] }) {
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{date}</div>
      {rows.map((r, i) => (
        <div key={r.name ?? i} className={r.total ? "chart-tooltip-row chart-tooltip-total" : "chart-tooltip-row"}>
          {r.name != null && (
            <span className="chart-tooltip-name">
              {r.dot && <span aria-hidden className="chart-tooltip-dot" style={{ background: r.dot }} />}
              {r.name}
            </span>
          )}
          <span className="chart-tooltip-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
