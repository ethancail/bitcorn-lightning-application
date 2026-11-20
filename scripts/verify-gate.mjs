#!/usr/bin/env node
// verify-gate.mjs — Stop-hook verification gate.
//
// Called by the Stop hook in .claude/settings.json every time a Claude
// Code turn ends. Blocks completion (exit 2) ONLY when uncommitted
// changes under app/api/ or app/web/ fail real verification; otherwise
// allows (exit 0). The gate is the runner's actual exit code — not the
// agent's claim that things pass.
//
// DECISION TABLE (degrade-gracefully is the design priority):
//   no uncommitted changes under WATCHED_PATHS ...... exit 0 (instant, no checks)
//                                                     + says so: this branch used
//                                                     to be the only silent one,
//                                                     and silence here reads as a
//                                                     pass. It cannot tell "clean
//                                                     tree" from "work happened
//                                                     somewhere this gate does not
//                                                     watch" — so it claims neither.
//   changes + checks pass ........................... exit 0
//   changes + checks RAN and FAILED ................. exit 2 (blocks; failure fed back)
//   changes + a runner COULD NOT RUN ................ exit 0 + loud warning (broken
//                                                     env must not trap the session)
//   stop_hook_active=true (already blocked once) .... exit 0 + warning even if still
//                                                     failing — prevents infinite
//                                                     block loops; guard, not a trap
//   VERIFY_GATE_SKIP=1 in the environment ........... exit 0 (documented escape hatch)
//   changes + heavy lock still held after 5 min ..... exit 2 ONCE: "verification not run:
//     (or this account refused the heavy lock,        heavy lock held by <holder> since
//     or taking it failed)                            <time>; run it when the lock frees"
//   ... and stop_hook_active=true ................... waits at most 10 s for the lock;
//                                                     still held: exit 0 + that warning,
//                                                     NOT VERIFIED
//
// THE HEAVY LOCK (A4, Ethan 2026-11-18; on flock, 2026-11-19): tsc and vitest
// are heavy jobs, so the checks run only under scripts/harness-slot.mjs's heavy
// lock, a kernel flock taken here in process before the first check, waiting up
// to HEAVY_WAIT_S (SECOND_TRY_WAIT_S on the second try). Each check is handed
// the locked descriptor as its fd 9 and the gate's job token as
// HARNESS_HEAVY_JOB (harness-slot.mjs, THE JOB TOKEN); a gate whose own
// environment carries the live holder's token checks under that hold instead.
// A gate killed mid-check leaves the lock
// with that check until it exits; there are no signal handlers here. It is
// never reported as a pass when its checks did not run. The Stop hook's timeout
// in .claude/settings.json (960 s) covers the wait plus the four 150 s checks;
// lower it and the hook is killed mid-wait.
// Test-only: VERIFY_GATE_HEAVY_WAIT_S shortens the wait, announced when set.
//
// WHAT RUNS (scoped to the side that changed, for speed):
//   app/api dirty → npx --no-install tsc --noEmit && npx --no-install vitest run   (in app/api)
//   app/web dirty → npx --no-install tsc --noEmit && npx --no-install vitest run   (in app/web)
//   `vite build` is deliberately NOT run here (adds ~5-20s per Stop and
//   tsc catches the type breakage) — the full build stays a release check.
//
// KNOWN-BASELINE tsc errors (main, 2026-07): the recharts `payload`
// quartet + SwapOperations adminLoopIn* pair are pre-existing and are
// allowlisted below by (file, TS-code) — they never block. Remove the
// allowlist entries when the baseline is fixed. A new error in one of
// those files with the SAME code would be masked — acceptable tradeoff,
// revisit if those files churn.
//
// Escape hatch: VERIFY_GATE_SKIP=1 claude   (or export it in the shell)
// Documented in CLAUDE.md § Build & Dev.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CMD_TIMEOUT_MS = 150_000;
const HEAVY_WAIT_S = 300;
const SECOND_TRY_WAIT_S = 10;
// While the checks run under the heavy lock: their stdio, the locked
// descriptor as fd 9 (harness-slot.mjs heavyStdio), and their environment,
// carrying the gate's job token (HARNESS_HEAVY_JOB). null otherwise.
let checkStdio = null;
let checkEnv = null;

// The only paths this gate watches. Single source of truth on purpose: the
// `git status` pathspec below and the nothing-to-verify message both read from
// here, so the message can never advertise a scope the check doesn't have.
// Everything else — cloudflare-worker/, .github/, docs/, root files, and every
// other repo on the machine — is OUTSIDE this gate.
const WATCHED_PATHS = ["app/api", "app/web"];

// Pre-existing tsc baseline on main: [file-as-tsc-prints-it, TS code].
const WEB_TSC_BASELINE = [
  ["src/components/CornBitcoinChart.tsx", "TS2339"],
  ["src/components/CornMovingAveragesChart.tsx", "TS2339"],
  ["src/components/MovingAveragesChart.tsx", "TS2339"],
  ["src/components/PowerLawChart.tsx", "TS2339"],
  ["src/pages/SwapOperations.tsx", "TS2551"],
  ["src/pages/SwapOperations.tsx", "TS2339"],
];

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(data), 2000);
  });
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: CMD_TIMEOUT_MS,
    env: checkEnv ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    ...(checkStdio === null ? {} : { stdio: checkStdio }),
  });
}

