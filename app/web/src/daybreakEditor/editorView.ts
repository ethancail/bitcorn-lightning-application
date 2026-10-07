// Pure view logic for the Daybreak Editor (spec §3.4.5), kept apart from the
// JSX so each rule is unit-testable, like ../daybreak/daybreakView.ts.
//
// ⚠ THE BROWSER NEVER COMPUTES AN EDITION DATE. Both editions — the next due
// one and the most recent — come from the Worker, through the proxy's single
// read. Nothing here reads a clock.
//
// ⚠ THE SECTION-KEY CONTRACT (cloudflare-worker/src/daybreak/sections.ts):
// lead, kevinsRead, insideAgriculture, closer are plain strings; worthReading is
// ONE object { title, note, link } with all three present. The form keeps Worth
// Reading's three fields together, and sends all three or none.
//
// The Z is parsed by the member screen's own parser (parseDaybreakRead), reused
// rather than copied, so the editor shows the Z exactly as members will.

import { parseDaybreakRead, type ZView } from "../daybreak/daybreakView";
import type { Slot } from "./editorCopy";

export type FormValues = {
  lead: string;
  kevinsRead: string;
  insideAgriculture: string;
  wrTitle: string;
  wrNote: string;
  wrLink: string;
  closer: string;
};

export const EMPTY_FORM: FormValues = {
  lead: "",
  kevinsRead: "",
  insideAgriculture: "",
  wrTitle: "",
  wrNote: "",
  wrLink: "",
  closer: "",
};

/** The Z as the editor knows it: not yet computed, a full view, or "available" from a save with its value still to come. */
export type EditorZ = { kind: "pending" } | { kind: "view"; z: ZView } | { kind: "available_no_detail" };

export type EditorEdition = {
  slot: Slot;
  date: string;
  published: boolean;
  /** False for the no-draft state: nothing stored yet, the first save computes the Z. */
  hasCopy: boolean;
  form: FormValues;
  z: EditorZ;
};

export type EditorRead = { next: EditorEdition; recent: EditorEdition };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function formFrom(content: Obj): FormValues {
  const wr = isObj(content.worthReading) ? content.worthReading : {};
  return {
    lead: str(content.lead),
    kevinsRead: str(content.kevinsRead),
    insideAgriculture: str(content.insideAgriculture),
    wrTitle: str(wr.title),
    wrNote: str(wr.note),
    wrLink: str(wr.link),
    closer: str(content.closer),
  };
}

function parseEntry(slot: Slot, raw: unknown): EditorEdition | null {
  if (!isObj(raw) || typeof raw.date !== "string" || !DATE_RE.test(raw.date) || typeof raw.published !== "boolean") return null;
  const base = { slot, date: raw.date, published: raw.published };
  if (raw.code === "no_draft") return { ...base, hasCopy: false, form: { ...EMPTY_FORM }, z: { kind: "pending" } };
  if (!isObj(raw.content)) return null;
  const view = parseDaybreakRead({ state: "current", edition: { date: raw.date, content: raw.content } });
  const z: EditorZ = view && view.state !== "unavailable" ? { kind: "view", z: view.z } : { kind: "view", z: { status: "unavailable", reason: "unrecognized_z" } };
  return { ...base, hasCopy: true, form: formFrom(raw.content), z };
}

/** The proxy's 200 body for GET /api/daybreak/editor → both editions, or null when the shape is not one it knows. */
export function parseEditorRead(raw: unknown): EditorRead | null {
  if (!isObj(raw)) return null;
  const next = parseEntry("next", raw.next);
  const recent = parseEntry("recent", raw.recent);
  return next && recent ? { next, recent } : null;
}

const filled = (s: string) => s.trim() !== "";

/**
 * Worth Reading with some, but not all, of its three fields filled. The screen
 * refuses to send it. The Worker refuses it too: a blank title or note is
 * `invalid_section` and a blank link is `invalid_link`, judged by the same
 * trimmed test as `filled` above (cloudflare-worker/src/daybreak/sections.ts),
 * so the screen's check and the Worker's agree.
 */
export function worthReadingIsPartial(f: FormValues): boolean {
  const n = [f.wrTitle, f.wrNote, f.wrLink].filter(filled).length;
  return n > 0 && n < 3;
}

/**
 * The form → the sections a save sends. An empty text section is left out (the
 * save replaces the sections whole, so leaving it out clears it). Worth Reading
 * goes as all three fields, as typed, when any of them is filled — so a
 * missing link is refused by the Worker as `invalid_link`, never sent half.
 */
export function formToSections(f: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (filled(f.lead)) out.lead = f.lead;
  if (filled(f.kevinsRead)) out.kevinsRead = f.kevinsRead;
  if (filled(f.insideAgriculture)) out.insideAgriculture = f.insideAgriculture;
  if (filled(f.wrTitle) || filled(f.wrNote) || filled(f.wrLink)) {
    out.worthReading = { title: f.wrTitle, note: f.wrNote, link: f.wrLink };
  }
  if (filled(f.closer)) out.closer = f.closer;
  return out;
}

/**
 * A save's `{ date, z: { status, reason? } }` → the editor's Z. An available Z
 * the editor already shows in full is kept (the working key pins it); otherwise
 * the status is shown until the re-read brings the value.
 */
export function zAfterSave(raw: unknown, current: EditorZ): EditorZ {
  const z = isObj(raw) && isObj(raw.z) ? raw.z : null;
  if (z?.status === "unavailable") return { kind: "view", z: { status: "unavailable", reason: typeof z.reason === "string" ? z.reason : "unrecognized_z" } };
  if (z?.status === "available") return current.kind === "view" && current.z.status === "available" ? current : { kind: "available_no_detail" };
  return { kind: "view", z: { status: "unavailable", reason: "unrecognized_z" } };
}
