// The CMS's three editor routes (spec §3.4.5). The treasury API proxies Kevin's
// editor to these; the browser never reaches them. They sit beside the
// drafting agent's door, which they neither close nor narrow (R2).
//
//   GET  /daybreak/editor          — both editable editions, N's and P's
//   POST /daybreak/editor/save     — { date, sections } → daybreak:<date>:working
//   POST /daybreak/editor/publish  — { date }           → daybreak:<date>:published
//
// ─── AUTH ────────────────────────────────────────────────────────────────
//
//   Authorization: Bearer <DAYBREAK_EDITOR_SECRET>
//
// Held server-side by the treasury API (R3). Not DAYBREAK_DRAFT_SECRET, and not
// a member JWT: either is, here, just a wrong secret. No author, identity or
// caller detail is recorded anywhere (R1).
//
// ─── ORDER — each step decides before the next one runs ─────────────────
//
//   1. Secret unset or empty        → 503 daybreak_editor_not_configured
//   2. Bearer absent / not Bearer   → 401 missing_bearer
//      Bearer wrong                 → 401 invalid_bearer
//      ⚠ Nothing has touched the body or KV yet.
//   3. Body over EDITOR_BODY_MAX_BYTES → 413 body_too_large  (save, publish)
//   4. Not UTF-8 JSON               → 400 invalid_json
//      Not a JSON object            → 400 invalid_body
//      A key outside the envelope   → 400 invalid_body + field
//   5. Date malformed or absent     → 400 invalid_date
//      Date neither N nor P         → 422 not_editable_date
//   6. Sections off-contract (save) → 400 invalid_sections | unknown_section |
//                                     invalid_section | invalid_link (+ field)
//   7. Store                        → 200, or 409 nothing_to_publish (publish),
//                                     or 503 daybreak_editor_failed
//
// ─── WHICH EDITIONS (R6, as ruled 2026-10-07 by ruling (A)) ──────────────
//
// EXACTLY TWO dates: N = nextDueDate(now), the earliest due instant strictly
// after now, and P = mostRecentDueDate(now), the latest at or before it,
// published or not. The clock is read only to accept or reject; the key written
// is always the STATED date (Ruling E). At 06:00:00 Central on a due day both
// move together, so a save opened for N at 5:58 and sent after 6:00 lands on P.
// The read takes no date: it returns both, so the browser never computes one.
//
// ─── THE SAVE ────────────────────────────────────────────────────────────
//
// validateSections runs at the route BEFORE anything is written, so a supplied
// workerOwned is REJECTED — saveWorking alone would discard it silently. With
// no draft for the date (R8), the save first runs intake with the SAME sections,
// which writes the draft with a Worker-stamped Z, then saveWorking copies that
// Z. ⚠ So a no-draft save for P can store an unavailable Z with
// future_dated_close (intake fetches the latest completed closes); that is the
// spec's open finding, built as written and not worked around.
//
// ─── CODES ONLY ──────────────────────────────────────────────────────────
//
// Every body is a code, a field name, a date, a yes/no, the sanitised edition,
// or a Z status and reason code. The Worker-owned block goes through the member
// read's own allowlist (sanitizeEditionContent), so no detail, KV key name or
// unknown key reaches the editor. Store errors and KV throws are the one generic
// code; their detail goes to the log.

import { CORS_HEADERS } from "../lib/cors";
import { extractBearerToken } from "../lib/jwt";
import type { Env } from "../lib/types";
import { DEFAULT_DAYBREAK_CALENDAR, isCentralDate, mostRecentDueDate, nextDueDate, type CentralDate } from "../daybreak/dates";
import { WORKER_OWNED_KEY, runDraftIntake } from "../daybreak/intake";
import { validateSections } from "../daybreak/sections";
import { publishEdition, readDraft, readPublished, readWorking, type DaybreakStoreError } from "../daybreak/store";
import { saveWorking } from "../daybreak/workingSave";
import { createYahooCloseFetcher } from "../daybreak/yahooCloses";
import { sanitizeEditionContent } from "./daybreak";
import { bearerMatches, readCappedBody } from "./daybreakDraft";

/** 32 KiB, as the drafting route (DRAFT_BODY_MAX_BYTES): one edition's sections and a date. */
export const EDITOR_BODY_MAX_BYTES = 32 * 1024;

export const DAYBREAK_EDITOR_FAILED = "daybreak_editor_failed";

type Obj = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A store result that is not ok, as a thrown error whose message is for the log only. */
function storeFailure(r: DaybreakStoreError | { ok: false; reason: string; detail: string }): Error {
  return new Error(`${r.reason}: ${r.detail}`);
}

function failed(route: string, err: unknown): Response {
  console.error(`[daybreak-editor] ${route} failed:`, err instanceof Error ? err.message : String(err));
  return json({ error: DAYBREAK_EDITOR_FAILED }, 503);
}

/** Steps 1–2. Null means authorised; anything else is the refusal to send. */
async function refuseUnauthorised(request: Request, env: Env): Promise<Response | null> {
  const secret = env.DAYBREAK_EDITOR_SECRET;
  if (!secret) return json({ error: "daybreak_editor_not_configured" }, 503);
  const bearer = extractBearerToken(request);
  if (!bearer) return json({ error: "missing_bearer" }, 401);
  if (!(await bearerMatches(bearer, secret))) return json({ error: "invalid_bearer" }, 401);
  return null;
}

