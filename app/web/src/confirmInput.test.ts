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

// ── The focus ring inside ActionConfirmModal's scroll (ruling 2026-11-09, item 1)
// .form-input's focus ring is an outline outside the field (width + offset).
// The field is the last thing in .action-confirm-scroll, whose overflow clips
// anything past its padding box, so the ring showed on the top edge only (2026-11-09
// gate). The scroll gets padding of at least the ring's reach on every side, and
// the same negative margin, so nothing moves while the content fits. (While
// the middle scrolls, its visible edge moves out by the padding: accepted.)

/** The four sides of a padding/margin shorthand, in px; null if any side is not px. */
export function sides(v: string | undefined): [number, number, number, number] | null {
  const t = (v ?? "").trim().split(/\s+/).filter(Boolean);
  if (t.length === 0 || t.length > 4) return null;
  const n = t.map((x) => (/^-?0$/.test(x) ? 0 : /^-?[\d.]+px$/.test(x) ? parseFloat(x) : NaN));
  if (n.some(Number.isNaN)) return null;
  const [a, b = a, c = a, d = b] = n;
  return [a, b, c, d];
}

/** How far the focus ring reaches outside the field: outline width + offset. */
export function ringReach(focus: Record<string, string>): number | null {
  const w = /^([\d.]+)px\b/.exec((focus.outline ?? "").trim())?.[1];
  const off = /^(-?[\d.]+)px$/.exec((focus["outline-offset"] ?? "").trim())?.[1];
  return w === undefined || off === undefined ? null : parseFloat(w) + parseFloat(off);
}

/** Problems with the scroll's room for the ring, as messages. */
export function ringRoomProblems(scroll: Record<string, string>, reach: number): string[] {
  const out: string[] = [];
  const pad = sides(scroll.padding);
  const mar = sides(scroll.margin);
  const NAMES = ["top", "right", "bottom", "left"];
  if (!pad) return [`padding ${scroll.padding ?? "unset"} — no room for the ${reach}px ring`];
  pad.forEach((p, k) => { if (p < reach) out.push(`padding-${NAMES[k]} ${p}px < the ring's ${reach}px`); });
  if (!mar) out.push(`margin ${scroll.margin ?? "unset"} — the padding would move the layout`);
  else mar.forEach((m, k) => { if (m !== -pad[k]) out.push(`margin-${NAMES[k]} ${m}px is not -${pad[k]}px — the layout moves`); });
  return out;
}

describe("the focus ring shows all round inside ActionConfirmModal's scroll", () => {
  it("not vacuous: the field is a .form-input inside .action-confirm-scroll, and the ring reaches 4px out", () => {
    const src = read(COPIES[0][1]);
    expect(src.indexOf('className="action-confirm-scroll"')).toBeGreaterThan(-1);
    expect(src.indexOf('className="action-confirm-scroll"')).toBeLessThan(src.indexOf('id="action-confirm-challenge"'));
    expect(ringReach(declsFor(".form-input:focus-visible"))).toBe(4);
  });

  it(".action-confirm-scroll's padding is at least the ring's reach on every side, offset by an equal negative margin", () => {
    const reach = ringReach(declsFor(".form-input:focus-visible"))!;
    expect(ringRoomProblems(declsFor(".action-confirm-scroll"), reach)).toEqual([]);
  });

  it("negative controls: no padding, too little, one short side and no margin are caught", () => {
    expect(sides("4px")).toEqual([4, 4, 4, 4]);
    expect(sides("4px 2px")).toEqual([4, 2, 4, 2]);
    expect(sides("-4px")).toEqual([-4, -4, -4, -4]);
    expect(sides("1rem")).toBeNull();
    expect(ringReach({ outline: "2px solid var(--focus-ring)", "outline-offset": "2px" })).toBe(4);
    expect(ringReach({})).toBeNull();
    expect(ringRoomProblems({}, 4)).toHaveLength(1);
    expect(ringRoomProblems({ padding: "2px", margin: "-2px" }, 4)).toHaveLength(4);
    expect(ringRoomProblems({ padding: "4px 4px 0", margin: "-4px -4px 0" }, 4)).toEqual(["padding-bottom 0px < the ring's 4px"]);
    expect(ringRoomProblems({ padding: "4px" }, 4)).toEqual(["margin unset — the padding would move the layout"]);
    expect(ringRoomProblems({ padding: "4px", margin: "-4px" }, 4)).toEqual([]);
  });
});

