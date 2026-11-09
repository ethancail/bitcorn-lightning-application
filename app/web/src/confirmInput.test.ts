// The type-to-confirm input's height (fix/confirm-input-height; ruling:
// option B, all three copies). The input had no class, so the reset's
// `padding: 0` and the browser's default font set its height: about 15px, a
// thin strip under its label (2026-11-06 capture), from 8d13d40 on. It now
// carries .form-input, the app's text field, and .action-confirm-input, which
// adds only a 44px minimum height. Three copies exist: ActionConfirmModal
// (six mount sites), the admin swap dialog and the treasury close-channel
// dialog. Read from source and styles.css: jsdom does no layout, so the
// browser captures are the evidence of the rendered height.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React, { useEffect } from "react";
import ActionConfirmModal, { useActionConfirm } from "./components/actionConfirm/ActionConfirmModal";
import { summarizeOpenMemberChannel, type ActionSummary } from "./components/actionConfirm/confirmAction";
import { cssRules, declsFor, type CssRule } from "./styleRules.testutil";

const CLASSES = ["form-input", "action-confirm-input"];
const MIN_PX = 44;

/** The opening tag of the <input> whose id is `id`, or null if there is none. */
export function inputTag(src: string, id: string): string | null {
  const at = src.indexOf(`id="${id}"`);
  if (at === -1) return null;
  const start = src.lastIndexOf("<input", at);
  if (start === -1) return null;
  let depth = 0, end = start;
  for (; end < src.length; end++) {
    const c = src[end];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  return src.slice(start, end + 1);
}

/** The classes of a tag's literal className, [] when it has none. */
export function classesOf(tag: string): string[] {
  const m = /\bclassName="([^"]*)"/.exec(tag);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

const px = (v: string | undefined): number | null => {
  const m = /^([\d.]+)px$/.exec((v ?? "").trim());
  return m ? Number(m[1]) : null;
};

/** What is wrong with the size these classes get from top-level rules, as
 *  messages: no vertical padding, or a minimum height under 44px. */
export function sizingProblems(classes: string[], rules: CssRule[]): string[] {
  const sels = classes.map((c) => `.${c}`);
  const decls: Record<string, string> = {};
  for (const r of rules) {
    if (r.media === null && r.container === null && r.selectors.some((s) => sels.includes(s))) Object.assign(decls, r.decls);
  }
  const out: string[] = [];
  const top = (decls.padding ?? "").trim().split(/\s+/)[0];
  if (!top || /^0(px)?$/.test(top)) out.push(`no vertical padding (padding: ${decls.padding ?? "unset"})`);
  const min = px(decls["min-height"]);
  if (min === null || min < MIN_PX) out.push(`min-height ${decls["min-height"] ?? "unset"} — under ${MIN_PX}px`);
  return out;
}

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

// [where, file, id]
const COPIES: Array<[string, string, string]> = [
  ["ActionConfirmModal", "components/actionConfirm/ActionConfirmModal.tsx", "action-confirm-challenge"],
  ["admin swap dialog", "pages/SwapOperations.tsx", "swapops-typed-amount"],
  ["treasury close-channel dialog", "App.tsx", "close-channel-challenge"],
];

// ── (a) the rendered modal ──────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Harness({ summary }: { summary: ActionSummary }) {
  const c = useActionConfirm();
  useEffect(() => { c.open(summary); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return React.createElement(ActionConfirmModal, { controller: c, onConfirm: async () => undefined });
}

describe("the type-to-confirm input is a sized text field", () => {
  it("(a) the rendered ActionConfirmModal's input carries .form-input and .action-confirm-input", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const summary = summarizeOpenMemberChannel({ capacitySats: 1_000_000, partnerSocket: "203.0.113.5:9735" });
    await act(async () => { root!.render(React.createElement(Harness, { summary })); });
    // The modal portals to document.body (ruling ll).
    const input = document.body.querySelector("#action-confirm-challenge");
    expect(input, "the challenge input renders").not.toBeNull();
    for (const c of CLASSES) expect(input!.classList.contains(c), c).toBe(true);
  });

  for (const [where, file, id] of COPIES) {
    it(`(b) ${where}: <input id="${id}"> carries both classes in source`, () => {
      const tag = inputTag(read(file), id);
      expect(tag, `${file} has <input id="${id}">`).not.toBeNull();
      expect(classesOf(tag!)).toEqual(expect.arrayContaining(CLASSES));
    });
  }

  it("(c) the classes give it vertical padding and at least 44px of height, and .action-confirm-input sets nothing else", () => {
    expect(sizingProblems(CLASSES, cssRules())).toEqual([]);
    // Only the height: no font size (inputZoom.test.ts's floor), no colour, no border.
    expect(declsFor(".action-confirm-input")).toEqual({ "min-height": "44px" });
  });

  it("(d) negative controls: an unclassed input and a missing rule are caught", () => {
    // the scanner finds the planted tag, across lines and past a `>` inside braces
    const planted = [
      `<input`,
      `  id="planted-challenge"`,
      `  onKeyDown={(e) => { if (a > b) go(); }}`,
      `  style={{ width: "100%" }}`,
      `/>`,
      `<input id="planted-classed" className="form-input action-confirm-input" />`,
    ].join("\n");
    const bare = inputTag(planted, "planted-challenge");
    expect(bare).toContain(`style={{ width: "100%" }}`);
    expect(classesOf(bare!)).toEqual([]);
    expect(classesOf(inputTag(planted, "planted-classed")!)).toEqual(CLASSES);
    expect(inputTag(planted, "no-such-id")).toBeNull();

    // with no rules at all, both problems are reported
    expect(sizingProblems(CLASSES, [])).toHaveLength(2);
    // today's stylesheet without .action-confirm-input: .form-input's padding stays, the height goes
    const rules = cssRules();
    const noMin = sizingProblems(CLASSES, rules.filter((r) => !r.selectors.includes(".action-confirm-input")));
    expect(noMin).toHaveLength(1);
    expect(noMin[0]).toMatch(/^min-height unset/);
    // a rule under 44px, or inside an @media, does not count
    const rule = (selectors: string[], decls: Record<string, string>, media: string | null = null): CssRule => ({ media, container: null, selectors, decls, line: 0 });
    expect(sizingProblems(CLASSES, [rule([".form-input"], { padding: "10px 14px" }), rule([".action-confirm-input"], { "min-height": "40px" })])).toEqual(["min-height 40px — under 44px"]);
    expect(sizingProblems(CLASSES, [rule([".form-input"], { padding: "10px 14px" }), rule([".action-confirm-input"], { "min-height": "44px" }, "(pointer: coarse)")])).toHaveLength(1);
    // and an unpadded field is caught
    expect(sizingProblems(CLASSES, [rule([".form-input"], { padding: "0" }), rule([".action-confirm-input"], { "min-height": "44px" })])).toEqual(["no vertical padding (padding: 0)"]);
  });
});
