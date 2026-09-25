// GET /daybreak/edition — the Daybreak member read (spec §3.4.2).
//
// Which edition a member sees right now, and whether it is held over, straight
// from store.ts's readEditionStatus at the current time and the DEFAULT
// calendar (ruled 2026-09-24: the calendar's SOURCE is the code default; which
// days are due stays Ethan's). No cache: every call is a fresh status read
// (same ruling — dashboards poll every 5 minutes, and the interval lives in the
// web client, not here).
//
// ─── CODES, NOT DETAIL (same ruling) ────────────────────────────────────
//
// The published edition's Worker-owned block is rebuilt by ALLOWLIST — never by
// deleting fields known to be bad, because the next field nobody thought of
// would then pass through by default:
//   - an unavailable Z carries its reason code and NOTHING free-text. Its
//     `detail` can name KV keys, a parameter value or computation
//     intermediates (powerLawParams.ts:39, powerLawZ.ts:128-129, :170);
//   - an available Z carries its value and both closes (date, close, fetchedAt);
//   - any other key, at any level of the block, is dropped. A Z block that
//     fits neither shape — including an unavailable one whose reason is not a
//     known code — is shown as unavailable with Z_UNRECOGNIZED, never dropped
//     and never guessed at: none of its stored fields is carried (ruled
//     2026-09-24).
// The written sections pass through untouched: their schema is not this
// module's. This is hygiene, not secrecy — an available Z discloses the model's
// parameters over time regardless.
//
// ─── FAILURE: ONE GENERIC CODE ───────────────────────────────────────────
//
// store.ts fails closed on read: a corrupt published value is { ok: false }
// with a detail naming its KV key, and a KV call that throws propagates. Both
// are caught HERE and answered with DAYBREAK_READ_FAILED as a 503, so no
// response body can carry a key name. The underlying detail goes to the log.

import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";
import { DEFAULT_DAYBREAK_CALENDAR } from "../daybreak/dates";
import { WORKER_OWNED_KEY, type ZUnavailableReason } from "../daybreak/intake";
import { readEditionStatus, type EditionContent, type EditionStatusResult } from "../daybreak/store";

export const DAYBREAK_READ_FAILED = "daybreak_read_failed";

// The one reason a member sees for a Z block that fits neither shape.
export const Z_UNRECOGNIZED = "unrecognized_z";

// tsc fails here if intake.ts ever gains a reason spelled like the generic
// code, which would make the two indistinguishable to a member.
const _zUnrecognizedIsNotAnIntakeReason: typeof Z_UNRECOGNIZED extends ZUnavailableReason ? never : true = true;

// A Record rather than an array so tsc fails here if intake.ts gains a reason
// this list does not name.
const Z_UNAVAILABLE_REASONS: Record<ZUnavailableReason, true> = {
  params_unavailable: true,
  fetch_failed: true,
  future_dated_close: true,
  stale_close: true,
  computation_failed: true,
};

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function pickClose(c: unknown): Obj | undefined {
  if (!isPlainObject(c)) return undefined;
  const { date, close, fetchedAt } = c;
  if (typeof date !== "string" || typeof close !== "number" || typeof fetchedAt !== "string") return undefined;
  return { date, close, fetchedAt };
}

function pickZ(z: unknown): Obj | undefined {
  if (!isPlainObject(z)) return undefined;
  if (z.status === "available") {
    const corn = pickClose(z.corn);
    const btc = pickClose(z.btc);
    if (typeof z.value !== "number" || !corn || !btc) return undefined;
    return { status: "available", value: z.value, corn, btc };
  }
  if (z.status === "unavailable") {
    const reason = z.reason;
    if (typeof reason !== "string" || !Object.prototype.hasOwnProperty.call(Z_UNAVAILABLE_REASONS, reason)) {
      return undefined;
    }
    return { status: "unavailable", reason };
  }
  return undefined;
}

function sanitizeEditionContent(content: EditionContent): EditionContent {
  const { [WORKER_OWNED_KEY]: owned, ...sections } = content;
  if (owned === undefined) return sections;
  const safe: Obj = {};
  if (isPlainObject(owned) && Object.prototype.hasOwnProperty.call(owned, "z")) {
    safe.z = pickZ(owned.z) ?? { status: "unavailable", reason: Z_UNRECOGNIZED };
  }
  return { ...sections, [WORKER_OWNED_KEY]: safe };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleDaybreakEdition(env: Env): Promise<Response> {
  let result: EditionStatusResult;
  try {
    result = await readEditionStatus(env.PRICES_CACHE, new Date(), DEFAULT_DAYBREAK_CALENDAR);
  } catch (err) {
    console.error("[daybreak] edition read threw:", err instanceof Error ? err.message : String(err));
    return json({ error: DAYBREAK_READ_FAILED }, 503);
  }
  if (!result.ok) {
    console.error(`[daybreak] edition read failed: ${result.reason}: ${result.detail}`);
    return json({ error: DAYBREAK_READ_FAILED }, 503);
  }
  if (result.state === "unavailable") return json({ state: "unavailable" });
  return json({
    state: result.state,
    dueDate: result.dueDate,
    edition: { date: result.edition.date, content: sanitizeEditionContent(result.edition.content) },
  });
}