function editableDates(now: Date): { next: CentralDate; recent: CentralDate } | null {
  const next = nextDueDate(now, DEFAULT_DAYBREAK_CALENDAR);
  const recent = mostRecentDueDate(now, DEFAULT_DAYBREAK_CALENDAR);
  return next !== null && recent !== null ? { next, recent } : null;
}

/** Steps 3–5: the capped body, its envelope, and the date. */
async function readDatedEnvelope(
  request: Request,
  envelopeKeys: readonly string[],
): Promise<{ ok: true; date: CentralDate; body: Obj } | { ok: false; response: Response }> {
  const refuse = (body: Obj, status: number) => ({ ok: false as const, response: json(body, status) });

  const raw = await readCappedBody(request, EDITOR_BODY_MAX_BYTES);
  if (!raw.ok) return refuse({ error: "body_too_large" }, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.bytes));
  } catch {
    return refuse({ error: "invalid_json" }, 400);
  }
  if (!isPlainObject(parsed)) return refuse({ error: "invalid_body" }, 400);
  const extra = Object.keys(parsed).find((k) => !envelopeKeys.includes(k));
  if (extra !== undefined) return refuse({ error: "invalid_body", field: extra }, 400);

  const { date } = parsed;
  if (!isCentralDate(date)) return refuse({ error: "invalid_date" }, 400);
  const dates = editableDates(new Date());
  if (dates === null || (date !== dates.next && date !== dates.recent)) return refuse({ error: "not_editable_date" }, 422);
  return { ok: true, date, body: parsed };
}

/** One date's editable copy — working, else draft (F.2) — and whether it is published. */
async function editableEntry(kv: KVNamespace, date: CentralDate): Promise<Obj> {
  const published = await readPublished(kv, date);
  if (!published.ok) throw storeFailure(published);
  let copy = await readWorking(kv, date);
  if (!copy.ok) throw storeFailure(copy);
  if (!copy.found) {
    copy = await readDraft(kv, date);
    if (!copy.ok) throw storeFailure(copy);
  }
  if (!copy.found) return { date, published: published.found, code: "no_draft" };
  return { date, published: published.found, content: sanitizeEditionContent(copy.content) };
}

export async function handleDaybreakEditorRead(request: Request, env: Env): Promise<Response> {
  const refused = await refuseUnauthorised(request, env);
  if (refused) return refused;
  try {
    const dates = editableDates(new Date());
    if (dates === null) throw new Error("no due date within the calendar window");
    const next = await editableEntry(env.PRICES_CACHE, dates.next);
    const recent = await editableEntry(env.PRICES_CACHE, dates.recent);
    return json({ next, recent });
  } catch (err) {
    return failed("read", err);
  }
}

export async function handleDaybreakEditorSave(request: Request, env: Env): Promise<Response> {
  const refused = await refuseUnauthorised(request, env);
  if (refused) return refused;
  const envelope = await readDatedEnvelope(request, ["date", "sections"]);
  if (!envelope.ok) return envelope.response;
  const { date } = envelope;
  const sections = envelope.body.sections;

  const checked = validateSections(sections);
  if (!checked.ok) {
    const { ok: _ok, ...rejection } = checked;
    return json({ error: rejection.code, ...("field" in rejection ? { field: rejection.field } : {}) }, 400);
  }

  try {
    const kv = env.PRICES_CACHE;
    const draft = await readDraft(kv, date);
    if (!draft.ok) throw storeFailure(draft);
    if (!draft.found) {
      const fetcher = createYahooCloseFetcher({ fetch: (url, init) => fetch(url, init), now: () => new Date() });
      const created = await runDraftIntake({ kv, fetcher }, date, sections as Obj);
      if (!created.ok) throw storeFailure(created);
    }
    const saved = await saveWorking(kv, date, sections as Obj);
    if (!saved.ok) throw storeFailure(saved);

    // The working key's Z after the save, read back through the member read's
    // allowlist, so the status and reason are always known codes.
    const working = await readWorking(kv, date);
    if (!working.ok) throw storeFailure(working);
    if (!working.found) throw new Error(`working copy for ${date} was saved but could not be read back`);
    const z = (sanitizeEditionContent(working.content)[WORKER_OWNED_KEY] as { z: Obj }).z;
    return json({ date, z: z.status === "unavailable" ? { status: z.status, reason: z.reason } : { status: z.status } });
  } catch (err) {
    return failed("save", err);
  }
}

export async function handleDaybreakEditorPublish(request: Request, env: Env): Promise<Response> {
  const refused = await refuseUnauthorised(request, env);
  if (refused) return refused;
  const envelope = await readDatedEnvelope(request, ["date"]);
  if (!envelope.ok) return envelope.response;
  const { date } = envelope;

  try {
    const result = await publishEdition(env.PRICES_CACHE, date);
    if (!result.ok) {
      if (result.reason === "nothing_to_publish") return json({ error: "nothing_to_publish" }, 409);
      throw storeFailure(result);
    }
    return json({ date });
  } catch (err) {
    return failed("publish", err);
  }
}
