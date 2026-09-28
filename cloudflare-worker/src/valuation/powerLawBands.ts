// KV loader and classifier for the Daybreak power-law Z BANDS (spec §3.4.3;
// decisions/2026-09-25-daybreak-member-screen-seven-rulings.md, Ruling 1).
//
// ONE key, `daybreak_powerlaw_bands_v1`, holding JSON
//   { "bands": [ { "lower": null,   "upper": <n>,  "label": "<Kevin's label>" },
//                { "lower": <n>,    "upper": <m>,  "label": "…" },
//                …
//                { "lower": <m>,    "upper": null, "label": "…" } ] }
// in the PRICES_CACHE namespace, beside powerLawParams.ts's key. An ORDERED,
// CONTIGUOUS table, OPEN-ENDED at both extremes (`null` stands for −∞ on the
// first band and +∞ on the last, because JSON has no infinity). The LOWER bound
// is INCLUSIVE: a band holds z when lower ≤ z < upper.
//
// The values are Kevin's calibration; seeding the key is Ethan's. Nothing in
// this repo writes it — this module only reads.
//
// ⚠ ONE SOURCE. This key is the only band table for the power-law Z. The web
// app renders what intake stamped into each edition and holds no copy
// (decisions/2026-09-25-daybreak-no-third-table-scope-valuation-zones-not-
// power-law-bands.md). It is NOT the valuation composite's zone table
// (valuation/zones.ts), which classifies a different number.
//
// ⚠ IT FAILS CLOSED, like powerLawParams.ts and for the same reason: a guessed
// band is a confident, wrong label with nothing on the page to say so. Absent,
// unparseable, wrong-shape, unordered, overlapping and gapped tables each
// return { ok: false } with their own reason and no bands. The caller still
// shows the Z — only the classification is withheld.
//
// A KV read that THROWS is not caught here, exactly as in powerLawParams.ts: it
// propagates, which is also closed.

export const POWER_LAW_BANDS_KV_KEY = "daybreak_powerlaw_bands_v1";

export interface PowerLawBand {
  lower: number | null;
  upper: number | null;
  label: string;
}

export type PowerLawBandsUnavailable = "absent" | "unparseable" | "wrong_shape" | "unordered" | "overlapping" | "gapped";

export type BandTableCheck =
  | { ok: true; bands: PowerLawBand[] }
  | { ok: false; reason: Exclude<PowerLawBandsUnavailable, "absent" | "unparseable">; detail: string };

export type PowerLawBandsLoad =
  | { ok: true; bands: PowerLawBand[] }
  | { ok: false; reason: PowerLawBandsUnavailable; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isBound(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Validates a band table and REBUILDS it — each band is exactly
 * { lower, upper, label }, so no other key survives. Checks run in a fixed
 * order: shape, then order, then each adjacent pair for overlap or gap.
 */
export function checkBandTable(value: unknown): BandTableCheck {
  if (!isPlainObject(value) || !Array.isArray(value.bands) || value.bands.length === 0) {
    return { ok: false, reason: "wrong_shape", detail: "expected { bands: [ …at least one band ] }" };
  }
  const raw: unknown[] = value.bands;
  const bands: PowerLawBand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (!isPlainObject(b) || !isBound(b.lower) || !isBound(b.upper) || typeof b.label !== "string" || b.label.trim() === "") {
      return { ok: false, reason: "wrong_shape", detail: `band ${i} must be { lower: number|null, upper: number|null, label: non-empty string }` };
    }
    bands.push({ lower: b.lower, upper: b.upper, label: b.label });
  }

  const last = bands.length - 1;
  for (let i = 0; i <= last; i++) {
    const openLower = bands[i].lower === null;
    const openUpper = bands[i].upper === null;
    if (openLower !== (i === 0) || openUpper !== (i === last)) {
      return { ok: false, reason: "wrong_shape", detail: `the table must be open-ended at both extremes and closed inside it (band ${i})` };
    }
  }

  for (let i = 0; i <= last; i++) {
    const { lower, upper } = bands[i];
    if (lower !== null && upper !== null && !(lower < upper)) {
      return { ok: false, reason: "unordered", detail: `band ${i}'s lower bound ${lower} is not below its upper bound ${upper}` };
    }
    if (i >= 2 && !((bands[i].lower as number) > (bands[i - 1].lower as number))) {
      return { ok: false, reason: "unordered", detail: `band ${i} does not start above band ${i - 1}` };
    }
  }

  for (let i = 1; i <= last; i++) {
    const prevUpper = bands[i - 1].upper as number;
    const lower = bands[i].lower as number;
    if (lower < prevUpper) {
      return { ok: false, reason: "overlapping", detail: `band ${i} starts at ${lower}, inside band ${i - 1}, which ends at ${prevUpper}` };
    }
    if (lower > prevUpper) {
      return { ok: false, reason: "gapped", detail: `band ${i} starts at ${lower}, leaving a gap after band ${i - 1}, which ends at ${prevUpper}` };
    }
  }

  return { ok: true, bands };
}

/** Whether a band holds z. The lower bound is inclusive; null is unbounded. */
export function bandContains(band: PowerLawBand, z: number): boolean {
  return (band.lower === null || z >= band.lower) && (band.upper === null || z < band.upper);
}

/**
 * The index of the one band holding z. A table that passed checkBandTable is
 * contiguous and open-ended, so exactly one band holds every finite z.
 */
export function classifyZ(bands: PowerLawBand[], z: number): number {
  const index = bands.findIndex((b) => bandContains(b, z));
  if (index < 0) throw new RangeError(`no band holds z=${z}; the table was not checked`);
  return index;
}

export async function loadPowerLawBands(kv: KVNamespace): Promise<PowerLawBandsLoad> {
  const raw = await kv.get(POWER_LAW_BANDS_KV_KEY);
  if (raw === null) {
    return { ok: false, reason: "absent", detail: `KV key ${POWER_LAW_BANDS_KV_KEY} is not set` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `KV key ${POWER_LAW_BANDS_KV_KEY} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const checked = checkBandTable(parsed);
  if (!checked.ok) return { ok: false, reason: checked.reason, detail: `KV key ${POWER_LAW_BANDS_KV_KEY}: ${checked.detail}` };
  return { ok: true, bands: checked.bands };
}
