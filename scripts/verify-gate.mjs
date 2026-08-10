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
//
// WHAT RUNS (scoped to the side that changed, for speed):
//   app/api dirty → npx tsc --noEmit && npx vitest run   (in app/api)
//   app/web dirty → npx tsc --noEmit && npx vitest run   (in app/web)
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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CMD_TIMEOUT_MS = 150_000;

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
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// → {state: "ok" | "fail" | "unavailable", detail}
function checkTsc(pkgDir, baseline) {
  const res = run("npx", ["tsc", "--noEmit"], path.join(ROOT, pkgDir));
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
  const res = run("npx", ["vitest", "run"], path.join(ROOT, pkgDir));
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
      process.exit(0);
    }
    console.error(
      `[verify-gate] BLOCKED (${secs}s): uncommitted changes fail verification. Fix (or ask the user to set VERIFY_GATE_SKIP=1 to bypass knowingly):\n${report}`,
    );
    process.exit(2);
  }

  if (unavailable.length > 0) {
    const report = unavailable.map(([name, r]) => `--- ${name} ---\n${r.detail}`).join("\n");
    console.error(
      `[verify-gate] WARN (${secs}s): could not run some checks — allowing stop (a broken env must not trap the session). NOT VERIFIED:\n${report}`,
    );
    process.exit(0);
  }

  console.log(`[verify-gate] PASS (${secs}s): ${results.map(([n]) => n).join(", ")}.`);
  process.exit(0);
};

main().catch((err) => {
  console.error(`[verify-gate] WARN: gate itself crashed (${err?.message}) — allowing stop.`);
  process.exit(0);
});
