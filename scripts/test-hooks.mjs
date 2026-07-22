#!/usr/bin/env node
// test-hooks.mjs — regression tests for the two agent-safety hooks.
//
// Run:  node scripts/test-hooks.mjs          (exit 0 = all pass, 1 = failures)
//
// What it tests:
//   A. permissions.deny (.claude/settings.json) — parses the deny array and
//      pattern-matches it against a table of commands that MUST be blocked
//      (git push variants, gh pr create/merge, cast send, forge --broadcast,
//      wrangler deploy/secret, npm run deploy, compound forms) and commands
//      that MUST stay allowed (git add/commit/status, cast call, forge build,
//      forge script without --broadcast, wrangler dev/kv, tsc, vitest).
//      The matcher reimplements Claude Code's Bash-rule semantics as
//      live-verified 2026-07-22 on CC 2.1.217:
//        - "P:*" (no other wildcard) = word-boundary prefix: matches "P" and "P <args>"
//        - "*" anywhere else = glob over the whole string, matches "" and spans spaces
//        - in a rule that also contains a mid-pattern "*", ":" is a LITERAL colon
//        - compound commands are matched per-subcommand
//      This catches settings-file regressions exactly; if Claude Code's
//      matcher semantics ever change, re-verify live (see permission-
//      boundaries commit message).
//   B. verify-gate.mjs (Stop hook) — copies the real script into a throwaway
//      fixture git repo in a temp dir and drives its documented decision
//      table with a stub `npx` on PATH (no real tsc/vitest needed):
//        1. clean tree            → exit 0, runners never invoked
//        2. dirty + test failure  → exit 2 (blocks)
//        3. dirty + all green     → exit 0
//        4. baseline-only tsc errors → exit 0 (allowlist honored)
//        5. NEW tsc error in an allowlisted file → exit 2 (allowlist is file+code precise)
//        6. stop_hook_active=true → exit 0 (no infinite block loop)
//        7. VERIFY_GATE_SKIP=1    → exit 0 (escape hatch)
//        8. runner cannot execute → exit 0 + warning (broken env never traps)
//      Exit codes come from spawnSync .status directly — no pipes to mask them.
//
// READ-ONLY toward real state: fixtures live under os.tmpdir() and are
// removed on exit; the real repo, settings, and git state are never mutated.
//
// Overrides (used to prove the suite fails when a hook is weakened):
//   node scripts/test-hooks.mjs --settings <path>   # alternate settings.json
//   node scripts/test-hooks.mjs --gate-src <path>   # alternate verify-gate script

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const SETTINGS_PATH = argValue("--settings") || path.join(ROOT, ".claude", "settings.json");
const GATE_SRC = argValue("--gate-src") || path.join(ROOT, "scripts", "verify-gate.mjs");

let passCount = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail.split("\n").join("\n        ")}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// A. permissions.deny pattern tests
// ---------------------------------------------------------------------------

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Claude Code Bash-rule → RegExp, per the empirically verified semantics.
function bashRuleToRegex(inner) {
  const body = inner.endsWith(":*") ? inner.slice(0, -2) : null;
  if (body !== null && !body.includes("*")) {
    // simple prefix rule: bare command or command + space + anything
    return new RegExp("^" + escRe(body) + "( .*)?$");
  }
  // glob rule: "*" matches any chars (incl. none, incl. spaces); ":" literal
  return new RegExp("^" + inner.split("*").map(escRe).join(".*") + "$");
}

