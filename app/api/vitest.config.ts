import { defineConfig } from "vitest/config";

// Minimal vitest config for the API container.
// Tests live alongside source as `*.test.ts` (per the cloudflare-worker
// convention; the API container had no test infrastructure before).
//
// WORKERS (code-audit-2 "vitest worker conflict and no-tests-ran", ruled
// 2026-11-24; the same rule as app/web/vitest.config.ts, one copy per config):
//   - minWorkers is ALWAYS 1. vitest 2.1.9 otherwise defaults the minimum to
//     CPUs − 1 (7 on ubuntu-pc) whatever the maximum is, and tinypool throws
//     ("options.minThreads and options.maxThreads must not conflict") before
//     any test runs when max < min: a bare `--maxWorkers=2` did exactly that.
//     The minimum is only the idle-pool floor; the pool still grows to
//     maxWorkers on demand.
//   - VITEST_MAX_WORKERS, a positive integer, sets maxWorkers only (the heavy
//     lock exports it for a job sharing the machine; before this ruling this
//     config ignored it). Unset means vitest's default maximum. Anything else
//     throws here rather than being ignored.
//   - An explicit CLI --maxWorkers wins over both, without error.
//   src/vitestRunGuards.test.ts (C1) is the control.
//
// NO TESTS RAN (same ruling): a run in which zero tests executed (ended pass
// or fail) exits 1 and prints NO TESTS RAN: a -t that matches nothing, an
// all-.skip run. vitest 2.1.9 exits 0 for those ("Tests 4 skipped (4)");
// passWithNoTests only covers the no-files path, so it is set false here AND
// noTestsRanGuard, a reporter, covers the rest. After onFinished, vitest only
// ever sets process.exitCode to 1, so nothing overwrites the guard's 1.
// ⚠ A CLI --reporter REPLACES config reporters (vitest 2.1.9 resolveConfig),
// so a run given --reporter=… (CI's json step) has no guard: reporters are the
// only hook in 2.1.9 that sees results. src/vitestRunGuards.test.ts (C2) is
// the control.

export function workersFromEnv(raw: string | undefined): { maxWorkers?: number } {
  if (raw === undefined) return {};
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`VITEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return { maxWorkers: Number(raw) };
}

/** The slice of vitest's task tree the guard reads (File, Suite and Test all fit it). */
export type TaskLike = { type: string; result?: { state?: string }; tasks?: readonly TaskLike[] };

/** How many tests executed: ended "pass" or "fail". Skipped, todo and never-run tests do not count. */
export function testsExecuted(tasks: readonly TaskLike[]): number {
  let n = 0;
  for (const t of tasks) {
    if (t.tasks) n += testsExecuted(t.tasks);
    else if ((t.type === "test" || t.type === "custom") && (t.result?.state === "pass" || t.result?.state === "fail")) n++;
  }
  return n;
}

export const noTestsRanGuard = {
  onFinished(files: readonly TaskLike[] = []): void {
    if (testsExecuted(files) > 0) return;
    console.error("\nNO TESTS RAN: zero tests executed (none passed or failed), exiting with code 1\n");
    process.exitCode = 1;
  },
};

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
    minWorkers: 1,
    ...workersFromEnv(process.env.VITEST_MAX_WORKERS),
    passWithNoTests: false,
    reporters: ["default", noTestsRanGuard],
  },
});
