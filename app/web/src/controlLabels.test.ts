// Control labels (PR 2): every form control in app/web/src has an accessible
// name — aria-label, aria-labelledby, a <label htmlFor> pointing at its id, or
// an enclosing <label>.
//
// A SOURCE SCAN, deliberately: most controls sit behind API state that a render
// test would have to stub page by page. The scan reads each .tsx file's JSX
// text, so a new unnamed <input>, <select> or <textarea> anywhere fails here,
// named by file:line.
//
// OWNERS' LIST: two controls sit in files PR 2 may not edit. They are listed
// for their owners, unedited (PR 2 ruling 6), and pinned by exact count — so
// the day either is fixed, this list must shrink with it.
//   - components/valuation/DayForm.tsx — the metric input. V8 lets PR 2 edit
//     the valuation files for proven native-chrome residue only; a label is not
//     residue.
//   - pages/DaybreakEditor.tsx — the edition textarea. Daybreak's file.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = __dirname;

const OWNERS_LIST: Record<string, number> = {
  "components/valuation/DayForm.tsx": 1,
  "pages/DaybreakEditor.tsx": 1,
};

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
  });
}

/** The attribute text of a JSX opening tag starting at `from`: up to the first
 *  `>` at brace depth 0 that is not the `>` of an arrow `=>`. */
function openingTag(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return src.slice(from, i + 1);
  }
  throw new Error(`unterminated tag at ${from}`);
}

type Site = { file: string; line: number; tag: string };

function unnamedControls(): Site[] {
  const out: Site[] = [];
  for (const path of tsxFiles(SRC)) {
    const src = readFileSync(path, "utf8");
    const htmlFor = new Set([...src.matchAll(/htmlFor=["{]`?"?([\w-]+)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
      const tag = openingTag(src, m.index!);
      const type = /\btype=["{]"?(\w+)/.exec(tag)?.[1];
      if (type === "hidden" || type === "submit" || type === "button") continue;
      if (/\baria-label(ledby)?=/.test(tag)) continue;
      const id = /\bid=["{]"?([\w-]+)/.exec(tag)?.[1];
      if (id && htmlFor.has(id)) continue;
      const before = src.slice(0, m.index);
      if (before.lastIndexOf("<label") > before.lastIndexOf("</label>")) continue;
      out.push({ file: relative(SRC, path), line: before.split("\n").length, tag: m[1] });
    }
  }
  return out;
}

describe("every form control has an accessible name", () => {
  const sites = unnamedControls();

  it("the scan reads real controls (it is not vacuous)", () => {
    const all = tsxFiles(SRC).reduce((n, p) => n + (readFileSync(p, "utf8").match(/<(input|select|textarea)\b/g)?.length ?? 0), 0);
    expect(all).toBeGreaterThan(40);
  });

  it("no unnamed control outside the owners' list", () => {
    const outside = sites.filter((s) => !(s.file in OWNERS_LIST)).map((s) => `${s.file}:${s.line} <${s.tag}>`);
    expect(outside).toEqual([]);
  });

  it("the owners' list is exact — it shrinks when an owner fixes theirs", () => {
    const counts: Record<string, number> = {};
    for (const s of sites) if (s.file in OWNERS_LIST) counts[s.file] = (counts[s.file] ?? 0) + 1;
    expect(counts).toEqual(OWNERS_LIST);
  });

  it("no aria-label is empty", () => {
    const empty: string[] = [];
    for (const path of tsxFiles(SRC)) {
      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(/aria-label=(""|\{""\}|\{''\})/g)) {
        empty.push(`${relative(SRC, path)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(empty).toEqual([]);
  });
});
