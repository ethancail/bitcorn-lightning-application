// Member-facing copy for the Daybreak screen — spec §3.4.3, rulings 4 and 7,
// first tests 40 (function level) and 45.
//
// ⚠ COPY RULE, ENFORCED. On a member node the farmer IS the node operator, so
// "ask your node operator" routes them back to themselves. The ban list is the
// one in ../components/certExpiryNotice.test.ts:225-231, the broadest of the
// app's three, reused verbatim; a parity check below fails if that source list
// changes and this one does not follow.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allDaybreakCopy,
  bandsUnavailableCopy,
  daybreakErrorCopy,
  GENERIC_ERROR,
  HELD_OVER_MARK,
  HELD_OVER_NOTE,
  zUnavailableCopy,
} from "./daybreakCopy";

const BANNED = [
  /ask your (node )?operator/i,
  /contact your (node )?operator/i,
  /ask the operator/i,
  /your operator/i,
  /the node operator/i,
];

// Every code a member's browser can receive from GET /api/daybreak/edition
// (app/api/src/daybreak/editionClient.ts:94-111 and app/api/src/index.ts:1870).
// scope_insufficient is listed apart: it is a real proxy code, but it is RULED
// to show the generic state (it cannot occur on this payment-gated route, and
// any tier wording would be false — every tier includes Daybreak).
const GENERIC_BY_RULING = ["scope_insufficient"];
const PROXY_CODES = [
  "node_role_required",
  "auth_missing",
  "auth_invalid",
  "worker_unavailable",
  "upstream_error",
  "invalid_worker_response",
  "worker_unreachable",
  "worker_not_configured",
];
const WORKER_REASONS = ["daybreak_read_failed", "service_unconfigured"];
const Z_REASONS = ["params_unavailable", "fetch_failed", "future_dated_close", "stale_close", "computation_failed", "unrecognized_z"];
const BANDS_REASONS = ["absent", "unparseable", "wrong_shape", "unordered", "overlapping", "gapped", "unrecognized_bands"];

// ─── Test 45 ───────────────────────────────────────────────────────────────

describe("test 45: no Daybreak copy tells a farmer to contact an operator", () => {
  it("permitting: the enumeration covers real copy for every code and reason", () => {
    const all = allDaybreakCopy();
    expect(all.length).toBeGreaterThan(20);
    for (const s of all) expect(s.trim().length, "every string is non-empty").toBeGreaterThan(0);
  });

  it("forbidding: no output matches the ban list", () => {
    for (const s of allDaybreakCopy()) {
      for (const re of BANNED) expect(s, `matched ${re}`).not.toMatch(re);
    }
  });

  it("anti-vacuity: the ban list matches the phrases it is meant to catch", () => {
    for (const probe of [
      "Please ask your node operator for help",
      "If this persists, contact your operator",
      "You should ask the operator to fix it",
      "Share this with your operator",
      "This needs the node operator, not a retry.",
    ]) {
      expect(BANNED.some((re) => re.test(probe)), probe).toBe(true);
    }
  });

  it("parity: each regex is the one in certExpiryNotice.test.ts", () => {
    const src = readFileSync(join(__dirname, "..", "components", "certExpiryNotice.test.ts"), "utf8");
    for (const re of BANNED) expect(src, `certExpiryNotice.test.ts no longer carries ${re}`).toContain(re.toString());
  });
});

// ─── Test 40 at the function level ─────────────────────────────────────────

describe("test 40 (function level): anything without a recognised code gets the ONE generic state", () => {
  it("permitting: no error object, no code, a non-string code, an unknown code and HTTP status text all give the generic copy", () => {
    for (const err of [null, {}, { code: 502 }, { code: "brand_new_code" }, { code: "Bad Gateway" }, { code: "Not Found" }, { code: "Failed to fetch" }]) {
      expect(daybreakErrorCopy(err)).toEqual(GENERIC_ERROR);
    }
  });

  it("forbidding: the generic copy never echoes what it was given", () => {
    for (const code of ["brand_new_code", "Bad Gateway", "Failed to fetch"]) {
      const c = daybreakErrorCopy({ code });
      expect(`${c.headline} ${c.body}`).not.toContain(code);
    }
  });

  it("anti-vacuity: every recognised code gets its OWN words, not the generic state", () => {
    for (const code of PROXY_CODES) expect(daybreakErrorCopy({ code }), code).not.toEqual(GENERIC_ERROR);
  });

  it("scope_insufficient shows the generic state, by ruling — no tier wording", () => {
    for (const code of GENERIC_BY_RULING) expect(daybreakErrorCopy({ code }), code).toEqual(GENERIC_ERROR);
    expect(allDaybreakCopy().some((s) => /included in your current subscription/i.test(s))).toBe(false);
  });

  it("the Worker's own 503 reasons each get words; an unknown nested reason still reads as worker_unavailable", () => {
    const base = daybreakErrorCopy({ code: "worker_unavailable" });
    for (const reason of WORKER_REASONS) expect(daybreakErrorCopy({ code: "worker_unavailable", reason })).not.toEqual(GENERIC_ERROR);
    expect(daybreakErrorCopy({ code: "worker_unavailable", reason: "some_new_reason" })).toEqual(base);
  });
});

// ─── Strings as approved by Ethan, 2026-09-25 — pinned verbatim ────────────

describe("approved strings, pinned verbatim", () => {
  it("node_role_required", () => {
    expect(daybreakErrorCopy({ code: "node_role_required" })).toEqual({
      headline: "Daybreak isn't available yet",
      body: "Your node is still setting up. Daybreak will appear once it finishes.",
    });
  });

  it("auth_missing: new headline, body unchanged", () => {
    expect(daybreakErrorCopy({ code: "auth_missing" })).toEqual({
      headline: "Daybreak is waiting on your node",
      body: "This node doesn't have its subscription pass yet. If you've just installed or restarted, give it a minute. This page will try again on its own. You can check your subscription in Settings.",
    });
  });

  it("worker_unreachable", () => {
    expect(daybreakErrorCopy({ code: "worker_unreachable" })).toEqual({
      headline: "Daybreak couldn't be reached",
      body: "Your node couldn't reach BitCorn's services just now. This page will try again on its own. If it keeps happening, check that your node is online.",
    });
  });

  it("worker_not_configured: new body", () => {
    expect(daybreakErrorCopy({ code: "worker_not_configured" }).body).toBe(
      "The BitCorn app on this node is missing the address it uses to reach BitCorn's services. This is unusual — updating the BitCorn app from the Umbrel app store is the first thing to try.",
    );
  });

  it("held over: the mark and its note", () => {
    expect(HELD_OVER_MARK).toBe("Held over");
    expect(HELD_OVER_NOTE).toBe("Today's edition hasn't been published. This is the most recent one.");
  });

  it("the generic state", () => {
    expect(GENERIC_ERROR.headline).toBe("Daybreak couldn't load");
  });
});

describe("every Z and bands reason has member-facing words", () => {
  it("each Z reason, and an unknown one", () => {
    for (const r of [...Z_REASONS, "not_a_reason"]) expect(zUnavailableCopy(r).length).toBeGreaterThan(0);
  });

  it("each bands reason, and an unknown one", () => {
    for (const r of [...BANDS_REASONS, "not_a_reason"]) expect(bandsUnavailableCopy(r).length).toBeGreaterThan(0);
  });

  it("the copy never shows a raw code", () => {
    for (const r of [...Z_REASONS, ...BANDS_REASONS, ...PROXY_CODES, ...WORKER_REASONS]) {
      for (const s of allDaybreakCopy()) expect(s).not.toContain(r);
    }
  });
});
