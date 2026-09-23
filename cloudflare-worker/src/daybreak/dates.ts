// Pure date functions for Daybreak editions.
//
// An edition is filed under its US CENTRAL publication date (Ruling E), and
// "held over" begins at the due time, 6:00 AM Central, on a due day with no
// edition published for that date (Ruling F.1). Both rulings are in the
// research vault's Daybreak spec, §3.3.
//
// Nothing here reads a clock or touches KV: `now` is always passed in, so every
// answer is a function of its arguments. Every conversion goes through Intl
// with an explicit `America/Chicago` zone. ⚠ Never use Date's local getters
// (getDate, getHours, …) for Central time: they answer in whatever zone the
// runtime has. Production Workers run in UTC; a local workerd inherits the
// HOST's zone unless pinned (vitest.config.ts pins the test pool to UTC, so the
// tests see what production sees). Date-only
// arithmetic (adding days, the weekday of a calendar date) is done in UTC on
// purpose — a calendar date has no zone, and UTC has no DST.

export type CentralDate = string; // "YYYY-MM-DD", a US Central calendar date

export type DaybreakCalendar = {
  /** Due weekdays, 0 = Sunday … 6 = Saturday. */
  dueWeekdays: readonly number[];
  /** Central dates that are not due even on a due weekday. */
  holidays: readonly CentralDate[];
};

/**
 * Monday–Friday, no holidays: the model author's stated intent. ⚠ Which days
 * are due, and holidays, are reserved to Ethan (spec §7) — this is a default
 * for the parameter, not a ruling; callers pass their own calendar.
 */
export const DEFAULT_DAYBREAK_CALENDAR: DaybreakCalendar = { dueWeekdays: [1, 2, 3, 4, 5], holidays: [] };

/** 6:00 AM Central (Ruling F.1). */
export const DUE_HOUR_CENTRAL = 6;

/**
 * How many dates a backward walk examines, the starting date included. Bounds
 * both the due-date search here and the published-edition walk in store.ts.
 * 14 = two full weeks: longer than any plausible publishing gap in a
 * weekday calendar with holidays (Christmas through New Year's is ~11 days),
 * while capping a status read at 14 sequential KV reads in the worst case.
 */
export const DEFAULT_MAX_LOOKBACK_DAYS = 14;

const CENTRAL_ZONE = "America/Chicago";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const centralFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function centralParts(instant: Date) {
  const p: Record<string, string> = {};
  for (const part of centralFormatter.formatToParts(instant)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** The Central wall clock of an instant, read as if it were UTC (ms). */
function centralWallMs(instantMs: number): number {
  const p = centralParts(new Date(instantMs));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function splitDate(date: CentralDate): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function assertCentralDate(date: unknown): asserts date is CentralDate {
  if (!isCentralDate(date)) throw new RangeError(`not a YYYY-MM-DD calendar date: ${String(date)}`);
}

function assertLookback(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`maxLookbackDays must be an integer ≥ 1, got ${n}`);
}

/** Strict "YYYY-MM-DD" naming a real calendar date. */
export function isCentralDate(value: unknown): value is CentralDate {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = splitDate(value);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

/** The US Central calendar date of an instant. */
export function centralDateOf(instant: Date): CentralDate {
  const p = centralParts(instant);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDays(date: CentralDate, days: number): CentralDate {
  assertCentralDate(date);
  const [y, m, d] = splitDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isDueDay(date: CentralDate, calendar: DaybreakCalendar = DEFAULT_DAYBREAK_CALENDAR): boolean {
  assertCentralDate(date);
  const [y, m, d] = splitDate(date);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return calendar.dueWeekdays.includes(weekday) && !calendar.holidays.includes(date);
}

/**
 * 6:00 AM Central on `date`, as a UTC instant. Two passes because the offset
 * at the first guess can differ from the offset at 06:00 itself on a DST
 * transition day; 06:00 is never inside a transition (they happen at 02:00),
 * so the result always exists and is unique — and is verified before return.
 */
export function dueInstant(date: CentralDate): Date {
  assertCentralDate(date);
  const [y, m, d] = splitDate(date);
  const wall = Date.UTC(y, m - 1, d, DUE_HOUR_CENTRAL, 0, 0);
  let t = wall - (centralWallMs(wall) - wall);
  t = wall - (centralWallMs(t) - t);
  if (centralWallMs(t) !== wall) throw new Error(`could not resolve 06:00 Central on ${date}`);
  return new Date(t);
}

/**
 * The Central date of the most recent due instant at or before `now`, or null
 * if no due day falls within `maxLookbackDays` dates (today included).
 */
export function mostRecentDueDate(
  now: Date,
  calendar: DaybreakCalendar = DEFAULT_DAYBREAK_CALENDAR,
  maxLookbackDays: number = DEFAULT_MAX_LOOKBACK_DAYS,
): CentralDate | null {
  assertLookback(maxLookbackDays);
  let date = centralDateOf(now);
  for (let i = 0; i < maxLookbackDays; i++) {
    if (isDueDay(date, calendar) && dueInstant(date).getTime() <= now.getTime()) return date;
    date = addDays(date, -1);
  }
  return null;
}

export type EditionState = "current" | "held_over" | "unavailable";

/**
 * The status rule. A published edition is always visible once published — the
 * due time decides only when ABSENCE becomes late:
 *   - nothing published at all            → unavailable
 *   - no due date in the window           → current (no absence can be late)
 *   - an edition published for the due date → the latest is current
 *   - otherwise                           → the latest is held over
 */
export function classifyEdition(input: {
  dueDate: CentralDate | null;
  latestPublishedDate: CentralDate | null;
  dueDatePublished: boolean;
}): EditionState {
  if (input.latestPublishedDate === null) return "unavailable";
  if (input.dueDate === null) return "current";
  return input.dueDatePublished ? "current" : "held_over";
}
