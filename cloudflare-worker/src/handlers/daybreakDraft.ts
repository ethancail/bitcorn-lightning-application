// POST /daybreak/draft — the drafting agent's write (spec §3.4.4). Radar, an
// external agent on the Hyperagent platform, drafts each edition overnight and
// posts it here. The route writes ONLY `daybreak:<date>:draft`, only through
// intake, and only for the NEXT due date. It cannot publish, and cannot touch
// Kevin's working copy.
//
// ─── REQUEST ─────────────────────────────────────────────────────────────
//
//   Authorization: Bearer <DAYBREAK_DRAFT_SECRET>
//   { "date": "YYYY-MM-DD", "sections": { lead, kevinsRead, insideAgriculture, worthReading, closer } }
//
// The header is Ethan's ruling of 2026-09-25, made before Kevin confirmed what
// Hyperagent's Locked mode sends (spec §3.4.4 recorded it as not decided).
//
// ─── ORDER — each step decides before the next one runs ─────────────────
//
//   1. Secret unset or empty       → 503 daybreak_draft_not_configured
//                                    (as the JWT routes answer an unset key)
//   2. Bearer absent / not Bearer  → 401 missing_bearer
//      Bearer wrong                → 401 invalid_bearer
//      ⚠ Nothing has touched the body yet. That is STRICTER than the HMAC
//      routes, which must read the body to verify a signature (Ruling 3).
//   3. Body over DRAFT_BODY_MAX_BYTES → 413 body_too_large
//   4. Not UTF-8 JSON              → 400 invalid_json
//      Not a JSON object           → 400 invalid_body
//      A key other than date/sections → 400 invalid_body + field
//   5. Date malformed or absent    → 400 invalid_date
//      Date not the next due date  → 422 not_next_due_date
//   6. Sections off-contract       → 400 invalid_sections | unknown_section |
//                                    invalid_section | invalid_link (+ field)
//   7. Intake (Yahoo closes)       → 200 { date, z: { status, reason? } }
//      Storage failure             → 503 daybreak_draft_write_failed
//
// ─── CODES ONLY ──────────────────────────────────────────────────────────
//
// Every response body is a code, a field name, a date, or a Z status and
// reason code. No `detail` ever leaves this handler: intake's details can name
// KV keys and computation intermediates, so they go to the log only.
//
// ─── THE CLOCK ───────────────────────────────────────────────────────────
//
// `new Date()` is read here once, only to accept or reject the stated date. The
// key written is always the STATED date (Ruling E), never one derived from the
// clock. The Yahoo adapter reads the clock too, through its injected `now`: to
// decide which bars are finished, and to stamp `fetchedAt`.
//
// ⚠ A RE-POST OVERWRITES the draft for that date (writeDraft, store.ts). That
// never reaches Kevin's working copy or the published edition.

import { CORS_HEADERS } from "../lib/cors";
import { extractBearerToken } from "../lib/jwt";
import type { Env } from "../lib/types";
import { DEFAULT_DAYBREAK_CALENDAR, isCentralDate, nextDueDate } from "../daybreak/dates";
import { WORKER_OWNED_KEY, runDraftIntake } from "../daybreak/intake";
import { validateSections } from "../daybreak/sections";
import { readDraft } from "../daybreak/store";
import { createYahooCloseFetcher } from "../daybreak/yahooCloses";

/**
 * 32 KiB. A real edition is ~3–4 KB of JSON: Kevin's source spec sizes Kevin's
 * Read at 150–250 words and every other section at one to four sentences, or a
 * link and one sentence. The cap leaves ~8× headroom for a long draft,
 * multi-byte text and JSON escaping.
 */
export const DRAFT_BODY_MAX_BYTES = 32 * 1024;

const ENVELOPE_KEYS = ["date", "sections"];

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Constant-time, and length-blind: both values are hashed to 32-byte SHA-256
 * digests first, so the runtime's timingSafeEqual always compares two equal
 * lengths — it would throw on unequal ones, and checking length first would
 * leak the secret's length.
 */
export async function bearerMatches(presented: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Reads at most `max` bytes. A declared Content-Length over the cap is refused
 * unread; otherwise the stream is counted as it arrives and cancelled the moment
 * it passes the cap, so an oversized body is never buffered whole.
 */
export async function readCappedBody(request: Request, max: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false };
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}

export async function handleDaybreakDraft(request: Request, env: Env): Promise<Response> {
  // 1. Configured?
  const secret = env.DAYBREAK_DRAFT_SECRET;
  if (!secret) return json({ error: "daybreak_draft_not_configured" }, 503);

  // 2. The bearer — before anything reads the body.
  const bearer = extractBearerToken(request);
  if (!bearer) return json({ error: "missing_bearer" }, 401);
  if (!(await bearerMatches(bearer, secret))) return json({ error: "invalid_bearer" }, 401);

  // 3. Only now, the body — capped.
  const body = await readCappedBody(request, DRAFT_BODY_MAX_BYTES);
  if (!body.ok) return json({ error: "body_too_large" }, 413);

  // 4. JSON, and the envelope.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.bytes));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isPlainObject(parsed)) return json({ error: "invalid_body" }, 400);
  const extra = Object.keys(parsed).find((k) => !ENVELOPE_KEYS.includes(k));
  if (extra !== undefined) return json({ error: "invalid_body", field: extra }, 400);

  // 5. Only the next due date.
  const { date, sections } = parsed;
  if (!isCentralDate(date)) return json({ error: "invalid_date" }, 400);
  if (date !== nextDueDate(new Date(), DEFAULT_DAYBREAK_CALENDAR)) return json({ error: "not_next_due_date" }, 422);

  // 6. The section-key contract.
  const checked = validateSections(sections);
  if (!checked.ok) {
    const { ok: _ok, ...rejection } = checked;
    return json({ error: rejection.code, ...("field" in rejection ? { field: rejection.field } : {}) }, 400);
  }

  // 7. Intake, then read the stamped Z back for its status and reason.
  try {
    const fetcher = createYahooCloseFetcher({ fetch: (url, init) => fetch(url, init), now: () => new Date() });
    const written = await runDraftIntake(
      { kv: env.PRICES_CACHE, fetcher },
      date,
      sections as Record<string, unknown>,
    );
    if (!written.ok) {
      console.error(`[daybreak-draft] intake refused ${date}: ${written.reason}: ${written.detail}`);
      return json({ error: "daybreak_draft_write_failed" }, 503);
    }
    const stored = await readDraft(env.PRICES_CACHE, date);
    const owned = stored.ok && stored.found ? stored.content[WORKER_OWNED_KEY] : undefined;
    const z = isPlainObject(owned) && isPlainObject(owned.z) ? owned.z : undefined;
    if (!z || typeof z.status !== "string") {
      console.error(`[daybreak-draft] draft for ${date} was written but its Z block could not be read back`);
      return json({ error: "daybreak_draft_write_failed" }, 503);
    }
    return json({
      date,
      z: z.status === "unavailable" && typeof z.reason === "string" ? { status: z.status, reason: z.reason } : { status: z.status },
    });
  } catch (err) {
    console.error("[daybreak-draft] write threw:", err instanceof Error ? err.message : String(err));
    return json({ error: "daybreak_draft_write_failed" }, 503);
  }
}
