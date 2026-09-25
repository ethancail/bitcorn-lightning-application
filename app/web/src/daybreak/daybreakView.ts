// Pure view logic for the Daybreak member screen (bitcorn-research spec §3.4.3;
// decisions/2026-09-25-daybreak-member-screen-seven-rulings.md). Kept apart
// from the JSX so each rule is unit-testable, like ../components/freshness.ts.
//
// ⚠ NO BAND TABLE LIVES HERE, OR ANYWHERE IN THE WEB APP. The bands come only
// from the table the Worker stamped into each edition's Z block, and the
// classification is the Worker's. Colours are chosen by POSITION relative to
// the band that holds zero, never by label or by a fixed boundary, so a
// recalibration needs no web change (decisions/2026-09-25-daybreak-no-third-
// table-scope-valuation-zones-not-power-law-bands.md). ./noBandTable.test.ts
// scans for a copy.
//
// ⚠ DATES. Edition, due and close dates are US Central CALENDAR dates and are
// never converted to the browser's zone: formatCentralDate renders the date as
// written. Only instants would take the browser's zone, and the screen shows
// none.

export type Band = { lower: number | null; upper: number | null; label: string };

export type BandsView =
  | { status: "available"; table: Band[]; index: number }
  | { status: "unavailable"; reason: string };

export type Close = { date: string; close: number };

export type ZView =
  | { status: "available"; value: number; corn: Close; btc: Close; bands: BandsView }
  | { status: "unavailable"; reason: string };

export type WorthReadingView = { title?: string; note?: string[]; href?: string };

export type SectionsView = {
  lead?: string[];
  kevinsRead?: string[];
  insideAgriculture?: string[];
  worthReading?: WorthReadingView;
  closer?: string[];
};

export type EditionView = {
  state: "current" | "held_over";
  date: string;
  z: ZView;
  sections: SectionsView;
};

export type DaybreakRead = { state: "unavailable" } | EditionView;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isBound = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Plain text → paragraphs, split on blank lines. Never parsed as markup. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** The URL, only when it is absolute and its scheme is https. */
export function httpsHref(link: unknown): string | undefined {
  if (typeof link !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" ? url.href : undefined;
}

/**
 * A Central calendar date, rendered as the same calendar day for every reader.
 * The date is built at UTC midnight and FORMATTED in UTC, so no zone offset can
 * move it — the formatter's zone is a device for writing the date as given,
 * not a conversion. Only the locale is the reader's.
 */
export function formatCentralDate(ymd: string): string {
  const m = DATE_RE.exec(ymd);
  if (!m) return ymd;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(at.getTime())) return ymd;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(at);
}

function contains(b: Band, z: number): boolean {
  return (b.lower === null || z >= b.lower) && (b.upper === null || z < b.upper);
}

/** The index of the band holding zero — the centre of the gauge. */
export function centreIndex(table: Band[]): number {
  return table.findIndex((b) => contains(b, 0));
}

export type BandTone = "below" | "centre" | "above";

/** Position relative to the centre band. Nothing about a band's label or bounds. */
export function bandTone(index: number, centre: number): BandTone {
  if (index === centre) return "centre";
  return index < centre ? "below" : "above";
}

// Ruling 6: green left, amber centre, blue right. No red. Existing tokens only,
// all defined in both themes (styles.css :root and [data-theme="light"]).
export const TONE_COLOUR: Record<BandTone, string> = {
  below: "var(--green)",
  centre: "var(--amber)",
  above: "var(--blue)",
};

const MINUS = "−";

/** A boundary as stamped, with a typographic minus. */
export function formatBound(n: number): string {
  return String(n).replace("-", MINUS);
}

/** The Z for display, rounded to two places. Cosmetic: the delivered precision is Kevin's open question. */
export function formatZ(n: number): string {
  return n.toFixed(2).replace("-", MINUS);
}

function parseBands(raw: unknown, value: number): BandsView {
  const unusable: BandsView = { status: "unavailable", reason: "unrecognized_bands" };
  if (!isObj(raw)) return unusable;
  if (raw.status === "unavailable") return { status: "unavailable", reason: typeof raw.reason === "string" ? raw.reason : "" };
  if (raw.status !== "available" || !Array.isArray(raw.table) || raw.table.length === 0) return unusable;
  const table: Band[] = [];
  for (const b of raw.table) {
    if (!isObj(b) || !isBound(b.lower) || !isBound(b.upper) || typeof b.label !== "string") return unusable;
    table.push({ lower: b.lower, upper: b.upper, label: b.label });
  }
  const index = raw.index;
  if (typeof index !== "number" || !Number.isInteger(index) || !table[index] || !contains(table[index], value)) return unusable;
  if (centreIndex(table) < 0) return unusable;
  return { status: "available", table, index };
}

function parseClose(raw: unknown): Close | null {
  if (!isObj(raw) || typeof raw.date !== "string" || typeof raw.close !== "number") return null;
  return { date: raw.date, close: raw.close };
}

function parseZ(raw: unknown): ZView {
  if (isObj(raw) && raw.status === "available" && typeof raw.value === "number" && Number.isFinite(raw.value)) {
    const corn = parseClose(raw.corn);
    const btc = parseClose(raw.btc);
    if (corn && btc) return { status: "available", value: raw.value, corn, btc, bands: parseBands(raw.bands, raw.value) };
  }
  if (isObj(raw) && raw.status === "unavailable" && typeof raw.reason === "string") return { status: "unavailable", reason: raw.reason };
  return { status: "unavailable", reason: "unrecognized_z" };
}

function textSection(v: unknown): string[] | undefined {
  if (typeof v !== "string") return undefined;
  const ps = paragraphs(v);
  return ps.length > 0 ? ps : undefined;
}

function worthReading(v: unknown): WorthReadingView | undefined {
  if (!isObj(v)) return undefined;
  const title = typeof v.title === "string" && v.title.trim() !== "" ? v.title.trim() : undefined;
  const note = textSection(v.note);
  const href = httpsHref(v.link);
  if (!title && !note && !href) return undefined;
  return { ...(title && { title }), ...(note && { note }), ...(href && { href }) };
}

/** The spec's section names (§3.4.3). Unknown keys are ignored; an absent section is omitted. */
function parseSections(content: Obj): SectionsView {
  const out: SectionsView = {};
  const lead = textSection(content.lead);
  const kevinsRead = textSection(content.kevinsRead);
  const insideAgriculture = textSection(content.insideAgriculture);
  const wr = worthReading(content.worthReading);
  const closer = textSection(content.closer);
  if (lead) out.lead = lead;
  if (kevinsRead) out.kevinsRead = kevinsRead;
  if (insideAgriculture) out.insideAgriculture = insideAgriculture;
  if (wr) out.worthReading = wr;
  if (closer) out.closer = closer;
  return out;
}

/** The proxy's 200 body → a view, or null when the shape is not one it knows. */
export function parseDaybreakRead(raw: unknown): DaybreakRead | null {
  if (!isObj(raw)) return null;
  if (raw.state === "unavailable") return { state: "unavailable" };
  if (raw.state !== "current" && raw.state !== "held_over") return null;
  const edition = raw.edition;
  if (!isObj(edition) || typeof edition.date !== "string" || !DATE_RE.test(edition.date) || !isObj(edition.content)) return null;
  const owned = edition.content.workerOwned;
  return {
    state: raw.state,
    date: edition.date,
    z: parseZ(isObj(owned) ? owned.z : undefined),
    sections: parseSections(edition.content),
  };
}
