// The Corn-Bitcoin Z-Score gauge — hand-written SVG, like
// ../components/liquidity/LiquidityTopology.tsx, drawn ONLY from the band table
// the Worker stamped into the edition (spec §3.4.3).
//
// ⚠ NO BAND BOUNDARY OR LABEL IS WRITTEN HERE. Segments, boundary numbers,
// labels and the current band all come from `bands.table` and `bands.index`.
// Colours come from position relative to the band holding zero (TONE_COLOUR,
// ./daybreakView.ts). The numbers below are geometry only.
//
// Each band gets an equal share of the arc: the gauge shows WHICH band the Z is
// in and roughly where inside it, not a linear scale — the outer bands are
// open-ended and have no width to scale by. Inside a closed band the needle
// sits proportionally; inside an open outer band it is placed against the
// neighbouring band's width and pinned at the arc's end beyond that.
//
// Text is sized in rem so it follows the member's text scale (§3.5); nothing
// here sets a font, a scale or a theme.

import { Z_TITLE, bandsUnavailableCopy, gaugeAriaLabel } from "./daybreakCopy";
import { TONE_COLOUR, bandTone, centreIndex, formatBound, formatZ, type Band, type BandsView } from "./daybreakView";

const W = 240;
const H = 140;
const CX = 120;
const CY = 118;
const R = 88;
const STROKE = 18;

function point(angle: number, radius: number): [number, number] {
  return [CX + radius * Math.cos(angle), CY - radius * Math.sin(angle)];
}

/** Position 0…n along the arc → an angle from π (left end) to 0 (right end). */
const angleAt = (pos: number, n: number) => Math.PI - (pos / n) * Math.PI;

function arc(from: number, to: number): string {
  const [x0, y0] = point(from, R);
  const [x1, y1] = point(to, R);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** How far through its band the Z sits, 0…1. */
function fractionWithin(table: Band[], index: number, z: number): number {
  const { lower, upper } = table[index];
  if (lower !== null && upper !== null) return clamp01((z - lower) / (upper - lower));
  const neighbour = table[index + (lower === null ? 1 : -1)];
  const span = neighbour && neighbour.lower !== null && neighbour.upper !== null ? neighbour.upper - neighbour.lower : null;
  if (span === null) return 0.5;
  if (lower === null && upper !== null) return clamp01(1 - (upper - z) / span);
  if (lower !== null) return clamp01((z - lower) / span);
  return 0.5;
}

export default function DaybreakGauge({ value, bands }: { value: number; bands: BandsView }) {
  const z = formatZ(value);

  if (bands.status !== "available") {
    return (
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)" }}>{Z_TITLE}</div>
        <div data-testid="daybreak-gauge-value" style={{ fontSize: "2rem", fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text)" }}>
          {z}
        </div>
        <div style={{ fontSize: "0.8125rem", color: "var(--text-3)", marginTop: 4 }}>{bandsUnavailableCopy(bands.reason)}</div>
      </div>
    );
  }

  const { table, index } = bands;
  const n = table.length;
  const centre = centreIndex(table);
  const needle = angleAt(index + fractionWithin(table, index, value), n);
  const [nx, ny] = point(needle, R - STROKE);
  const current = table[index];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={gaugeAriaLabel(z, current.label)}
        style={{ width: "100%", maxWidth: 420, display: "block", margin: "0 auto" }}
      >
        {table.map((_, i) => (
          <path
            key={`band-${i}`}
            data-testid="daybreak-gauge-band"
            d={arc(angleAt(i, n), angleAt(i + 1, n))}
            fill="none"
            stroke={TONE_COLOUR[bandTone(i, centre)]}
            strokeWidth={STROKE}
            strokeOpacity={i === index ? 1 : 0.45}
          />
        ))}
        {table.slice(1).map((b, j) => {
          const [tx, ty] = point(angleAt(j + 1, n), R + STROKE);
          return (
            <text
              key={`bound-${j}`}
              data-testid="daybreak-gauge-bound"
              x={tx.toFixed(2)}
              y={ty.toFixed(2)}
              textAnchor="middle"
              fill="var(--text-3)"
              style={{ fontSize: "0.5625rem", fontFamily: "var(--mono)" }}
            >
              {formatBound(b.lower as number)}
            </text>
          );
        })}
        <line x1={CX} y1={CY} x2={nx.toFixed(2)} y2={ny.toFixed(2)} stroke="var(--text)" strokeWidth={3} strokeLinecap="round" />
        <circle cx={CX} cy={CY} r={5} fill="var(--text)" />
        <text
          data-testid="daybreak-gauge-value"
          x={CX}
          y={CY - 22}
          textAnchor="middle"
          fill="var(--text)"
          style={{ fontSize: "1.375rem", fontWeight: 700, fontFamily: "var(--mono)" }}
        >
          {z}
        </text>
      </svg>
      <div style={{ textAlign: "center", marginTop: 4 }}>
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)" }}>{Z_TITLE}</div>
        <div data-testid="daybreak-band-current" style={{ fontSize: "1rem", fontWeight: 600, color: TONE_COLOUR[bandTone(index, centre)] }}>
          {current.label}
        </div>
      </div>
      <ul style={{ listStyle: "none", display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "6px 14px", marginTop: 10 }}>
        {table.map((b, i) => (
          <li key={`legend-${i}`} aria-current={i === index ? "true" : undefined} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.75rem" }}>
            <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: TONE_COLOUR[bandTone(i, centre)] }} />
            <span data-testid="daybreak-band-label" style={{ color: i === index ? "var(--text)" : "var(--text-3)", fontWeight: i === index ? 600 : 400 }}>
              {b.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
