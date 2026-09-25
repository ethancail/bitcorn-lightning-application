// The Daybreak SECTION-KEY CONTRACT, as one shared validator (spec §3.4.4,
// Ruling 1). Radar's write route calls it today; the CMS save is meant to reuse
// it. The contract is the member screen's reading (§3.4.3, "AS BUILT";
// app/web/src/daybreak/daybreakView.ts, parseSections):
//
//   lead, kevinsRead, insideAgriculture, closer — plain strings
//   worthReading — ONE object { title: string, note: string, link: https URL }
//
// Every key is optional; an absent section is simply not rendered. ANYTHING
// ELSE IS REJECTED, never stripped (stripping was ruled out): an unknown key —
// the reserved `workerOwned` and a Z under any other name included — or a wrong
// shape. The first offence found is returned.
//
// ⚠ VALIDATION IS AT THE WRITE BOUNDARY ONLY. The store, intake and the member
// read stay opaque (Ruling 1). Three opaque-layer test fixtures disagree with
// this contract on purpose (§3.4.4, Correction B); they are not examples of it.
//
// ─── CODES ONLY ──────────────────────────────────────────────────────────
//
// A rejection is a code and, where there is one, a field NAME — never a value,
// never free text. The name is either a contract name (a key below, or
// `worthReading.<title|note|link>`) or the rejected key itself.

export const SECTION_KEYS = ["lead", "kevinsRead", "insideAgriculture", "worthReading", "closer"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

const TEXT_SECTIONS: readonly SectionKey[] = ["lead", "kevinsRead", "insideAgriculture", "closer"];
const WORTH_READING_FIELDS = ["title", "note", "link"] as const;

export type SectionsRejection =
  /** The sections value is not a plain JSON object. */
  | { ok: false; code: "invalid_sections" }
  /** A key outside the contract; `field` is the key itself (for Worth Reading, `worthReading.<key>`). */
  | { ok: false; code: "unknown_section"; field: string }
  /** A contract key holding the wrong shape. */
  | { ok: false; code: "invalid_section"; field: string }
  /** Worth Reading's link is missing, not a string, or not an absolute https: URL. */
  | { ok: false; code: "invalid_link"; field: "worthReading.link" };

export type SectionsValidation = { ok: true } | SectionsRejection;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isHttpsUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:"; // no base: a relative link throws
  } catch {
    return false;
  }
}

function validateWorthReading(v: unknown): SectionsValidation {
  if (!isPlainObject(v)) return { ok: false, code: "invalid_section", field: "worthReading" };
  for (const key of Object.keys(v)) {
    if (!(WORTH_READING_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, code: "unknown_section", field: `worthReading.${key}` };
    }
  }
  if (typeof v.title !== "string") return { ok: false, code: "invalid_section", field: "worthReading.title" };
  if (typeof v.note !== "string") return { ok: false, code: "invalid_section", field: "worthReading.note" };
  if (!isHttpsUrl(v.link)) return { ok: false, code: "invalid_link", field: "worthReading.link" };
  return { ok: true };
}

/** Checks edition sections against the contract. Reads only; never rewrites. */
export function validateSections(sections: unknown): SectionsValidation {
  if (!isPlainObject(sections)) return { ok: false, code: "invalid_sections" };
  for (const key of Object.keys(sections)) {
    if (!(SECTION_KEYS as readonly string[]).includes(key)) return { ok: false, code: "unknown_section", field: key };
    const value = sections[key];
    if (key === "worthReading") {
      const r = validateWorthReading(value);
      if (!r.ok) return r;
    } else if (TEXT_SECTIONS.includes(key as SectionKey) && typeof value !== "string") {
      return { ok: false, code: "invalid_section", field: key };
    }
  }
  return { ok: true };
}