// → {state: "ok" | "fail" | "unavailable", detail}
function checkTsc(pkgDir, baseline) {
  const res = run("npx", ["--no-install", "tsc", "--noEmit"], path.join(ROOT, pkgDir));
  if (res.error) return { state: "unavailable", detail: `tsc could not run: ${res.error.message}` };
  if (res.status === 0) return { state: "ok", detail: "tsc clean" };
  const out = (res.stdout || "") + (res.stderr || "");
  const errs = out
    .split("\n")
    .map((l) => l.match(/^(.+?)\(\d+,\d+\): error (TS\d+):/))
    .filter(Boolean)
    .map((m) => ({ file: m[1], code: m[2], line: m[0] }));
  if (errs.length === 0) {
    return { state: "unavailable", detail: `tsc exited ${res.status} with no TS errors parsed:\n${out.slice(-400)}` };
  }
  const fresh = errs.filter(
    (e) => !baseline.some(([f, c]) => e.file === f && e.code === c),
  );
  if (fresh.length === 0) {
    return { state: "ok", detail: `tsc: only known-baseline errors (${errs.length})` };
  }
  return {
    state: "fail",
    detail: `tsc: ${fresh.length} NEW error(s) (baseline filtered):\n` + fresh.map((e) => e.line).join("\n"),
  };
}

function checkVitest(pkgDir) {
  const res = run("npx", ["--no-install", "vitest", "run"], path.join(ROOT, pkgDir));
  if (res.error) return { state: "unavailable", detail: `vitest could not run: ${res.error.message}` };
  const out = (res.stdout || "") + (res.stderr || "");
  const ran = out.includes("Test Files");
  if (!ran) {
    return { state: "unavailable", detail: `vitest exited ${res.status} without a test summary:\n${out.slice(-400)}` };
  }
  if (res.status === 0) return { state: "ok", detail: "vitest green" };
  const tail = out.split("\n").filter((l) => l.trim()).slice(-25).join("\n");
  return { state: "fail", detail: `vitest FAILED:\n${tail}` };
}

const main = async () => {
  if (process.env.VERIFY_GATE_SKIP === "1") {
    console.log("[verify-gate] VERIFY_GATE_SKIP=1 — gate bypassed.");
    process.exit(0);
  }

  let hook = {};
  try {
    hook = JSON.parse((await readStdin()) || "{}");
  } catch {}

  const status = run("git", ["status", "--porcelain", "--", ...WATCHED_PATHS], ROOT);
  if (status.error || status.status !== 0) {
    console.error("[verify-gate] WARN: git status failed — allowing stop (cannot determine changes).");
    process.exit(0);
  }
  const lines = status.stdout.split("\n").filter((l) => l.trim());
  const apiDirty = lines.some((l) => l.includes("app/api/"));
  const webDirty = lines.some((l) => l.includes("app/web/"));
  if (!apiDirty && !webDirty) {
    // Never block — but never claim a pass either. This branch cannot tell a
    // genuinely clean turn from one whose work landed outside WATCHED_PATHS
    // (another repo, or cloudflare-worker/ | .github/ | docs/ in this one), so
    // it states the scope instead of implying coverage it doesn't have.
    // Scoping verification to the work rather than to a path is a separate
    // change; this one only stops the gap from being invisible.
    console.log(
      `[verify-gate] nothing to verify — ${WATCHED_PATHS.join(", ")} clean in ${path.basename(ROOT)}\n` +
        "[verify-gate] NOT checked: everything else in this repo, and all other repos",
    );
    process.exit(0);
  }

  const hold = await takeHeavy(hook);
  if (!hold.ok) {
    // A4: blocks once; stop_hook_active lets the session end with the warning. Never a pass.
    if (hook.stop_hook_active) {
      console.error(`[verify-gate] WARN: ${hold.notRun} — allowing stop on the second try. NOT VERIFIED.`);
      process.exit(0);
    }
    console.error(`[verify-gate] ${hold.notRun}`);
    process.exit(2);
  }
  let code;
  try {
    code = runChecks(apiDirty, webDirty, hook);
  } finally {
    hold.release();
  }
  process.exit(code);
};

