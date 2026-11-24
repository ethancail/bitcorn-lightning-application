// Control for vitest.config.ts's worker and no-tests-ran rules (code-audit-2
// "vitest worker conflict and no-tests-ran", ruled 2026-11-24). See the
// config's VITEST_MAX_WORKERS and NO TESTS RAN notes.
//
// What this proves, and how: each case spawns a REAL `vitest run` against
// TARGET (a small, pure, node-environment file) and reads its exit status AND
// its printed counts. Exit status alone is not trusted on either side.
//   C1. An explicit --maxWorkers=2 runs tests, with VITEST_MAX_WORKERS=3 set (the
//       heavy lock's shared-machine cap) and without it. Before the fix both
//       threw in tinypool ("options.minThreads and options.maxThreads must not
//       conflict"): the env set min = 3, and unset, vitest 2.1.9 defaults the
//       minimum to CPUs − 1 (7 on ubuntu-pc). Neither ran a test.
//   C2. A run that executes zero tests exits 1 and prints NO TESTS RAN: here,
//       -t with no match (every collected test ends "skip", the same state an
//       all-.skip file gives). Before the fix it exited 0, "2 skipped" (on the
//       sample then in use, src/shellGrid.test.ts).
//       And a run that matches zero files exits 1 (passWithNoTests: false).
//
// The spawned run gets this runner's environment minus its own markers
// (VITEST*, TEST, NODE_ENV), so it starts as a fresh top-level run would.
// Could-not-run (spawn error, signal, timeout) fails the case by name, never
// as the expected status.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config, { noTestsRanGuard, testsExecuted, type TaskLike } from "../../vitest.config";

const WEB = path.resolve(__dirname, "../..");
const VITEST = path.join(WEB, "node_modules/vitest/vitest.mjs");
// This guard's own fixture (node environment, no I/O). Never point it at
// another file's tests: their count changes under unrelated work.
const TARGET = "src/testSetup/vitestRunGuards.fixture.test.ts";
const TARGET_TESTS = 3;
const SPAWN_TIMEOUT = 90_000;

function runVitest(args: string[], workersEnv: string | undefined): { status: number; out: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("VITEST") || k === "TEST" || k === "NODE_ENV" || k === "FORCE_COLOR") continue;
    env[k] = v;
  }
  env.NO_COLOR = "1";
  if (workersEnv !== undefined) env.VITEST_MAX_WORKERS = workersEnv;
  const r = spawnSync(process.execPath, [VITEST, "run", ...args], {
    cwd: WEB, env, encoding: "utf8", timeout: SPAWN_TIMEOUT,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error || r.status === null) {
    throw new Error(`vitest COULD NOT RUN (${r.error?.message ?? `signal ${r.signal}`}):\n${out.slice(-1500)}`);
  }
  return { status: r.status, out };
}

describe("C1: an explicit --maxWorkers runs tests", () => {
  it.each([
    ["with VITEST_MAX_WORKERS=3", "3"],
    ["without VITEST_MAX_WORKERS", undefined],
  ])("--maxWorkers=2 %s", (_label, workersEnv) => {
    const { status, out } = runVitest([TARGET, "--maxWorkers=2"], workersEnv);
    expect(out).not.toMatch(/must not conflict/);
    expect(out).toMatch(new RegExp(`Tests\\s+${TARGET_TESTS} passed \\(${TARGET_TESTS}\\)`));
    expect(out).not.toMatch(/NO TESTS RAN/);
    expect(status, out.slice(-1500)).toBe(0);
  }, SPAWN_TIMEOUT);
});

describe("C2: a run that executes no tests fails", () => {
  it("-t matching no test exits 1 and prints NO TESTS RAN", () => {
    const { status, out } = runVitest([TARGET, "-t", "zzz no test is named this"], undefined);
    expect(out).toMatch(new RegExp(`Tests\\s+${TARGET_TESTS} skipped \\(${TARGET_TESTS}\\)`));
    expect(status, out.slice(-1500)).toBe(1);
    expect(out).toMatch(/NO TESTS RAN/);
  }, SPAWN_TIMEOUT);

  it("a filter matching no file exits 1 (passWithNoTests: false)", () => {
    const { status, out } = runVitest(["src/zzz-no-such-test-file"], undefined);
    expect(out).toMatch(/No test files found, exiting with code 1/);
    expect(status, out.slice(-1500)).toBe(1);
  }, SPAWN_TIMEOUT);
});

// The guard's rule, on task trees shaped like vitest 2.1.9's (File → Suite →
// Test). An all-.skip file and a -t with no match both end every test "skip".
describe("testsExecuted: what counts as a test that ran", () => {
  const test = (state?: string): TaskLike => ({ type: "test", ...(state ? { result: { state } } : {}) });
  const file = (...tasks: TaskLike[]): TaskLike => ({ type: "suite", tasks: [{ type: "suite", tasks }] });

  it("pass and fail count, at any depth", () => {
    expect(testsExecuted([file(test("pass"), test("fail"), test("skip"))])).toBe(2);
  });
  it("skip, todo and never-run (no result) do not", () => {
    expect(testsExecuted([file(test("skip"), test("todo"), test())])).toBe(0);
    expect(testsExecuted([])).toBe(0);
  });
  it("a suite's own failure (a collection error) is not a test that ran", () => {
    expect(testsExecuted([{ type: "suite", result: { state: "fail" }, tasks: [] }])).toBe(0);
  });
  it("the config keeps the guard, with passWithNoTests explicitly false", () => {
    const t = (config as { test: { reporters?: unknown[]; passWithNoTests?: boolean } }).test;
    expect(t.reporters).toContain(noTestsRanGuard);
    expect(t.passWithNoTests).toBe(false);
  });
});
