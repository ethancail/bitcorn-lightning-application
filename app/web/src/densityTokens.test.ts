// PR 5 and PR 6: the density tokens — round 1's variant b, Balanced (J1,
// picked) — and the shell, panel, table and dashboard selectors that read
// them. A token lands with the PR that first reads it, so this file also
// refuses a declared token nothing reads. PR 6 added the dashboards' tokens
// and X2's label size, --d-label (P5-5, P6-5).
// Read from styles.css (jsdom does not evaluate @media).

import { describe, expect, it } from "vitest";
import { cssRules, declsFor } from "./styleRules.testutil";

const PHONE = "(max-width: 767px)";

// b's values (J1's Balanced column; --d-label is X2's 0.8125rem).
const B: Record<string, string> = {
  "--d-page-py": "32px",
  "--d-page-px": "40px",
  "--d-page-py-ph": "20px",
  "--d-page-px-ph": "16px",
  "--d-maxw": "1280px",
  "--d-tile-pad": "20px",
  "--d-tile-pad-ph": "16px",
  "--d-gap": "16px",
  "--d-title-size": "0.8125rem",
  "--d-title-gap": "12px",
  "--d-table": "0.875rem",
  "--d-th": "0.75rem",
  "--d-td-py": "12px",
  "--d-td-px": "14px",
  "--d-th-py": "10px",
  // PR 6 (P5-5, P6-5): the dashboards.
  "--d-gap-inner": "12px",
  "--d-label-gap": "6px",
  "--d-label": "0.8125rem",
  "--d-body": "0.9375rem",
  "--d-hl1": "2.25rem",
  "--d-hl2": "1.625rem",
  "--d-price": "1.25rem",
  // K4: the price chart, desktop and phone.
  "--d-chart-h": "480px",
  "--d-chart-h-ph": "240px",
  "--d-cols": "2",
};

const RULES = cssRules();

function declaredTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES) {
    if (!r.selectors.includes(":root")) continue;
    for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--d-")) out[k] = v;
  }
  return out;
}

function readTokens(): string[] {
  const read = new Set<string>();
  for (const r of RULES) {
    for (const v of Object.values(r.decls)) for (const m of v.matchAll(/var\((--d-[a-z0-9-]+)/g)) read.add(m[1]);
  }
  return [...read].sort();
}

describe("density tokens (b, Balanced)", () => {
  it("declares b's values, and only those PR 5 and PR 6 read", () => {
    expect(declaredTokens()).toEqual(B);
  });

  it("X2: labels are 0.8125rem, chart axis labels included (PR 6, P5-5)", () => {
    expect(declaredTokens()["--d-label"]).toBe("0.8125rem");
  });

  it("every declared token is read, and every token read is declared", () => {
    expect(readTokens()).toEqual(Object.keys(declaredTokens()).sort());
  });

  it("no type size under 9px at text scale 1.0 (the 14px root)", () => {
    for (const [k, v] of Object.entries(B)) {
      if (v.endsWith("rem")) expect(parseFloat(v) * 14, k).toBeGreaterThanOrEqual(9);
    }
  });
});

describe("the selectors the tokens govern", () => {
  it("the page: padding, and content capped at --d-maxw, centred", () => {
    expect(declsFor(".main-content").padding).toContain("var(--d-page-py)");
    expect(declsFor(".main-content").padding).toContain("var(--d-page-px)");
    expect(declsFor(".main-content", PHONE).padding).toContain("var(--d-page-py-ph)");
    expect(declsFor(".main-content", PHONE).padding).toContain("var(--d-page-px-ph)");
    expect(declsFor(".main-content > *")).toMatchObject({
      "max-width": "var(--d-maxw)",
      "margin-left": "auto",
      "margin-right": "auto",
    });
  });

  it("panels: title size and body padding, desktop and phone", () => {
    expect(declsFor(".panel-title")["font-size"]).toBe("var(--d-title-size)");
    expect(declsFor(".panel-body").padding).toBe("var(--d-tile-pad)");
    expect(declsFor(".panel-body", PHONE).padding).toBe("var(--d-tile-pad-ph)");
  });

  it("tables: body and header sizes, cell padding; lane tables no longer tighter", () => {
    expect(declsFor(".data-table")["font-size"]).toBe("var(--d-table)");
    expect(declsFor(".data-table th")).toMatchObject({ "font-size": "var(--d-th)", padding: "var(--d-th-py) var(--d-td-px)" });
    expect(declsFor(".data-table td").padding).toBe("var(--d-td-py) var(--d-td-px)");
    expect(declsFor(".data-table td.td-num")["font-size"]).toBe("var(--d-table)");
    expect(declsFor(".data-table td.td-mono")["font-size"]).toBe("var(--d-table)");
    expect(declsFor(".panel.ops .data-table th").padding).toBeUndefined();
    expect(declsFor(".panel.ops .data-table td").padding).toBeUndefined();
  });

  it("subscription payment history: page gap and table sizes", () => {
    expect(declsFor(".sub-history-page")).toMatchObject({ gap: "var(--d-gap)" });
    expect(declsFor(".sub-history-page").padding).toBeUndefined();
    expect(declsFor(".sub-history-page")["max-width"]).toBeUndefined();
    expect(declsFor(".sub-history-table")["font-size"]).toBe("var(--d-table)");
    expect(declsFor(".sub-history-table thead th")).toMatchObject({ "font-size": "var(--d-th)", padding: "var(--d-th-py) var(--d-td-px)" });
    expect(declsFor(".sub-history-table tbody td").padding).toBe("var(--d-td-py) var(--d-td-px)");
  });
});
