// Storage seam for Daybreak editions — EVERY Daybreak KV touch goes through
// this module. No caller elsewhere names KV, constructs a key, or assumes
// single-writer semantics (spec §3.3.1: if auto-publish is ever adopted, the
// backend behind these functions changes and nothing else does).
//
// THREE keys per US Central publication date, ONE writer each (Ruling D):
//   daybreak:<YYYY-MM-DD>:draft      — the drafting agent
//   daybreak:<YYYY-MM-DD>:working    — the treasury editor, as Kevin saves
//   daybreak:<YYYY-MM-DD>:published  — Kevin's publish action
// in the PRICES_CACHE namespace. Member reads touch ONLY the published key.
//
// Every write names its date explicitly (Ruling E); a missing or malformed date
// is REJECTED and never defaulted from a clock. Publish copies working if it
// exists, else draft (F.2), and KEEPS the working key (F.3). Keys are
// deterministic from the date and nothing enumerates: finding the latest
// published edition walks back one date at a time, bounded.
//
// Edition content is opaque here — a plain JSON object, validated as such and
// nothing more. Its section schema is not this module's.
//
// ⚠ IT FAILS CLOSED ON READ — THE OPPOSITE OF SEVERAL NEIGHBOURS, ON PURPOSE.
// persist.ts loadHistory → [] and loadInputs → {}, and manualStore.ts
// loadManualHistory → an empty history, all fail OPEN to empty on an
// unparseable key. Here an unparseable or wrong-shape stored value is an
// explicit { ok: false } with no content attached — never empty, never
// partial, and never skipped in favour of an older edition. A store that fails
// open renders NOTHING (or yesterday's edition with no mark), which is exactly
// what a member cannot tell from correct behaviour. An ABSENT key is not an
// error: it is { ok: true, found: false }, the normal state of an unpublished
// date. Do not "harmonise" this with persist.ts. As in powerLawParams.ts, a KV
// call that THROWS is deliberately not caught: it propagates, which is closed.

import {
  DEFAULT_DAYBREAK_CALENDAR,
  DEFAULT_MAX_LOOKBACK_DAYS,
  addDays,
  centralDateOf,
  classifyEdition,
  isCentralDate,
  mostRecentDueDate,
  type CentralDate,
  type DaybreakCalendar,
} from "./dates";

export { DEFAULT_MAX_LOOKBACK_DAYS };

export type EditionContent = Record<string, unknown>;

type Slot = "draft" | "working" | "published";

export type DaybreakStoreError = {
  ok: false;
  reason: "invalid_date" | "invalid_content" | "unparseable" | "wrong_shape" | "nothing_to_publish";
  detail: string;
};

export type WriteResult = { ok: true } | DaybreakStoreError;
export type PublishResult = { ok: true; source: "working" | "draft" } | DaybreakStoreError;
export type ReadResult = { ok: true; found: false } | { ok: true; found: true; content: EditionContent } | DaybreakStoreError;
export type LatestResult =
  | { ok: true; found: false }
  | { ok: true; found: true; date: CentralDate; content: EditionContent }
  | DaybreakStoreError;
export type EditionStatusResult =
  | { ok: true; state: "unavailable" }
  | {
      ok: true;
      state: "current" | "held_over";
      /** The date whose absence would be late, or null if no due day is in the window. */
      dueDate: CentralDate | null;
      edition: { date: CentralDate; content: EditionContent };
    }
  | DaybreakStoreError;

function key(date: CentralDate, slot: Slot): string {
  return `daybreak:${date}:${slot}`;
}