// ── The inline dialogs' action rows (ruling 2026-11-09, item 2) ─────────────
// The swap and close-channel dialogs put `.dialog-actions` straight after the
// challenge's wrapper, and .dialog-actions has no top margin, so the buttons
// sat flush under the 44px field (2026-11-09 gate). They get ActionConfirmModal's
// 16px gap from a rule that reaches only an action row following a challenge
// wrapper; .dialog-actions itself, used by other dialogs, is unchanged.

const MODAL_GAP = "16px";

/** The source after the challenge input's wrapper closes: what follows the field. */
export function afterWrapper(src: string, id: string): string | null {
  const tag = inputTag(src, id);
  if (!tag) return null;
  const close = src.indexOf("</div>", src.indexOf(tag) + tag.length);
  return close === -1 ? null : src.slice(close + "</div>".length).trimStart();
}

/** margin-top from the top-level rules that match `el`, later rules winning
 *  (`margin` shorthand included). The stylesheet's rules for these elements are
 *  in specificity order, so source order stands in for the cascade. */
export function marginTopFor(el: Element, rules: CssRule[]): string | undefined {
  let out: string | undefined;
  for (const r of rules) {
    if (r.media !== null || r.container !== null) continue;
    if (!r.selectors.some((s) => { try { return el.matches(s); } catch { return false; } })) continue;
    if (r.decls.margin !== undefined) out = r.decls.margin.split(/\s+/)[0];
    if (r.decls["margin-top"] !== undefined) out = r.decls["margin-top"];
  }
  return out;
}

/** An inline dialog's challenge block and action row, as both dialogs build
 *  them, beside a plain dialog's action row. */
function dialogs(): { row: Element; plain: Element } {
  document.body.innerHTML = `
    <div class="dialog-card">
      <div class="dialog-body">summary</div>
      <div><label>Type to confirm</label><input class="form-input action-confirm-input"></div>
      <div class="dialog-actions" data-t="row"></div>
    </div>
    <div class="dialog-card">
      <div class="dialog-body">another dialog</div>
      <div class="dialog-actions" data-t="plain"></div>
    </div>`;
  return { row: document.querySelector('[data-t="row"]')!, plain: document.querySelector('[data-t="plain"]')! };
}

const zero = (v: string | undefined) => /^0(px)?$/.test(v ?? "0");

describe("the inline dialogs' action rows sit below the field with the modal's gap", () => {
  it(`not vacuous: ActionConfirmModal's action row is ${MODAL_GAP} below its content`, () => {
    expect(read(COPIES[0][1])).toContain(`<div style={{ display: "flex", gap: 10, marginTop: ${parseInt(MODAL_GAP)} }}>`);
  });

  for (const [where, file, id] of COPIES.slice(1)) {
    it(`${where}: the action row directly follows the challenge's wrapper`, () => {
      expect(afterWrapper(read(file), id)).toMatch(/^<div className="dialog-actions">/);
    });
  }

  it(`a rule gives that row margin-top ${MODAL_GAP}; a plain .dialog-actions gets none, and .dialog-actions is unchanged`, () => {
    const rules = cssRules();
    const { row, plain } = dialogs();
    expect(marginTopFor(row, rules)).toBe(MODAL_GAP);
    expect(zero(marginTopFor(plain, rules)), `plain row: ${marginTopFor(plain, rules)}`).toBe(true);
    expect(declsFor(".dialog-actions")).toEqual({ display: "flex", gap: "10px", "justify-content": "flex-end" });
  });

  it("negative controls: no rule, a too-broad rule and a different next element are caught", () => {
    const rule = (selectors: string[], decls: Record<string, string>): CssRule => ({ media: null, container: null, selectors, decls, line: 0 });
    const reset = rule(["*", "*::before", "*::after"], { margin: "0" });
    const { row, plain } = dialogs();
    // only the reset: the row is flush
    expect(zero(marginTopFor(row, [reset]))).toBe(true);
    // a rule on .dialog-actions itself reaches the plain dialog too
    const broad = [reset, rule([".dialog-actions"], { "margin-top": MODAL_GAP })];
    expect(marginTopFor(plain, broad)).toBe(MODAL_GAP);
    // the narrow rule reaches the row and not the plain one
    const narrow = [reset, rule(["div:has(> .action-confirm-input) + .dialog-actions"], { "margin-top": MODAL_GAP })];
    expect(marginTopFor(row, narrow)).toBe(MODAL_GAP);
    expect(zero(marginTopFor(plain, narrow))).toBe(true);
    // the source scan sees what follows the wrapper
    expect(afterWrapper(`<div>\n  <input\n    id="p"\n  />\n</div>\n<div className="other">`, "p")).toMatch(/^<div className="other">/);
    expect(afterWrapper("<div></div>", "absent")).toBeNull();
  });
});