// Claude Code evaluates each subcommand of a compound command independently.
// Minimal splitter for the plain test strings below (none contain quoted
// separators, so no shell-grade parsing is needed).
function subcommands(cmd) {
  return cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

console.log("\n=== A. permissions.deny pattern tests ===");
console.log(`settings: ${SETTINGS_PATH}`);

let deny = null;
try {
  deny = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"))?.permissions?.deny;
} catch (e) {
  check("settings.json parses", false, String(e));
}
check("permissions.deny block present (security-critical)", Array.isArray(deny) && deny.length > 0);

if (Array.isArray(deny)) {
  const bashRegexes = deny
    .filter((r) => r.startsWith("Bash(") && r.endsWith(")"))
    .map((r) => bashRuleToRegex(r.slice(5, -1)));
  const denySet = new Set(deny);
  const isBlocked = (cmd) =>
    subcommands(cmd).some((sub) => bashRegexes.some((re) => re.test(sub)));

  const MUST_BLOCK = [
    "git push",
    "git push origin main",
    "git push --force origin main",
    "git -C . push",
    "git -C /repo push origin main",
    "git -c user.name=x push origin main",
    "gh pr merge",
    "gh pr merge 231 --squash",
    "gh pr create",
    "gh pr create --fill",
    "cast send 0xAbC 'transfer(address,uint256)' 0xDeF 1",
    "cast publish 0xdeadbeef",
    "cast rpc eth_sendRawTransaction 0xdead",
    "forge script script/Deploy.s.sol --broadcast",
    "forge script --broadcast script/Deploy.s.sol",
    "forge script script/Deploy.s.sol --broadcast --verify",
    "forge create src/Router.sol:Router",
    "npx wrangler deploy",
    "wrangler deploy",
    "npx wrangler@latest deploy",
    "npx wrangler secret put COINBASE_KEY",
    "wrangler secret put X",
    "npm run deploy",
    "cd cloudflare-worker && npx wrangler deploy", // guardrail bypass via compound
  ];

  const MUST_ALLOW = [
    'git commit -m "feat: thing"',
    'git commit -m "fix push bug"', // message contains "push" — must NOT block
    "git add -p",
    "git add scripts/test-hooks.mjs",
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff --stat",
    "git checkout -b feature/x",
    "git fetch origin",
    "git merge feature/x", // local merges stay legal (protected-branch merge is instruction-level)
    "gh pr view 230",
    "gh pr list",
    "gh run rerun 123 --failed", // documented CLAUDE.md fix step
    "cast call 0xAbC 'balanceOf(address)' 0xDeF",
    "cast balance 0xDeF",
    "forge build",
    "forge test -vvv",
    "forge script script/Deploy.s.sol", // simulation without --broadcast
    "npm run build",
    "npm run dev",
    "npx wrangler dev",
    "npx wrangler kv key delete commodity_prices --namespace-id=x", // documented maintenance op
    "npx tsc --noEmit",
    "npx vitest run",
  ];

  // GitHub MCP remote-write tools must stay deny-listed (push/merge bypass path).
  const MCP_MUST_DENY = [
    "mcp__plugin_github_github__push_files",
    "mcp__plugin_github_github__create_or_update_file",
    "mcp__plugin_github_github__delete_file",
    "mcp__plugin_github_github__create_branch",
    "mcp__plugin_github_github__create_pull_request",
    "mcp__plugin_github_github__merge_pull_request",
    "mcp__plugin_github_github__update_pull_request_branch",
  ];

  for (const cmd of MUST_BLOCK) check(`blocked: ${cmd}`, isBlocked(cmd));
  for (const cmd of MUST_ALLOW) check(`allowed: ${cmd}`, !isBlocked(cmd));
  for (const tool of MCP_MUST_DENY) check(`mcp denied: ${tool}`, denySet.has(tool));
}

// ---------------------------------------------------------------------------
// B. verify-gate.mjs behavior tests
// ---------------------------------------------------------------------------

console.log("\n=== B. verify-gate Stop hook tests ===");
console.log(`gate: ${GATE_SRC}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-hook-tests-"));
try {
  const FX = path.join(TMP, "fixture");
  const STUBBIN = path.join(TMP, "stubbin");
  const GITONLY = path.join(TMP, "gitonly");
  const STUB_LOG = path.join(TMP, "stub.log");
  fs.mkdirSync(path.join(FX, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(FX, "app", "api", "src"), { recursive: true });
  fs.mkdirSync(path.join(FX, "app", "web", "src"), { recursive: true });
  fs.mkdirSync(STUBBIN);
  fs.mkdirSync(GITONLY);

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: FX, encoding: "utf8", env: gitEnv });
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };

  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.symlinkSync(realGit, path.join(STUBBIN, "git"));
  fs.symlinkSync(realGit, path.join(GITONLY, "git"));
  fs.writeFileSync(
    path.join(STUBBIN, "npx"),
    [
      "#!/usr/bin/env bash",
      'printf \'%s\\n\' "$*" >> "$STUB_LOG"',
      'case "$1" in',
      '  tsc)    [ -n "$STUB_TSC_OUT" ] && cat "$STUB_TSC_OUT"; exit "${STUB_TSC_EXIT:-0}" ;;',
      '  vitest) [ -n "$STUB_VITEST_OUT" ] && cat "$STUB_VITEST_OUT"; exit "${STUB_VITEST_EXIT:-0}" ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // Stub runner output fixtures (formats verify-gate parses).
  const OUT = {
    vitestGreen: path.join(TMP, "vitest-green.txt"),
    vitestFail: path.join(TMP, "vitest-fail.txt"),
    tscBaselineOnly: path.join(TMP, "tsc-baseline.txt"),
    tscNewInBaselineFile: path.join(TMP, "tsc-new.txt"),
  };
  fs.writeFileSync(OUT.vitestGreen, " Test Files  3 passed (3)\n Tests  42 passed (42)\n");
  fs.writeFileSync(
    OUT.vitestFail,
    " FAIL  src/x.test.ts > treasury guard\n Test Files  1 failed | 2 passed (3)\n Tests  1 failed | 41 passed (42)\n",
  );
  fs.writeFileSync(
    OUT.tscBaselineOnly,
    "src/components/PowerLawChart.tsx(10,5): error TS2339: Property 'payload' does not exist.\n" +
      "src/pages/SwapOperations.tsx(12,7): error TS2551: Property 'adminLoopIn' does not exist.\n",
  );
  fs.writeFileSync(
    OUT.tscNewInBaselineFile,
    "src/pages/SwapOperations.tsx(12,7): error TS2551: Property 'adminLoopIn' does not exist.\n" +
      "src/pages/SwapOperations.tsx(99,1): error TS9999: fabricated NEW error in allowlisted file.\n",
  );

  fs.copyFileSync(GATE_SRC, path.join(FX, "scripts", "verify-gate.mjs"));
  fs.writeFileSync(path.join(FX, "app", "api", "src", "x.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(FX, "app", "web", "src", "x.ts"), "export const b = 1;\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=test@test", "-c", "user.name=test", "commit", "-q", "-m", "fixture");

  function runGate({ dirty = null, stdin = "{}", env = {}, brokenRunner = false } = {}) {
    git("checkout", "--", ".");
    if (fs.existsSync(STUB_LOG)) fs.unlinkSync(STUB_LOG);
    if (dirty) fs.appendFileSync(path.join(FX, "app", dirty, "src", "x.ts"), "// dirty\n");
    const r = spawnSync(process.execPath, [path.join(FX, "scripts", "verify-gate.mjs")], {
      cwd: FX,
      encoding: "utf8",
      input: stdin,
      timeout: 60_000,
      env: {
        PATH: brokenRunner ? GITONLY : STUBBIN + path.delimiter + process.env.PATH,
        HOME: TMP,
        STUB_LOG,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...env,
      },
    });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  }

  // 1. clean tree → exit 0, runners never invoked
  let r = runGate();
  check("gate 1: clean tree exits 0", r.status === 0, r.out);
  check("gate 1: no runner invoked on clean tree", !fs.existsSync(STUB_LOG));

  // 2. dirty + failing vitest → exit 2, blocks with clear message
  r = runGate({ dirty: "api", env: { STUB_VITEST_OUT: OUT.vitestFail, STUB_VITEST_EXIT: "1" } });
  check("gate 2: failing test blocks (exit 2)", r.status === 2, r.out);
  check("gate 2: block message names the failure", r.out.includes("BLOCKED") && r.out.includes("vitest FAILED"), r.out);

  // 3. dirty + all green → exit 0
  r = runGate({ dirty: "api", env: { STUB_VITEST_OUT: OUT.vitestGreen } });
  check("gate 3: passing checks allow (exit 0)", r.status === 0 && r.out.includes("PASS"), r.out);

  // 4. baseline-only tsc errors on web → exit 0 (allowlist honored)
  r = runGate({
    dirty: "web",
    env: { STUB_TSC_OUT: OUT.tscBaselineOnly, STUB_TSC_EXIT: "2", STUB_VITEST_OUT: OUT.vitestGreen },
  });
  check("gate 4: baseline tsc errors do not block", r.status === 0 && r.out.includes("PASS"), r.out);

  // 5. NEW tsc error in an allowlisted file → still blocks (file+code precise)
  r = runGate({
    dirty: "web",
    env: { STUB_TSC_OUT: OUT.tscNewInBaselineFile, STUB_TSC_EXIT: "2", STUB_VITEST_OUT: OUT.vitestGreen },
  });
  check("gate 5: new error in allowlisted file blocks (exit 2)", r.status === 2, r.out);
  check("gate 5: message shows the new error", r.out.includes("NEW error") && r.out.includes("TS9999"), r.out);

  // 6. stop_hook_active + still failing → exit 0 (no infinite block loop)
  r = runGate({
    dirty: "api",
    stdin: '{"stop_hook_active": true}',
    env: { STUB_VITEST_OUT: OUT.vitestFail, STUB_VITEST_EXIT: "1" },
  });
  check("gate 6: stop_hook_active prevents block loop (exit 0)", r.status === 0, r.out);
  check("gate 6: still surfaces the failure loudly", r.out.includes("STILL FAILING"), r.out);

  // 7. VERIFY_GATE_SKIP=1 → bypass even with failures
  r = runGate({
    dirty: "api",
    env: { VERIFY_GATE_SKIP: "1", STUB_VITEST_OUT: OUT.vitestFail, STUB_VITEST_EXIT: "1" },
  });
  check("gate 7: VERIFY_GATE_SKIP=1 bypasses (exit 0)", r.status === 0 && r.out.includes("bypassed"), r.out);

  // 8. runner cannot execute (no npx on PATH) → warn but allow
  r = runGate({ dirty: "api", brokenRunner: true });
  check("gate 8: broken runner env allows (exit 0)", r.status === 0, r.out);
  check("gate 8: warns NOT VERIFIED instead of blocking", r.out.includes("NOT VERIFIED") && r.out.includes("could not run"), r.out);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

console.log(`\n${passCount} passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.log("Failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
