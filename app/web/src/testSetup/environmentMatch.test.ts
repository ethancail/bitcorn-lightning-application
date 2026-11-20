// Control for vitest.config.ts's environment rule (code-audit-2 "web test
// memory", ruled 2026-11-19): `*.test.tsx` → jsdom; `*.test.ts` → node, except
// the DOM_TS_TESTS list → jsdom. See the config's ENVIRONMENTS note.
//
// What this proves, and how:
//   1. THIS FILE RUNS UNDER NODE — `document` and `window` are absent at
//      runtime. It is a `.test.ts` outside the exception list, so it is its own
//      anti-vacuity case: if the node glob stops applying (deleted, misspelt,
//      shadowed), this file lands on jsdom and turns red, from inside the real
//      runner rather than from a model of it. In practice it goes red at import,
//      before this check runs: importing vitest.config under jsdom loads esbuild,
//      whose `TextEncoder().encode("") instanceof Uint8Array` invariant fails in
//      jsdom's realm (negative control NC2, 2026-11-20: "Tests no tests",
//      environment 1.56s). The runtime check is the backstop if that stops throwing.
//   2. Every test file in src resolves to the environment the rule says, using
//      vitest 2.1.9's precedence (resolveConfig groupFilesByEnv): a docblock in
//      the file text first, then the first matching environmentMatchGlobs entry,
//      then `environment`. The matcher below is NOT vitest's (that is bundled
//      into vitest's dist, and node's path.matchesGlob is experimental on Node
//      20 and warns): it handles only `**/`, `*` and literal text, and any other
//      glob syntax in the config FAILS the test rather than being guessed at.
//   3. No test file carries an environment docblock: vitest reads one from
//      anywhere in the file text and it outranks every glob. The marker is
//      assembled at runtime so this file's own text never contains it.
//   4. Every DOM_TS_TESTS entry exists and is a `.test.ts` (no stale entries).
//   5. VITEST_MAX_WORKERS parsing: unset → no change; a positive integer → both
//      maxWorkers and minWorkers; anything else throws.
//
// What it does NOT prove: that a node-classified file doesn't NEED the DOM. A
// file that touches `document` fails on its own with a ReferenceError; one that
// branches on `typeof window` is not caught by anything (C2, a static DOM scan,
// was considered and ruled out 2026-11-20).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config, { DOM_TS_TESTS, workersFromEnv } from "../../vitest.config";

const WEB = path.resolve(__dirname, "../..");
const testCfg = (config as { test: { environment: string; environmentMatchGlobs: [string, string][] } }).test;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(path.relative(WEB, p).split(path.sep).join("/"));
  }
  return out;
}

const SUPPORTED_GLOB = /^(?:[A-Za-z0-9_.\-/]|\*\*\/|\*)+$/;
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) { re += "(?:[^/]+/)*"; i += 3; }
    else if (glob[i] === "*") { re += "[^/]*"; i += 1; }
    else { re += glob[i].replace(/[.\-/]/g, "\\$&"); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

// vitest's docblock pattern, assembled so this file's text never matches it.
const DOCBLOCK = new RegExp("@(?:vitest|jest)" + "-environment\\s+([\\w-]+)\\b");

const files = testFiles(path.join(WEB, "src")).sort();
const expected = (f: string) => (f.endsWith(".tsx") || DOM_TS_TESTS.includes(f) ? "jsdom" : "node");
function resolved(f: string): string {
  const doc = fs.readFileSync(path.join(WEB, f), "utf8").match(DOCBLOCK)?.[1];
  if (doc) return `docblock:${doc}`;
  for (const [glob, env] of testCfg.environmentMatchGlobs) if (globToRegExp(glob).test(f)) return env;
  return testCfg.environment;
}

describe("this control runs under the node environment", () => {
  it("has no document or window at runtime", () => {
    expect(typeof document, "document exists — the node glob did not apply to this file").toBe("undefined");
    expect(typeof window, "window exists — the node glob did not apply to this file").toBe("undefined");
  });
});

describe("vitest.config.ts environment rule", () => {
  it("uses only glob syntax this control can model", () => {
    for (const [glob] of testCfg.environmentMatchGlobs) expect(glob, `unsupported glob syntax in ${glob}`).toMatch(SUPPORTED_GLOB);
  });

  it("finds the suite (anti-vacuity: both kinds present)", () => {
    expect(files.filter((f) => f.endsWith(".test.tsx")).length).toBeGreaterThan(50);
    expect(files.filter((f) => expected(f) === "node").length).toBeGreaterThan(50);
    expect(files).toContain("src/testSetup/environmentMatch.test.ts");
  });

  it("sends .test.tsx and the DOM_TS_TESTS list to jsdom, every other .test.ts to node", () => {
    const wrong = files.map((f) => ({ f, want: expected(f), got: resolved(f) })).filter((r) => r.want !== r.got);
    expect(wrong, wrong.map((r) => `${r.f}: want ${r.want}, resolves to ${r.got}`).join("\n")).toEqual([]);
  });

  it("no test file carries an environment docblock (it would outrank every glob)", () => {
    const withDoc = files.filter((f) => DOCBLOCK.test(fs.readFileSync(path.join(WEB, f), "utf8")));
    expect(withDoc).toEqual([]);
  });

  it("every DOM_TS_TESTS entry exists and is a .test.ts", () => {
    for (const f of DOM_TS_TESTS) {
      expect(f).toMatch(/\.test\.ts$/);
      expect(fs.existsSync(path.join(WEB, f)), `${f} is listed but does not exist`).toBe(true);
    }
  });
});

describe("VITEST_MAX_WORKERS", () => {
  it("unset changes nothing", () => {
    expect(workersFromEnv(undefined)).toEqual({});
  });
  it("a positive integer sets both maxWorkers and minWorkers", () => {
    expect(workersFromEnv("2")).toEqual({ maxWorkers: 2, minWorkers: 2 });
    expect(workersFromEnv("12")).toEqual({ maxWorkers: 12, minWorkers: 12 });
  });
  it.each(["", "0", "-1", "2.5", "abc", "50%", " 2", "02"])("throws on %j", (raw) => {
    expect(() => workersFromEnv(raw)).toThrow(/VITEST_MAX_WORKERS must be a positive integer/);
  });
});