// A4: the heavy lock, or why the checks will not run. { ok: true, release() }
// or { ok: false, notRun }. A held lock and a refused account both take the
// not-run path (ruling 3), as do a lock module that cannot load and an error
// taking the lock.
async function takeHeavy(hook) {
  let heavy;
  try {
    heavy = await import("./harness-slot.mjs");
  } catch (error) {
    return { ok: false, notRun: `verification not run: the heavy lock's module could not load (${error.message})` };
  }
  let ctx;
  try {
    ctx = heavy.heavyContext(process.env);
  } catch (error) {
    return { ok: false, notRun: `verification not run: ${error.message}` };
  }
  for (const note of ctx.notes) console.error(`[verify-gate] ${note}`);
  // #7: an error taking the lock is "not run" too, never a crash that lets the stop through.
  try {
    if (heavy.heldByThisJob(ctx.home)) {
      const info = heavy.readHeavyInfo(ctx.home);
      console.error(`[verify-gate] the heavy lock is this job's own (${JSON.stringify(info?.holder ?? "(unrecorded)")}); checking under it`);
      return { ok: true, release: () => {} };
    }
    let waitS = HEAVY_WAIT_S;
    if (process.env.VERIFY_GATE_HEAVY_WAIT_S !== undefined) {
      waitS = Number(process.env.VERIFY_GATE_HEAVY_WAIT_S);
      if (!(waitS >= 0)) waitS = HEAVY_WAIT_S; // NaN would wait forever
      console.error(`[verify-gate] TEST wait: ${waitS}s for the heavy lock (VERIFY_GATE_HEAVY_WAIT_S), not ${HEAVY_WAIT_S}s`);
    }
    // #8: the first try already said the lock is held; the second only looks again.
    if (hook.stop_hook_active && waitS > SECOND_TRY_WAIT_S) {
      waitS = SECOND_TRY_WAIT_S;
      console.error(`[verify-gate] second try: waiting at most ${SECOND_TRY_WAIT_S}s for the heavy lock`);
    }
    const r = await heavy.lockHeavy({
      home: ctx.home,
      waitMs: waitS * 1000,
      pollMs: Math.max(1000, Math.min(5000, waitS * 1000)),
      say: (m) => console.error(`[verify-gate] ${m}`),
    });
    if (r.fd === null) {
      return {
        ok: false,
        notRun: `verification not run: heavy lock held by ${JSON.stringify(r.info?.holder ?? "(unrecorded)")} ` +
          `since ${r.info?.acquired_at ?? "?"}; run it when the lock frees`,
      };
    }
    let rec;
    const holder = `${ctx.account}@${ctx.host}:node scripts/verify-gate.mjs (${path.basename(ROOT)})`;
    const job = heavy.jobToken(holder, process.pid);
    try {
      rec = heavy.recordHeavy(ctx.home, r.fd, { holder, host: ctx.host, kind: "gate", pid: process.pid, job });
    } catch (error) {
      fs.closeSync(r.fd);
      throw error;
    }
    checkStdio = heavy.heavyStdio(["pipe", "pipe", "pipe"], r.fd);
    checkEnv = { ...process.env, HARNESS_HEAVY_JOB: job };
    return {
      ok: true,
      release: () => {
        checkStdio = null;
        checkEnv = null;
        try {
          console.error(`[verify-gate] ${rec.release()}`);
        } catch (error) {
          console.error(`[verify-gate] WARN: the heavy lock's record was not cleared: ${error.message}`);
        }
      },
    };
  } catch (error) {
    return { ok: false, notRun: `verification not run: the heavy lock could not be taken (${error.message})` };
  }
}

// The checks themselves, unchanged in substance: prints the verdict and returns the exit code.
function runChecks(apiDirty, webDirty, hook) {
  const t0 = Date.now();
  const results = [];
  if (apiDirty) {
    results.push(["api tsc", checkTsc("app/api", [])]);
    results.push(["api vitest", checkVitest("app/api")]);
  }
  if (webDirty) {
    results.push(["web tsc", checkTsc("app/web", WEB_TSC_BASELINE)]);
    results.push(["web vitest", checkVitest("app/web")]);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const failures = results.filter(([, r]) => r.state === "fail");
  const unavailable = results.filter(([, r]) => r.state === "unavailable");

  if (failures.length > 0) {
    const report = failures.map(([name, r]) => `--- ${name} ---\n${r.detail}`).join("\n");
    if (hook.stop_hook_active) {
      console.error(
        `[verify-gate] STILL FAILING after a previous block (${secs}s) — allowing stop to avoid a block loop. FIX BEFORE PUSHING:\n${report}`,
      );
      return 0;
    }
    console.error(
      `[verify-gate] BLOCKED (${secs}s): uncommitted changes fail verification. Fix (or ask the user to set VERIFY_GATE_SKIP=1 to bypass knowingly):\n${report}`,
    );
    return 2;
  }

  if (unavailable.length > 0) {
    const report = unavailable.map(([name, r]) => `--- ${name} ---\n${r.detail}`).join("\n");
    console.error(
      `[verify-gate] WARN (${secs}s): could not run some checks — allowing stop (a broken env must not trap the session). NOT VERIFIED:\n${report}`,
    );
    return 0;
  }

  console.log(`[verify-gate] PASS (${secs}s): ${results.map(([n]) => n).join(", ")}.`);
  return 0;
}

main().catch((err) => {
  console.error(`[verify-gate] WARN: gate itself crashed (${err?.message}) — allowing stop.`);
  process.exit(0);
});
