// The Daybreak editor's three treasury proxies (spec §3.4.5, "THE TREASURY API
// ROUTES"), one per Worker editor route:
//
//   GET  /api/daybreak/editor          → GET  /daybreak/editor          (N's and P's editable copies)
//   POST /api/daybreak/editor/save     → POST /daybreak/editor/save     ({ date, sections })
//   POST /api/daybreak/editor/publish  → POST /daybreak/editor/publish  ({ date })
//
// The read takes no date: the Worker returns both editable editions in one
// response, so the browser never computes an edition date and no request
// carries a query string (dispatch matches req.url exactly).
//
// ─── IN THIS ORDER, each step deciding before the next runs ─────────────────
//
//   1. assertTreasury — the NODE-ROLE check, not caller authentication. Kevin's
//      login is tailnet membership (R1). On a member node the Worker is never
//      called. The 403 is a code, not assertTreasury's sentence.
//   2. DAYBREAK_EDITOR_SECRET unset → 503, no Worker call (as
//      /api/valuation/manual does with its HMAC).
//   3. COINBASE_WORKER_URL unset → 503, no Worker call.
//   4. Save and publish: `Content-Type: application/json` is REQUIRED, else
//      415 unsupported_content_type before the body is read (CSRF hardening:
//      a JSON POST cannot be sent cross-site without a CORS preflight).
//      Then the body is CAPPED here. Exempt routes skip the gate's
//      1 MiB buffering, and /api/valuation/manual's uncapped read is not the
//      precedent. A declared Content-Length over the cap is refused unread.
//   5. The Worker call, with `Authorization: Bearer <secret>` and nothing from
//      the caller: no User-Agent, address, cookie or other header is forwarded,
//      so no author is recorded (R1). The body goes through byte-for-byte; the
//      Worker validates it.
//
// ─── CODES ONLY ─────────────────────────────────────────────────────────────
//
// As daybreak/editionClient.ts keeps the member read's reasons: the Worker's
// code passes through only when shaped like a code, and each failure class
// keeps its own proxy code —
//
//   editor_refused         a Worker 4xx refusal; `reason` is its code and
//                          `field` a field NAME where the Worker gave one
//   worker_auth_rejected   Worker 401: the two sides' secrets disagree
//   worker_unavailable     Worker 503 with a reason code
//   upstream_error         any other non-OK, or a refusal whose `error` is not a code
//   invalid_worker_response  a 200 whose body is not JSON
//   worker_unreachable     network failure
//
// The Worker's `detail` and any transport message go to the log, never to a
// response. The secret goes to neither: it leaves only in the Authorization
// header.

import type http from "http";
import { ENV } from "../config/env";
import { assertTreasury } from "../utils/role";
import { readRawBody } from "../utils/request-replay";

/** Not below the Worker's own cap (EDITOR_BODY_MAX_BYTES, 32 KiB), so nothing the proxy forwards is refused there for size. */
export const EDITOR_PROXY_BODY_MAX_BYTES = 32 * 1024;

export type EditorRoute = "read" | "save" | "publish";

const WORKER_PATHS: Record<EditorRoute, string> = {
  read: "/daybreak/editor",
  save: "/daybreak/editor/save",
  publish: "/daybreak/editor/publish",
};

// What a relayed reason may look like: a short snake_case code, never prose.
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
// A relayed field NAME: a section key, or `worthReading.<title|note|link>`.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}(\.[A-Za-z][A-Za-z0-9_]{0,63})?$/;

type Reply = { status: number; body: Record<string, unknown> };

function send(res: http.ServerResponse, { status, body }: Reply): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function classifyWorkerFailure(route: EditorRoute, res: Response): Promise<Reply> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; field?: unknown; detail?: unknown } | null;
  const code = typeof body?.error === "string" && REASON_CODE.test(body.error) ? body.error : null;
  console.error(
    `[daybreak-editor] ${WORKER_PATHS[route]} → HTTP ${res.status}` +
      (typeof body?.error === "string" ? ` error=${body.error}` : "") +
      (body?.detail !== undefined ? ` detail=${String(body.detail)}` : ""),
  );
  if (res.status === 401) return { status: 502, body: { error: "worker_auth_rejected", ...(code && { reason: code }) } };
  if (res.status === 503 && code) return { status: 503, body: { error: "worker_unavailable", reason: code } };
  if (res.status >= 400 && res.status < 500 && code) {
    const field = typeof body?.field === "string" && FIELD_NAME.test(body.field) ? body.field : null;
    return { status: res.status, body: { error: "editor_refused", reason: code, ...(field && { field }) } };
  }
  return { status: 502, body: { error: "upstream_error", status: res.status } };
}

export async function handleDaybreakEditorProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: EditorRoute,
  nodeRole: string | undefined,
): Promise<void> {
  try {
    assertTreasury(nodeRole);
  } catch {
    return send(res, { status: 403, body: { error: "treasury_role_required" } });
  }
  const secret = ENV.daybreakEditorSecret;
  if (!secret) return send(res, { status: 503, body: { error: "editor_not_configured" } });
  if (!ENV.coinbaseWorkerUrl) return send(res, { status: 503, body: { error: "worker_not_configured" } });

  let body: Buffer | undefined;
  if (route !== "read") {
    // CSRF hardening, Daybreak-local: only a JSON POST, refused before the body
    // is read. A cross-site page can send text/plain, a form encoding or no
    // type at all WITHOUT a CORS preflight; application/json forces one, and
    // the preflight is answered by applyCorsAndPreflight's origin rules.
    const mediaType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return send(res, { status: 415, body: { error: "unsupported_content_type" } });
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > EDITOR_PROXY_BODY_MAX_BYTES) {
      return send(res, { status: 413, body: { error: "body_too_large" } });
    }
    try {
      body = await readRawBody(req, EDITOR_PROXY_BODY_MAX_BYTES);
    } catch {
      return send(res, { status: 413, body: { error: "body_too_large" } });
    }
  }

  const url = `${ENV.coinbaseWorkerUrl.replace(/\/+$/, "")}${WORKER_PATHS[route]}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: route === "read" ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: new Uint8Array(body) }),
    });
  } catch (err) {
    console.error(`[daybreak-editor] ${WORKER_PATHS[route]} transport error:`, err instanceof Error ? err.message : String(err));
    return send(res, { status: 503, body: { error: "worker_unreachable" } });
  }

  if (!upstream.ok) return send(res, await classifyWorkerFailure(route, upstream));

  let value: unknown;
  try {
    value = await upstream.json();
  } catch (err) {
    console.error(`[daybreak-editor] ${WORKER_PATHS[route]} returned 200 with a non-JSON body:`, err instanceof Error ? err.message : String(err));
    return send(res, { status: 502, body: { error: "invalid_worker_response" } });
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
