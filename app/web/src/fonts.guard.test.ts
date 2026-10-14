// Font guards (UI redesign PR 4: Z4, Z5, Z6, SH5).
//
// 1. The app loads nothing from Google: index.html names neither Google font
//    host, and no stylesheet @imports a remote URL. (SH5: for any build with
//    PR 4, Google Fonts leaves the known origins.)
// 2. No face is named outside font.css: no @font-face elsewhere, and no quoted
//    family name in any source file's font-family / fontFamily — everything
//    else reads the tokens (--font, --font-id, or --sans/--mono derived from
//    --font). Comments are blanked first, so prose may name a face.
// 3. The shipped woff2 files are exactly the five ported from the font round
//    (ui-r1-font-inter f8a3d0e), each sha256 pinned to the round's recorded
//    value (REPORT §8, fonts/fontinfo-shipped.jsonl), with each family's OFL
//    licence beside it, and every @font-face src in font.css resolving to one.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = __dirname;
const WEB = resolve(SRC, "..");
const read = (p: string) => readFileSync(p, "utf8");

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}
const sources = () => walk(SRC, (n) => /\.(css|ts|tsx)$/.test(n) && !/\.test\./.test(n) && !/\.testutil\./.test(n));

// ── 1. nothing from Google ──────────────────────────────────────────────────

