import { describe, expect, it } from "vitest";
import crypto from "crypto";
import {
  CONFIRMATION_HEADER,
  CONFIRMED_ROUTES,
  EXEMPT_MUTATIONS,
  classifyMutation,
  deriveConfirmation,
  findConfirmedRoute,
  verifyConfirmation,
} from "./action-confirmation";

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const route = (method: string, url: string) => {
  const r = findConfirmedRoute(method, url);
  if (!r) throw new Error(`no confirmed route for ${method} ${url}`);
  return r;
};

describe("derivation", () => {
  it("hashes name=value pairs in MAP ORDER, not object-key order", () => {
    const r = route("POST", "/api/treasury/rebalance/circular");
    // Body deliberately supplies the keys in a different order than the map.
    const d = deriveConfirmation(r, {
      url: "/api/treasury/rebalance/circular",
      body: { tokens: 50000, incoming_channel: "222", outgoing_channel: "111" },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.canonical).toBe("outgoing_channel=111&incoming_channel=222&tokens=50000");
    expect(d.value).toBe(sha("outgoing_channel=111&incoming_channel=222&tokens=50000"));
  });

  it("treats a numeric field the same whether sent as number or string", () => {
    const r = route("POST", "/api/treasury/expansion/execute");
    const asNum = deriveConfirmation(r, {
      url: "/api/treasury/expansion/execute",
      body: { peer_pubkey: "02ab", capacity_sats: 1000000 },
    });
    const asStr = deriveConfirmation(r, {
      url: "/api/treasury/expansion/execute",
      body: { peer_pubkey: "02ab", capacity_sats: "1000000" },
    });
    expect(asNum.ok && asStr.ok).toBe(true);
    if (!asNum.ok || !asStr.ok) return;
    expect(asNum.value).toBe(asStr.value);
  });

  it("does NOT trim text — a padded value is a different value", () => {
    const r = route("POST", "/api/pay");
    const a = deriveConfirmation(r, { url: "/api/pay", body: { payment_request: "lnbc1" } });
    const b = deriveConfirmation(r, { url: "/api/pay", body: { payment_request: " lnbc1" } });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
  });

  it("covers PRESENCE of an optional field: omitting it changes the value", () => {
    const r = route("POST", "/api/admin/swaps/loop-out");
    const without = deriveConfirmation(r, {
      url: "/api/admin/swaps/loop-out",
      body: { swap_request_id: "abc" },
    });
    const with_ = deriveConfirmation(r, {
      url: "/api/admin/swaps/loop-out",
      body: { swap_request_id: "abc", destination_address: "bc1qxyz" },
    });
    expect(without.ok && with_.ok).toBe(true);
    if (!without.ok || !with_.ok) return;
    expect(without.value).not.toBe(with_.value);
  });

  it("reads a Shape 2 path field out of the URL", () => {
    const r = route("POST", "/api/member-liquidity/recommendations/42/approve");
    const d = deriveConfirmation(r, {
      url: "/api/member-liquidity/recommendations/42/approve",
      body: {},
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.canonical).toBe("recommendation_id=42");
  });

  it("refuses a value containing a framing character rather than escaping it", () => {
    const r = route("POST", "/api/pay");
    const d = deriveConfirmation(r, { url: "/api/pay", body: { payment_request: "ln&bc=1" } });
    expect(d).toEqual({ ok: false, reason: "unsafe_value", field: "payment_request" });
  });

  it("refuses a non-object body", () => {
    const r = route("POST", "/api/pay");
    expect(deriveConfirmation(r, { url: "/api/pay", body: null })).toEqual({
      ok: false,
      reason: "not_an_object",
    });
    expect(deriveConfirmation(r, { url: "/api/pay", body: ["x"] })).toEqual({
      ok: false,
      reason: "not_an_object",
    });
  });

  it("refuses a non-finite number rather than hashing NaN", () => {
    const r = route("POST", "/api/treasury/expansion/execute");
    const d = deriveConfirmation(r, {
      url: "/api/treasury/expansion/execute",
      body: { peer_pubkey: "02ab", capacity_sats: "not-a-number" },
    });
    expect(d).toEqual({ ok: false, reason: "bad_number", field: "capacity_sats" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE EMPTY CASE. env.ts's `|| ""` idiom plus a naive `===` gives `"" === ""`
// -> pass. That exact bug was live in sync.ts:15 until two commits ago. These
// assert the behaviour directly instead of trusting the argument in the header
// comment — the comment is what would rot.
// ─────────────────────────────────────────────────────────────────────────────
describe("empty is rejected on BOTH sides", () => {
  const r = route("POST", "/api/pay");
  const ctx = { url: "/api/pay", body: { payment_request: "lnbc1" } };

  it("empty supplied header -> 400, never a pass", () => {
    const v = verifyConfirmation(r, ctx, "");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(400);
    expect(v.error).toBe("confirmation_required");
  });

  it("absent supplied header -> 400", () => {
    for (const supplied of [undefined, null]) {
      const v = verifyConfirmation(r, ctx, supplied);
      expect(v.ok).toBe(false);
    }
  });

  it("a REPEATED header (string[]) is refused, not coerced", () => {
    const v = verifyConfirmation(r, ctx, ["a", "b"]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(400);
  });

  it("empty field value -> 400, and cannot be matched by any header", () => {
    const emptyCtx = { url: "/api/pay", body: { payment_request: "" } };
    // Even supplying the hash of the empty canonical string must not pass.
    const v = verifyConfirmation(r, emptyCtx, sha("payment_request="));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(400);
  });

  it("BOTH empty -> 400. This is the `\"\" === \"\"` case, stated explicitly", () => {
    const v = verifyConfirmation(r, { url: "/api/pay", body: { payment_request: "" } }, "");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(400);
    expect(v.error).toBe("confirmation_required");
  });

  it("an empty NUMERIC field is caught before String(Number(\"\")) turns it into \"0\"", () => {
    const rr = route("POST", "/api/treasury/expansion/execute");
    const d = deriveConfirmation(rr, {
      url: "/api/treasury/expansion/execute",
      body: { peer_pubkey: "02ab", capacity_sats: "" },
    });
    expect(d).toEqual({ ok: false, reason: "missing_field", field: "capacity_sats" });
  });
});

describe("verification, three states", () => {
  const r = route("POST", "/api/pay");
  const ctx = { url: "/api/pay", body: { payment_request: "lnbc1xyz" } };
  const correct = sha("payment_request=lnbc1xyz");

  it("no confirmation -> 400 confirmation_required", () => {
    const v = verifyConfirmation(r, ctx, undefined);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect([v.status, v.error]).toEqual([400, "confirmation_required"]);
  });

  it("wrong confirmation -> 409 confirmation_mismatch", () => {
    const v = verifyConfirmation(r, ctx, sha("payment_request=SOMETHING_ELSE"));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect([v.status, v.error]).toEqual([409, "confirmation_mismatch"]);
  });

  it("correct confirmation -> ok", () => {
    expect(verifyConfirmation(r, ctx, correct)).toEqual({ ok: true });
  });

  it("a confirmation correct for DIFFERENT parameters -> 409 (replay with changed params)", () => {
    // Caller computed a valid confirmation for a 1k invoice, then swapped the body.
    const forOther = sha("payment_request=lnbc1_ONE_THOUSAND");
    const v = verifyConfirmation(r, { url: "/api/pay", body: { payment_request: "lnbc1_ONE_MILLION" } }, forOther);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(409);
  });

  it("a truncated-but-prefix-correct value -> 409, not a pass", () => {
    const v = verifyConfirmation(r, ctx, correct.slice(0, 32));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(409);
  });
});

describe("route classification fails closed", () => {
  it("classifies every confirmed route as confirm", () => {
    for (const r of CONFIRMED_ROUTES) {
      const url = r.match.kind === "exact" ? r.match.url : r.match.kind === "prefix" ? `${r.match.url}X` : `${r.match.prefix}1${r.match.suffix}`;
      expect(classifyMutation(r.method, url), `${r.method} ${url}`).toBe("confirm");
    }
  });

  it("classifies every exempt route as exempt", () => {
    for (const e of EXEMPT_MUTATIONS) {
      const url = e.match.kind === "exact" ? e.match.url : e.match.kind === "prefix" ? `${e.match.url}X` : `${e.match.prefix}1${e.match.suffix}`;
      expect(classifyMutation(e.method, url), `${e.method} ${url}`).toBe("exempt");
    }
  });

  it("an UNKNOWN mutation classifies as unknown, so the caller can fail closed", () => {
    expect(classifyMutation("POST", "/api/some/route/added/tomorrow")).toBe("unknown");
  });

  it("a query string does not sneak a capital route past the matcher", () => {
    // Dispatch compares req.url === "/api/pay", so "/api/pay?x=1" is NOT that
    // route there either. The two must agree, or the gate reads one route while
    // dispatch runs another.
    expect(classifyMutation("POST", "/api/pay?x=1")).toBe("unknown");
  });

  it("the header name is stable, since the shell idiom and the modal both hardcode it", () => {
    expect(CONFIRMATION_HEADER).toBe("x-bitcorn-confirm");
  });
});