function isPlainObject(v: unknown): v is EditionContent {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function invalidDate(date: unknown): DaybreakStoreError {
  return { ok: false, reason: "invalid_date", detail: `an explicit YYYY-MM-DD Central date is required, got ${String(date)}` };
}

async function readSlot(kv: KVNamespace, date: CentralDate, slot: Slot): Promise<ReadResult> {
  const k = key(date, slot);
  const raw = await kv.get(k);
  if (raw === null) return { ok: true, found: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `KV key ${k} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "wrong_shape", detail: `KV key ${k} does not hold a JSON object` };
  }
  return { ok: true, found: true, content: parsed };
}

async function writeSlot(kv: KVNamespace, date: CentralDate, slot: "draft" | "working", content: EditionContent): Promise<WriteResult> {
  if (!isCentralDate(date)) return invalidDate(date);
  if (!isPlainObject(content)) {
    return { ok: false, reason: "invalid_content", detail: "edition content must be a plain JSON object" };
  }
  await kv.put(key(date, slot), JSON.stringify(content));
  return { ok: true };
}

/** The drafting agent's write. */
export function writeDraft(kv: KVNamespace, date: CentralDate, content: EditionContent): Promise<WriteResult> {
  return writeSlot(kv, date, "draft", content);
}

/** The treasury editor's save. */
export function writeWorking(kv: KVNamespace, date: CentralDate, content: EditionContent): Promise<WriteResult> {
  return writeSlot(kv, date, "working", content);
}

/** Kevin's publish: working if present, else draft → published. Working is kept. */
export async function publishEdition(kv: KVNamespace, date: CentralDate): Promise<PublishResult> {
  if (!isCentralDate(date)) return invalidDate(date);
  const working = await readSlot(kv, date, "working");
  if (!working.ok) return working;
  let source: "working" | "draft" = "working";
  let chosen: ReadResult = working;
  if (!working.found) {
    source = "draft";
    chosen = await readSlot(kv, date, "draft");
    if (!chosen.ok) return chosen;
  }
  if (!chosen.found) {
    return { ok: false, reason: "nothing_to_publish", detail: `no working or draft edition for ${date}` };
  }
  await kv.put(key(date, "published"), JSON.stringify(chosen.content));
  return { ok: true, source };
}

/** The published edition for one date. Absent is { found: false }, not an error. */
export async function readPublished(kv: KVNamespace, date: CentralDate): Promise<ReadResult> {
  if (!isCentralDate(date)) return invalidDate(date);
  return readSlot(kv, date, "published");
}

/** The draft for one date — for the working save's first copy (J.3). Never a member read. */
export async function readDraft(kv: KVNamespace, date: CentralDate): Promise<ReadResult> {
  if (!isCentralDate(date)) return invalidDate(date);
  return readSlot(kv, date, "draft");
}

/** The working edition for one date — for the working save (J.3). Never a member read. */
export async function readWorking(kv: KVNamespace, date: CentralDate): Promise<ReadResult> {
  if (!isCentralDate(date)) return invalidDate(date);
  return readSlot(kv, date, "working");
}

/**
 * The most recent published edition at or before `fromDate`, walking back one
 * date at a time through at most `maxLookbackDays` dates (`fromDate` included).
 * Exhausting the walk is { found: false }. A corrupt value stops the walk with
 * an error — it is never skipped.
 */
export async function findLatestPublished(
  kv: KVNamespace,
  fromDate: CentralDate,
  maxLookbackDays: number = DEFAULT_MAX_LOOKBACK_DAYS,
): Promise<LatestResult> {
  if (!isCentralDate(fromDate)) return invalidDate(fromDate);
  if (!Number.isInteger(maxLookbackDays) || maxLookbackDays < 1) {
    throw new RangeError(`maxLookbackDays must be an integer ≥ 1, got ${maxLookbackDays}`);
  }
  let date = fromDate;
  for (let i = 0; i < maxLookbackDays; i++) {
    const r = await readSlot(kv, date, "published");
    if (!r.ok) return r;
    if (r.found) return { ok: true, found: true, date, content: r.content };
    date = addDays(date, -1);
  }
  return { ok: true, found: false };
}

/**
 * The member read: which edition to show at `now`, and whether it is held over.
 * The walk starts at today's Central date, so an edition becomes visible from
 * Central midnight of its own date, never earlier (Ethan, 2026-09-23). Held over
 * is decided by comparing the latest edition's date with the due date.
 */
export async function readEditionStatus(
  kv: KVNamespace,
  now: Date,
  calendar: DaybreakCalendar = DEFAULT_DAYBREAK_CALENDAR,
  maxLookbackDays: number = DEFAULT_MAX_LOOKBACK_DAYS,
): Promise<EditionStatusResult> {
  const latest = await findLatestPublished(kv, centralDateOf(now), maxLookbackDays);
  if (!latest.ok) return latest;
  if (!latest.found) return { ok: true, state: "unavailable" };

  const dueDate = mostRecentDueDate(now, calendar, maxLookbackDays);
  const state = classifyEdition({ dueDate, latestPublishedDate: latest.date });
  return {
    ok: true,
    state: state === "current" ? "current" : "held_over",
    dueDate,
    edition: { date: latest.date, content: latest.content },
  };
}