const GOOGLE = /fonts\.(googleapis|gstatic)\.com/;
const REMOTE_IMPORT = /@import\s+(url\()?\s*["']?(https?:)?\/\//;

describe("SH5/Z4: the app loads nothing from Google", () => {
  it("anti-vacuity: the checks see develop's Google link and a remote @import", () => {
    const old = '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />';
    expect(GOOGLE.test(old)).toBe(true);
    expect(GOOGLE.test('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />')).toBe(true);
    expect(REMOTE_IMPORT.test('@import url("https://fonts.googleapis.com/css2?family=Inter");')).toBe(true);
    expect(REMOTE_IMPORT.test('@import "./local.css";')).toBe(false);
  });

  it("index.html names neither Google font host", () => {
    expect(read(join(WEB, "index.html"))).not.toMatch(GOOGLE);
  });

  it("no stylesheet @imports a remote URL, and none names a Google host", () => {
    const offenders = walk(SRC, (n) => n.endsWith(".css"))
      .filter((f) => REMOTE_IMPORT.test(read(f)) || GOOGLE.test(read(f)))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});

// ── 2. no face named outside font.css ───────────────────────────────────────

const blankComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** "file:line: text" for each face named in `src` (comments blanked). */
export function facesNamed(src: string): string[] {
  const s = blankComments(src);
  const hits: string[] = [];
  const lineOf = (i: number) => s.slice(0, i).split("\n").length;
  for (const m of s.matchAll(/@font-face/g)) hits.push(`${lineOf(m.index!)}: @font-face`);
  // a CSS font-family declaration whose value quotes a name
  for (const m of s.matchAll(/font-family\s*:\s*([^;}\n]*)/g)) {
    if (/["']/.test(m[1])) hits.push(`${lineOf(m.index!)}: font-family: ${m[1].trim()}`);
  }
  // a JS/TS string holding a quoted family name: "'IBM Plex Mono', monospace"
  for (const m of s.matchAll(/(["`])\s*'[A-Z][^'"`]*'\s*(,[^"`]*)?\1/g)) hits.push(`${lineOf(m.index!)}: ${m[0]}`);
  // a known face name in quotes anywhere in code
  for (const m of s.matchAll(/["'](IBM Plex (Mono|Sans)|Inter|JetBrains Mono|Source Code Pro|Source Sans 3)["']/g)) {
    hits.push(`${lineOf(m.index!)}: ${m[0]}`);
  }
  return [...new Set(hits)];
}

describe("Z4: no face is named outside font.css", () => {
  it("anti-vacuity: the scanner flags develop's three forms, and not a token or a generic", () => {
    expect(facesNamed('.x {\n  font-family: "IBM Plex Mono", monospace;\n}')).toHaveLength(2);
    expect(facesNamed(`const getMono = () => v || "'IBM Plex Mono', monospace";`).length).toBeGreaterThan(0);
    expect(facesNamed("@font-face { font-family: 'Inter'; }").length).toBeGreaterThan(0);
    expect(facesNamed('.x { font-family: var(--font-id); }\nconst f = "var(--mono)" || "sans-serif";')).toEqual([]);
    expect(facesNamed("/* truncated pubkey (Plex Mono, muted) */\n// 'IBM Plex Mono' in prose")).toEqual([]);
  });

  it("font.css does name both faces (the scan of it would not be empty)", () => {
    const hits = facesNamed(read(join(SRC, "font.css")));
    expect(hits.filter((h) => h.endsWith("@font-face"))).toHaveLength(5);
  });

  it("no other source file names a face", () => {
    const offenders = sources()
      .filter((f) => relative(SRC, f) !== "font.css")
      .flatMap((f) => facesNamed(read(f)).map((h) => `${relative(SRC, f)}:${h}`));
    expect(offenders).toEqual([]);
  });

  it("font.css sets the two tokens, carries no VARIANT header and imports nothing", () => {
    const raw = read(join(SRC, "font.css"));
    const css = blankComments(raw);
    expect(css).toMatch(/--font:\s*'Inter', sans-serif;/);
    expect(css).toMatch(/--font-id:\s*'IBM Plex Mono', monospace;/);
    expect(raw).not.toMatch(/VARIANT/);
    expect(css).not.toMatch(/@import/);
  });
});

// ── 3. the shipped font files ───────────────────────────────────────────────

const PINNED: Record<string, string> = {
  "fonts/inter/InterVariable.woff2": "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3",
  "fonts/inter/InterVariable-Italic.woff2": "e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a",
  "fonts/ibm-plex-mono/IBMPlexMono-Regular.woff2": "ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350",
  "fonts/ibm-plex-mono/IBMPlexMono-Medium.woff2": "33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25",
  "fonts/ibm-plex-mono/IBMPlexMono-SemiBold.woff2": "6a825b4824c01cbb401e829e5a066a1818411bcb3538b5a5792c5ca9b82343c3",
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("Z5/Z6: the shipped woff2 files are the round's, byte for byte", () => {
  it("anti-vacuity: one changed byte changes the hash", () => {
    const b = readFileSync(join(SRC, "fonts/inter/InterVariable.woff2"));
    const flipped = Buffer.from(b);
    flipped[flipped.length - 1] ^= 0xff;
    expect(sha256(flipped)).not.toBe(PINNED["fonts/inter/InterVariable.woff2"]);
  });

  it("exactly the five pinned files ship under src/fonts/", () => {
    const shipped = walk(join(SRC, "fonts"), (n) => /\.(woff2?|ttf|otf)$/.test(n)).map((f) => relative(SRC, f)).sort();
    expect(shipped).toEqual(Object.keys(PINNED).sort());
  });

  for (const [file, want] of Object.entries(PINNED)) {
    it(`${file} sha256 = ${want.slice(0, 8)}…`, () => {
      expect(sha256(readFileSync(join(SRC, file)))).toBe(want);
    });
  }

  it("each family ships its SIL OFL 1.1 licence", () => {
    for (const dir of ["fonts/inter", "fonts/ibm-plex-mono"]) {
      expect(read(join(SRC, dir, "LICENSE.txt"))).toContain("SIL Open Font License, Version 1.1");
    }
  });

  it("every @font-face src in font.css is a pinned file, and every pinned file is used", () => {
    const urls = [...read(join(SRC, "font.css")).matchAll(/url\('\.\/([^']+)'\)/g)].map((m) => m[1]);
    for (const u of urls) expect(existsSync(join(SRC, u)), u).toBe(true);
    expect([...urls].sort()).toEqual(Object.keys(PINNED).sort());
  });
});
