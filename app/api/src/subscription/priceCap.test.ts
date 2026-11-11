// The cap and the integer check (bitcorn-research specs/2026-11-10-treasury-
// price-trust-spec.md §5, D3).
//
// C13: the shipped cap is set. Its value was ruled by Ethan, 2026-11-11
// (100,000 sats). A build with no usable cap fails closed, and this test
// fails with it.

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PRICE_CAP_SATS, checkSubscriptionPrice, isUsableCap } from "./priceCap";

describe("C13 — the shipped cap is set", () => {
  it("SUBSCRIPTION_PRICE_CAP_SATS is a positive safe integer", () => {
    expect(
      isUsableCap(SUBSCRIPTION_PRICE_CAP_SATS),
      `SUBSCRIPTION_PRICE_CAP_SATS is ${String(SUBSCRIPTION_PRICE_CAP_SATS)}: a build with no cap pays nothing`,
    ).toBe(true);
  });
});

describe("the doc states the shipped cap (docs/API.md § Subscription price cap)", () => {
  const repo = path.resolve(__dirname, "../../../..");
  const doc = fs.readFileSync(path.join(repo, "docs/API.md"), "utf8");
  const capSrc = fs.readFileSync(path.join(__dirname, "priceCap.ts"), "utf8");

  it("the number in the doc equals the constant", () => {
    // Anti-vacuity: the section exists and states the value exactly once.
    expect(doc, "docs/API.md has no § Subscription price cap").toMatch(/^### Subscription price cap$/m);
    const stated = [...doc.matchAll(/`SUBSCRIPTION_PRICE_CAP_SATS = ([\d,]+) sats`/g)].map((m) => Number(m[1].replace(/,/g, "")));
    expect(stated, "the doc should state the cap once, as `SUBSCRIPTION_PRICE_CAP_SATS = N sats`").toHaveLength(1);
    expect(stated[0], "docs/API.md states a different cap from priceCap.ts").toBe(SUBSCRIPTION_PRICE_CAP_SATS);
  });

  it("the file:line in the doc is the constant's line", () => {
    const m = doc.match(/`app\/api\/src\/subscription\/priceCap\.ts:(\d+)`/);
    expect(m, "the doc does not give priceCap.ts:<line>").not.toBeNull();
    const line = capSrc.split("\n")[Number(m![1]) - 1];
    expect(line, `docs/API.md points at priceCap.ts:${m![1]}`).toMatch(/^export const SUBSCRIPTION_PRICE_CAP_SATS\b/);
  });
});

describe("C13 — the check reads the cap from the one module", () => {
  const src = path.resolve(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) files.push(p);
    }
  };
  walk(src);

  it("SUBSCRIPTION_PRICE_CAP_SATS is DEFINED in priceCap.ts only", () => {
    const definers = files.filter((f) =>
      /(const|let|var)\s+SUBSCRIPTION_PRICE_CAP_SATS\b/.test(fs.readFileSync(f, "utf8")),
    );
    expect(definers.map((f) => path.relative(src, f))).toEqual(["subscription/priceCap.ts"]);
  });

  // Every call of the two checks, with its arguments (parentheses balanced, so
  // multi-line calls with nested calls are read whole).
  function callsOf(text: string, fn: string): string[] {
    const out: string[] = [];
    let at = text.indexOf(`${fn}(`);
    while (at !== -1) {
      let depth = 0;
      let end = at + fn.length;
      for (; end < text.length; end++) {
        if (text[end] === "(") depth++;
        else if (text[end] === ")" && --depth === 0) break;
      }
      const call = text.slice(at, end + 1);
      // Skip the function's own definition.
      if (!/^\w+\(\s*\w+\s*:/.test(call)) out.push(call);
      at = text.indexOf(`${fn}(`, end);
    }
    return out;
  }

  it("every caller passes the constant imported from priceCap (payTargetRefusal forwards its own `cap`)", () => {
    const sites: Array<{ file: string; call: string }> = [];
    for (const f of files) {
      if (f.endsWith("priceCap.ts")) continue;
      const text = fs.readFileSync(f, "utf8");
      for (const fn of ["checkSubscriptionPrice", "payTargetRefusal"]) {
        for (const call of callsOf(text, fn)) sites.push({ file: path.relative(src, f), call });
      }
    }
    // Anti-vacuity: the money paths and the proxy label do call them.
    expect([...new Set(sites.map((s) => s.file))].sort()).toEqual([
      "index.ts",
      "subscription/autoPayHandler.ts",
      "subscription/autoPayScheduler.ts",
      "subscription/payFromNode.ts",
    ]);
    for (const { file, call } of sites) {
      const forwarded = file === "subscription/payFromNode.ts" && call === "checkSubscriptionPrice(target.price_sats, cap)";
      expect(forwarded || /,\s*SUBSCRIPTION_PRICE_CAP_SATS,?\s*\)$/.test(call), `${file}: ${call}`).toBe(true);
    }
    for (const file of new Set(sites.map((s) => s.file))) {
      const text = fs.readFileSync(path.join(src, file), "utf8");
      expect(text, file).toMatch(/import \{[^}]*SUBSCRIPTION_PRICE_CAP_SATS[^}]*\} from "\.\/(subscription\/)?priceCap"/);
    }
  });
});

describe("checkSubscriptionPrice", () => {
  const CAP = 54_321; // test-only

  it("accepts a positive whole number at or below the cap; refuses one above (C6)", () => {
    expect(checkSubscriptionPrice(CAP, CAP)).toEqual({ ok: true });
    expect(checkSubscriptionPrice(1, CAP)).toEqual({ ok: true });
    expect(checkSubscriptionPrice(CAP + 1, CAP)).toMatchObject({ ok: false, code: "price_above_cap" });
  });

  it("refuses anything that is not a positive safe integer as price_not_integer (C7)", () => {
    for (const bad of [CAP - 0.5, 0, -1, Number.NaN, Infinity, 2 ** 53, "50000", null, undefined]) {
      expect(checkSubscriptionPrice(bad, CAP), String(bad)).toMatchObject({ ok: false, code: "price_not_integer" });
    }
  });

  it("FAILS CLOSED with no usable cap: every price is refused price_above_cap", () => {
    for (const cap of [undefined, 0, -5, 1.5, Number.NaN]) {
      expect(checkSubscriptionPrice(1, cap as number | undefined), String(cap)).toMatchObject({
        ok: false,
        code: "price_above_cap",
      });
    }
    // An unset shipped default would fail closed the same way.
    if (!isUsableCap(SUBSCRIPTION_PRICE_CAP_SATS)) {
      expect(checkSubscriptionPrice(1, SUBSCRIPTION_PRICE_CAP_SATS)).toMatchObject({ ok: false, code: "price_above_cap" });
    }
  });

  it("the shipped cap admits the price it was set against (50,000 sats) and refuses one sat above itself", () => {
    expect(checkSubscriptionPrice(50_000, SUBSCRIPTION_PRICE_CAP_SATS)).toEqual({ ok: true });
    expect(checkSubscriptionPrice(SUBSCRIPTION_PRICE_CAP_SATS, SUBSCRIPTION_PRICE_CAP_SATS)).toEqual({ ok: true });
    expect(checkSubscriptionPrice((SUBSCRIPTION_PRICE_CAP_SATS ?? 0) + 1, SUBSCRIPTION_PRICE_CAP_SATS)).toMatchObject({
      ok: false,
      code: "price_above_cap",
    });
  });
});
