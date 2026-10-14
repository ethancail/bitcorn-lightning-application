// Test helper: styles.css as a list of rules, each with the @media condition
// it sits in (null at top level). jsdom does not evaluate @media, so a test of
// a phone-only rule has to read the rule rather than compute the style; the
// browser captures are the evidence of what actually renders.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CssRule = { media: string | null; selectors: string[]; decls: Record<string, string>; line: number };

export function cssRules(file = join(__dirname, "styles.css")): CssRule[] {
  const raw = readFileSync(file, "utf8");
  // Blank comments out, keeping offsets (and so line numbers) intact.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const rules: CssRule[] = [];
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;

  function walk(from: number, to: number, media: string | null) {
    let i = from;
    while (i < to) {
      const open = src.indexOf("{", i);
      if (open === -1 || open >= to) return;
      const prelude = src.slice(i, open).trim();
      // matching close brace
      let depth = 1, j = open + 1;
      while (j < to && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) {
        walk(open + 1, j - 1, prelude.replace(/^@media\s*/, "").trim());
      } else if (prelude.startsWith("@supports")) {
        // Rules under @supports carry the whole prelude as their condition.
        walk(open + 1, j - 1, prelude.replace(/\s+/g, " "));
      } else if (!prelude.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const d of body.split(";")) {
          const k = d.indexOf(":");
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        rules.push({ media, selectors: prelude.split(",").map((s) => s.trim()), decls, line: lineAt(open) });
      }
      i = j;
    }
  }
  walk(0, src.length, null);
  return rules;
}

/** The declarations for `selector` (exact selector match) in a given @media,
 *  later rules overriding earlier ones, as the cascade would for equal
 *  specificity. */
export function declsFor(selector: string, media: string | null = null, rules = cssRules()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) if (r.media === media && r.selectors.includes(selector)) Object.assign(out, r.decls);
  return out;
}
