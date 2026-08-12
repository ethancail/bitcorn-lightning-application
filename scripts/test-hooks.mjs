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
//        1. clean tree            → exit 0, runners never invoked, AND says so
//           (the "says so" half exists because silence on this path is
//           indistinguishable from a pass — see verify-gate's decision table)
//        2. dirty + test failure  → exit 2 (blocks)
//        3. dirty + all green     → exit 0
//        4. baseline-only tsc errors → exit 0 (allowlist honored)
//        5. NEW tsc error in an allowlisted file → exit 2 (allowlist is file+code precise)
//        6. stop_hook_active=true → exit 0 (no infinite block loop)
//        7. VERIFY_GATE_SKIP=1    → exit 0 (escape hatch)
//        8. runner cannot execute → exit 0 + warning (broken env never traps)
//      Exit codes come from spawnSync .status directly — no pipes to mask them.
//   C. the conflict-markers job in .github/workflows/pr-checks.yml — EXTRACTS
//      the real `run:` script text out of the YAML and executes it under
//      GitHub's own shell for that step (/usr/bin/bash -e) with LC_ALL=C,
//      against throwaway fixture git repos:
//        1. clean tree                        → exit 0
//        2. marker in a .sql                  → exit 1, naming that file:line
//        3. marker in a .md                   → exit 1
//        4. marker in a .yml                  → exit 1
//        5. all three marker types, one file  → exit 1, three lines reported
//        6. "-- ====" separators only         → exit 0 (the .swarm/schema.sql shape)
//        7. 8-char "========" at column 0     → exit 0 (a hand-rolled grep gets this wrong)
//        8. trailing whitespace only          → exit 0 (this is not a whitespace gate)
//        9. markers indented / in backticks   → exit 0 (no self-match)
//       10. git that cannot run the scan      → exit 1 (could-not-run is a failure)
//       11. extractor rejects: emptied run block, renamed job, folded scalar,
//           two run: blocks
//       12. extractor rejects a TRUNCATED run block — truncation is non-empty
//           AND contains "diff --check", so only the sentinel assertion catches
//           it. That is what makes the sentinel real rather than decorative.
//      WHY EXTRACTION AND NOT A COPY OF THE BASH: a transcription tests the
//      transcription, and keeps passing forever after the YAML changes. Same
//      reason pr-checks.yml's own header refuses to let CI call verify-gate.mjs.
//
// READ-ONLY toward real state: fixtures live under os.tmpdir() and are
// removed on exit; the real repo, settings, and git state are never mutated.
//
// Overrides (used to prove the suite fails when a hook is weakened):
//   node scripts/test-hooks.mjs --settings <path>   # alternate settings.json
//   node scripts/test-hooks.mjs --gate-src <path>   # alternate verify-gate script
//   node scripts/test-hooks.mjs --workflow <path>   # alternate pr-checks.yml

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
const WORKFLOW_PATH =
  argValue("--workflow") || path.join(ROOT, ".github", "workflows", "pr-checks.yml");

let passCount = 0;
const failures = [];
// A case that CANNOT be exercised in this environment is recorded, not quietly
// dropped and not faked green. It is deliberately not counted as a pass.
const skipped = [];
function skip(name, why) {
  skipped.push(name);
  console.log(`  SKIP  ${name}\n        ${why}`);
}
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
    // rollback is publish-class: it republishes a prior Worker version to
    // production, which every member node picks up on its ~60s sync tick. It
    // takes -y, so it is fully non-interactive and needs a mechanical block,
    // not a prompt. The top-level spelling below is the one that exists in
    // wrangler 3.114.17 — verified via --help, not assumed.
    "wrangler rollback",
    "wrangler rollback -y",
    "npx wrangler rollback",
    "npx wrangler rollback 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d -y",
    "npx wrangler rollback -y -m 'revert bad deploy'",
    "npx wrangler@latest rollback -y", // version-pinned npx bypasses the bare `wrangler` rules
    // FORWARD COVERAGE — NOT DEAD WEIGHT, DO NOT DELETE. `wrangler versions
    // rollback` does NOT exist in wrangler 3.114.17: `wrangler versions`
    // offers only view/list/upload/deploy/secret, and `wrangler deployments`
    // only list/status (both checked via --help). It is denied anyway because
    // the failure it would prevent is SILENT — after a wrangler v4 bump the
    // subcommand may exist, an agent runs it, it succeeds, and nothing
    // surfaces that a publish-class command went unguarded. The rule costs
    // nothing while the subcommand is absent, and `versions upload` /
    // `versions deploy` are already denied, so it is consistent with this
    // block rather than speculative.
    //   Note what these cases do and don't assert: they prove the RULES match
    //   these command strings. They make no claim that the subcommand is real
    //   today, so they stay honest either side of a version bump.
    //   DELIBERATELY NO `Bash(npx wrangler@* versions rollback*)` RULE — do not
    //   add one. The existing `Bash(npx wrangler@* rollback*)` already subsumes
    //   the versions form: its `@*` wildcard spans arbitrary text, so
    //   `wrangler@` + `latest versions` + ` rollback` matches. Proven by
    //   isolation probe (deny list reduced to that one rule still blocks the
    //   last case below), not by reading glob semantics. A dedicated rule was
    //   written, measured as redundant, and removed.
    "wrangler versions rollback",
    "wrangler versions rollback -y",
    "npx wrangler versions rollback",
    "npx wrangler versions rollback 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d -y",
    // Regression guard on the SUBSUMPTION above, not on a versions-specific
    // rule: if someone narrows `npx wrangler@* rollback*` (say to
    // `npx wrangler@* rollback:*`, which the literal-colon trap would kill),
    // this case goes red and says so.
    "npx wrangler@latest versions rollback -y",
    // ---- @<spec> publish-class gap closure: delete / publish / versions upload
    // ⚠ ANY version spec bypasses the bare rules above, not just @latest. Those
    // are `:*` prefix rules anchored on the literal "npx wrangler ", so
    // "npx wrangler@3.114.17 delete" matches none of them. Each of the three
    // verbs below was measured UNCOVERED by isolation probe against the
    // pre-change deny list (zero coverers, not one) before a rule was added —
    // leave-one-out would have been blind to a second coverer if one existed.
    // By contrast `versions deploy` was reported as a gap and measured ALREADY
    // COVERED by `npx wrangler@* deploy*`, so it got no rule of its own; the
    // guard on that subsumption lives at the versions-rollback case above.
    //
    // delete is DESTRUCTIVE — it removes a Worker from Cloudflare outright.
    "npx wrangler@latest delete",
    "npx wrangler@3.114.17 delete", // a pinned spec — not an @latest quirk
    "npx wrangler@latest delete --name bitcorn-commodity-prices",
    // `publish` is NEITHER DEAD NOR FORWARD COVERAGE — do not downgrade this
    // comment to "speculative". In wrangler 3.114.17 it is a LIVE alias of
    // `wrangler deploy`, carrying metadata { deprecated: true, hidden: true },
    // and it is registered in the command tree: wrangler-dist/cli.js has
    // `command: "wrangler publish"` → publishAlias = createAlias({ aliasOf:
    // "wrangler deploy" }). `hidden: true` is precisely why it does NOT appear
    // in `wrangler --help`'s command list, which makes absence from that list
    // worthless as evidence either way. Verified by reading the registration,
    // NOT by an exit code — an unknown subcommand can exit 0 and print the
    // parent help. Re-derive after any wrangler major bump: publish is slated
    // for removal in the next major, at which point these become forward
    // coverage and the comment above should say so.
    "npx wrangler@latest publish",
    "npx wrangler@3.114.17 publish",
    // `versions upload` is step 1 of the two-step publish (upload, then
    // `versions deploy`). Guarding only step 2 would let a version be staged
    // unguarded, so both halves are denied.
    "npx wrangler@latest versions upload",
    "npx wrangler@latest versions upload --tag canary",
    "npm run deploy",
    "cd cloudflare-worker && npx wrangler deploy", // guardrail bypass via compound
    "cd cloudflare-worker && npx wrangler rollback -y", // same bypass, rollback
    "cd cloudflare-worker && npx wrangler@latest delete", // same bypass, @spec delete
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
    // Reading rollback eligibility must stay legal — these are how you find out
    // WHICH version you would roll back to, and blocking them would make the
    // deny rule above cost more than it protects.
    "npx wrangler deployments list",
    "npx wrangler deployments status",
    "npx wrangler versions list",
    "npx wrangler versions view 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    // The @<spec> rules must not blanket-block version-pinned wrangler — only
    // the publish-class verbs. These are the read-only siblings closest to the
    // three new rules ("versions upload" vs "versions list"/"view"), so they are
    // where an over-broad pattern would show up first.
    "npx wrangler@latest dev",
    "npx wrangler@latest versions list",
    "npx wrangler@latest versions view 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    // KNOWN AND ACCEPTED over-block, asserted nowhere because it would fail:
    // `wrangler rollback --help` IS denied, because `Bash(wrangler rollback:*)`
    // is a prefix rule and cannot carve out a flag. This is not a new cost —
    // `wrangler deploy --help` has always been denied by the same shape — and
    // the read-only commands above cover the actual inspection need.
    //
    // SECOND KNOWN AND ACCEPTED over-block, same reason (no assertion below,
    // because asserting it would fail): every `npx wrangler@* <verb>*` rule has
    // a wildcard that spans spaces, so it also matches that verb appearing as a
    // SUBcommand. Consequences, measured:
    //   - `npx wrangler@<spec> kv key delete ...` is denied by the new
    //     `@* delete*` rule, even though the UNPINNED documented form on the
    //     line below stays allowed and is what CLAUDE.md actually prescribes.
    //   - `npx wrangler@<spec> deployments list/status` is denied by the
    //     PRE-EXISTING `@* deploy*` rule — this one predates the delete rule and
    //     is not new here.
    // This is unavoidable with the available matcher, not an oversight: the spec
    // wildcard is what closes the "any spec bypasses" hole, and there is no
    // non-space wildcard to bound it with. Narrowing to a literal
    // `npx wrangler@latest delete*` would drop the over-block AND reopen
    // `npx wrangler@3.114.17 delete`, which is the exact bypass being closed.
    // Deliberate trade: over-block fails LOUDLY at a permission prompt and is
    // recoverable by dropping the version pin; under-block deletes a Worker
    // silently. Cost is bounded — nothing instructs an agent to pin a version.
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
  // The nothing-to-verify path is the ONLY branch that used to exit 0 without
  // printing, which made "I checked nothing" look exactly like "I checked and
  // it passed" — that is how work in a sibling repo, and work in this repo
  // outside the watched paths, reached a green-looking stop unverified.
  // Assert NON-SILENCE plus the log prefix, deliberately not the wording:
  // pinning the phrasing would make legitimate rewordings fail red, while
  // pinning silence catches the actual regression.
  check(
    "gate 1: clean tree ANNOUNCES that nothing was verified",
    r.out.trim() !== "" && r.out.includes("[verify-gate]"),
    `expected output on the nothing-to-verify path, got: ${JSON.stringify(r.out)}`,
  );

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
// C. pr-checks.yml conflict-marker gate
// ---------------------------------------------------------------------------

const GATE_SENTINEL = "# END conflict-marker gate";

// THE SEAM. One named function: locate, validate, de-indent, assert. A future
// "extract any run: block" helper should grow out of this rather than beside
// it — but the second caller does not exist yet, so this stays specific.
//
// Read-from-source, never transcription. If the YAML changes, the tests run the
// change. A copy of the bash in a JS string would test the copy and keep passing
// forever afterwards.
function extractConflictMarkerScript(workflowPath) {
  const lines = fs.readFileSync(workflowPath, "utf8").split("\n");

  const jobIdx = lines.findIndex((l) => /^ {2}conflict-markers:\s*$/.test(l));
  if (jobIdx < 0) throw new Error(`no '  conflict-markers:' job in ${workflowPath}`);

  // The job ends at the next two-space-indented key — i.e. the next job.
  let end = lines.length;
  for (let i = jobIdx + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break; }
  }

  // EXACTLY ONE run: block. A first-match extractor keeps working the day a
  // second step is added, and silently tests the wrong script from then on.
  const runs = [];
  for (let i = jobIdx + 1; i < end; i++) {
    const m = lines[i].match(/^(\s*)run:(.*)$/);
    if (m) runs.push({ idx: i, indent: m[1].length, scalar: m[2].trim() });
  }
  if (runs.length === 0) throw new Error("conflict-markers job has no 'run:' block");
  if (runs.length > 1) {
    throw new Error(
      `conflict-markers job has ${runs.length} 'run:' blocks; expected exactly 1 — ` +
        "a first-match extractor would test the wrong one",
    );
  }

  const { idx: runIdx, indent: runIndent, scalar } = runs[0];
  if (!/^\|-?$/.test(scalar)) {
    throw new Error(
      `run: must use a LITERAL block scalar (| or |-), got ${JSON.stringify(scalar)} — ` +
        "folded scalars join lines, and joined bash is not the same bash",
    );
  }

  // YAML block-scalar content sits one level deeper than its key.
  const indent = runIndent + 2;
  const pad = " ".repeat(indent);
  const body = [];
  for (let i = runIdx + 1; i < end; i++) {
    const l = lines[i];
    if (l.trim() === "") { body.push(""); continue; }
    if (!l.startsWith(pad)) break;
    body.push(l.slice(indent));
  }
  while (body.length && body[body.length - 1] === "") body.pop();

  const script = body.join("\n") + "\n";
  if (script.trim() === "") throw new Error("extracted script is EMPTY");
  if (!script.includes("diff --check")) {
    throw new Error("extracted script does not contain 'diff --check'");
  }
  const last = script.trimEnd().split("\n").pop().trim();
  if (last !== GATE_SENTINEL) {
    throw new Error(
      `extracted script does not end with ${JSON.stringify(GATE_SENTINEL)} — truncated? ` +
        `last line was ${JSON.stringify(last)}`,
    );
  }
  return script;
}

console.log("\n=== C. conflict-marker CI gate tests ===");
console.log(`workflow: ${WORKFLOW_PATH}`);

const CTMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-marker-tests-"));
try {
  // ⚠ THE SHELL IS SELECTED BY THE ABSENCE OF A KEY, WHICH IS EASY TO GET
  // BACKWARDS — it was, here, until run 31541635531's log settled it:
  //
  //     shell: /usr/bin/bash -e {0}
  //
  // A `run:` step with NO `shell:` key gets `bash -e` — errexit only, NO
  // pipefail. A step that EXPLICITLY writes `shell: bash` gets
  // `bash --noprofile --norc -eo pipefail`. So writing the key makes the shell
  // STRICTER, and omitting it is what selects the weaker one. The
  // conflict-markers job omits it, so `bash -e` is what its script actually
  // runs under and what this harness must reproduce.
  //
  // Checking the workflow for a `shell:` override and finding none is therefore
  // only half the question; the other half is which shell that absence buys.
  // Verifying under the stricter shell is a false comfort: it passes scripts CI
  // would also pass, while proving nothing about the pipefail-free semantics the
  // job is actually exposed to.
  const CI_SHELL_BIN = "/usr/bin/bash";
  const CI_SHELL_ARGS = ["-e"];
  const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const gitEnvC = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

  let seq = 0;
  const text = (...ls) => ls.join("\n") + "\n";

  // The gate scans HEAD, not the filesystem, so fixtures must be COMMITTED.
  function makeRepo(files) {
    const dir = path.join(CTMP, `repo-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const g = (...a) => {
      const r = spawnSync("git", a, { cwd: dir, encoding: "utf8", env: gitEnvC });
      if (r.status !== 0) throw new Error(`fixture git ${a.join(" ")} failed: ${r.stderr}`);
    };
    g("init", "-q");
    g("add", "-A");
    g("-c", "user.email=test@test", "-c", "user.name=test", "commit", "-q", "-m", "fixture");
    return dir;
  }

  let GATE_SCRIPT = null;
  let extractErr = "";
  try {
    GATE_SCRIPT = extractConflictMarkerScript(WORKFLOW_PATH);
  } catch (e) {
    extractErr = String(e);
  }
  check(
    "C0: extractor pulls a non-empty, sentinel-terminated script from the real YAML",
    GATE_SCRIPT !== null,
    extractErr,
  );

  function runGate(repoDir, pathPrefix = null) {
    if (!GATE_SCRIPT) return { status: null, stdout: "", stderr: "extraction failed" };
    const sp = path.join(CTMP, `gate-${++seq}.sh`);
    fs.writeFileSync(sp, GATE_SCRIPT);
    const r = spawnSync(CI_SHELL_BIN, [...CI_SHELL_ARGS, sp], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: pathPrefix ? pathPrefix + path.delimiter + process.env.PATH : process.env.PATH,
        HOME: CTMP,
        // Injected here rather than through a shell wrapper. The job supplies
        // LC_ALL: C in CI and the filter depends on git's English wording, so
        // pinning it reproduces CI instead of inheriting the developer's locale.
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  // ── 1. clean tree ────────────────────────────────────────────────────────
  let r = runGate(
    makeRepo({
      "app/api/src/db/migrations/001_init.sql": text("CREATE TABLE a (id INTEGER PRIMARY KEY);"),
      "README.md": text("# fixture", "", "Body text."),
    }),
  );
  check("C1: clean tree exits 0", r.status === 0, r.stdout + r.stderr);

  // ── 2. the shipping hazard ───────────────────────────────────────────────
  // Deliberately ONE marker line, not a full three-marker hunk: a partially
  // resolved conflict is the realistic .sql case, and a count of exactly 1 is
  // what lets the `-gt 1` sabotage in proof (iii) flip this case green.
  const SQL_PARTIAL = "app/api/src/db/migrations/054_partial.sql";
  r = runGate(
    makeRepo({
      [SQL_PARTIAL]: text(
        "-- 054 partial",
        "CREATE TABLE x (id INTEGER PRIMARY KEY);",
        "<<<<<<< HEAD",
        "ALTER TABLE x ADD COLUMN a TEXT;",
      ),
    }),
  );
  check("C2: marker in a .sql fails (exit 1)", r.status === 1, r.stdout + r.stderr);
  // MESSAGE, not just the code: a bash syntax error also exits 1, with a
  // `bash:` diagnostic and no marker text. Indistinguishable by code, trivial
  // by content.
  check(
    "C2: message names the marker AND its exact file:line",
    r.stdout.includes("leftover conflict marker") &&
      r.stdout.includes(`${SQL_PARTIAL}:3: leftover conflict marker`),
    r.stdout + r.stderr,
  );

  // ── 3/4. other extensions no other job typechecks ────────────────────────
  r = runGate(makeRepo({ "docs/x.md": text("# Doc", "body", ">>>>>>> feature/x") }));
  check("C3: marker in a .md fails (exit 1)", r.status === 1, r.stdout + r.stderr);

  r = runGate(
    makeRepo({
      "bitcorn-lightning-node/umbrel-app.yml": text('version: "1.0.0"', "<<<<<<< HEAD", "manifestVersion: 1"),
    }),
  );
  check("C4: marker in a .yml fails (exit 1)", r.status === 1, r.stdout + r.stderr);

  // ── 5. a full hunk: every marker line must be named ──────────────────────
  const TRIPLE = "app/api/src/db/migrations/055_triple.sql";
  r = runGate(
    makeRepo({
      [TRIPLE]: text(
        "CREATE TABLE y (id INTEGER PRIMARY KEY);",
        "<<<<<<< HEAD",
        "ALTER TABLE y ADD COLUMN a TEXT;",
        "=======",
        "ALTER TABLE y ADD COLUMN b TEXT;",
        ">>>>>>> feature/other",
      ),
    }),
  );
  check("C5: all three marker types fail (exit 1)", r.status === 1, r.stdout + r.stderr);
  const tripleHits = r.stdout
    .split("\n")
    .filter((l) => l.includes("leftover conflict marker") && l.includes(TRIPLE)).length;
  check("C5: all three marker lines are reported", tripleHits === 3, `saw ${tripleHits}\n${r.stdout}`);

  // ── 6/7. the two false positives a hand-rolled grep would produce ────────
  r = runGate(
    makeRepo({
      ".swarm/schema.sql": text(
        "-- ============================================",
        "-- clusters",
        "-- ============================================",
        "CREATE TABLE c (id INTEGER PRIMARY KEY);",
      ),
    }),
  );
  check("C6: '-- ====' separators pass (exit 0)", r.status === 0, r.stdout + r.stderr);

  // `^=======` with no end anchor matches this; git's exactly-seven rule does not.
  r = runGate(makeRepo({ "docs/setext.md": text("Heading", "========", "body") }));
  check("C7: 8-char '========' at column 0 passes (exit 0)", r.status === 0, r.stdout + r.stderr);

  // ── 8. this is not a whitespace gate ─────────────────────────────────────
  const WS_REPO = makeRepo({
    "app/web/src/x.ts": text("export const a = 1;   ", "export const b = 2;   "),
  });
  const emptyTree = spawnSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
    cwd: WS_REPO,
    encoding: "utf8",
    env: gitEnvC,
  }).stdout.trim();
  const wsRaw = spawnSync("git", ["diff", "--check", emptyTree, "HEAD"], {
    cwd: WS_REPO,
    encoding: "utf8",
    env: { ...gitEnvC, LC_ALL: "C" },
  });
  r = runGate(WS_REPO);
  check("C8: trailing whitespace only passes (exit 0)", r.status === 0, r.stdout + r.stderr);
  // Without this, C8 could be green because the fixture was vacuous. Prove
  // --check DID see something and the filter is what dropped it.
  check(
    "C8: --check DID report the whitespace; the filter is what dropped it",
    wsRaw.stdout.includes("trailing whitespace") &&
      !wsRaw.stdout.includes("leftover conflict marker"),
    wsRaw.stdout,
  );

  // ── 9. no self-match ─────────────────────────────────────────────────────
  r = runGate(
    makeRepo({
      ".claude/skills/x/SKILL.md": text(
        '- Before claiming done, `grep -rn "^<<<<<<<"` across the changed files.',
        "    <<<<<<< HEAD",
        "  =======",
        "Indented, so not column 0.",
      ),
    }),
  );
  check("C9: indented and backticked markers pass (exit 0)", r.status === 0, r.stdout + r.stderr);

  // ── 10. could-not-run is a failure ───────────────────────────────────────
  const BROKENBIN = path.join(CTMP, "brokenbin");
  fs.mkdirSync(BROKENBIN);
  fs.writeFileSync(
    path.join(BROKENBIN, "git"),
    text(
      "#!/usr/bin/env bash",
      "# Real git for everything EXCEPT the whole-tree `--check` scan, which is",
      "# forced to fail. `--no-index` still passes through, so the CANARY succeeds",
      "# and only the scan's could-not-run guard is under test.",
      'for a in "$@"; do [ "$a" = "--no-index" ] && exec ' + JSON.stringify(REAL_GIT) + ' "$@"; done',
      'for a in "$@"; do [ "$a" = "--check" ] && { echo "fatal: simulated git failure" >&2; exit 129; }; done',
      "exec " + JSON.stringify(REAL_GIT) + ' "$@"',
    ),
    { mode: 0o755 },
  );
  r = runGate(makeRepo({ "a.txt": text("clean") }), BROKENBIN);
  check("C10: a git that cannot run the scan fails (exit 1)", r.status === 1, r.stdout + r.stderr);
  check("C10: message says it could not run", r.stdout.includes("could not run"), r.stdout + r.stderr);

  // ── 11/12. the extractor's own assertions ────────────────────────────────
  // These sabotage COPIES of the workflow. A silently-empty or silently-wrong
  // extraction passes every case above, so these are the ones that keep C0-C10
  // honest.
  function bounds(lines) {
    const jobIdx = lines.findIndex((l) => /^ {2}conflict-markers:\s*$/.test(l));
    // Fail with a sentence, not a TypeError three frames later. Pointing
    // --workflow at a tree that predates the job lands here, and a crash would
    // abort the run before the summary prints — "could not run" reading as
    // something other than a failure, which is the bug this suite exists to stop.
    if (jobIdx < 0) throw new Error("variant base has no '  conflict-markers:' job to mutate");
    let end = lines.length;
    for (let i = jobIdx + 1; i < lines.length; i++) if (/^ {2}\S/.test(lines[i])) { end = i; break; }
    let runIdx = -1;
    let indent = 0;
    for (let i = jobIdx + 1; i < end; i++) {
      const m = lines[i].match(/^(\s*)run:(.*)$/);
      if (m) { runIdx = i; indent = m[1].length + 2; break; }
    }
    if (runIdx < 0) throw new Error("variant base has no 'run:' block to mutate");
    const pad = " ".repeat(indent);
    let bodyEnd = runIdx + 1;
    for (let i = runIdx + 1; i < end; i++) {
      if (lines[i].trim() === "" || lines[i].startsWith(pad)) bodyEnd = i + 1;
      else break;
    }
    return { jobIdx, runIdx, indent, bodyEnd };
  }

  function variant(name, transform) {
    const lines = fs.readFileSync(WORKFLOW_PATH, "utf8").split("\n");
    const out = transform(lines, bounds(lines));
    const p = path.join(CTMP, name);
    fs.writeFileSync(p, out.join("\n"));
    return p;
  }

  // Takes a THUNK, not a path: building the variant can itself fail (see
  // bounds()), and that must surface as a failed case with a reason rather than
  // an uncaught throw that kills the run before the summary.
  function mustThrow(name, buildVariant, expectSubstr) {
    let msg = null;
    try {
      extractConflictMarkerScript(buildVariant());
    } catch (e) {
      msg = String(e);
    }
    check(
      name,
      msg !== null && msg.includes(expectSubstr),
      msg === null ? "extractor did NOT throw" : `wrong error: ${msg}`,
    );
  }

  mustThrow(
    "C11a: extractor rejects an emptied run block",
    () =>
      variant("wf-empty.yml", (l, b) => {
        l.splice(b.runIdx + 1, b.bodyEnd - (b.runIdx + 1));
        return l;
      }),
    "EMPTY",
  );

  mustThrow(
    "C11b: extractor rejects a renamed job id",
    () =>
      variant("wf-renamed.yml", (l, b) => {
        l[b.jobIdx] = "  conflict-markers-renamed:";
        return l;
      }),
    "no '  conflict-markers:' job",
  );

  mustThrow(
    "C11c: extractor rejects a folded (>) block scalar",
    () =>
      variant("wf-folded.yml", (l, b) => {
        l[b.runIdx] = l[b.runIdx].replace(/run:\s*\|-?\s*$/, "run: >");
        return l;
      }),
    "LITERAL block scalar",
  );

  mustThrow(
    "C11d: extractor rejects a job carrying two run: blocks",
    () =>
      variant("wf-tworuns.yml", (l, b) => {
        l.splice(b.bodyEnd, 0, "      - name: second step", "        run: |", "          echo hi");
        return l;
      }),
    "expected exactly 1",
  );

  // Truncation is the case the other assertions CANNOT catch: the result is
  // non-empty and still contains "diff --check", so only the sentinel rejects
  // it. Requiring the "does not end with" wording specifically is what proves
  // this passed for the sentinel and not for one of the earlier assertions.
  mustThrow(
    "C12: extractor rejects a TRUNCATED run block (only the sentinel catches it)",
    () =>
      variant("wf-truncated.yml", (l, b) => {
        const body = l.slice(b.runIdx + 1, b.bodyEnd);
        const k = body.findIndex((x) => x.includes("diff --check"));
        l.splice(b.runIdx + 1, b.bodyEnd - (b.runIdx + 1), ...body.slice(0, k + 1));
        return l;
      }),
    "does not end with",
  );

  // ── 13. the LC_ALL=C pin itself ──────────────────────────────────────────
  skip(
    "C13: LC_ALL=C pin exercised against a translated git",
    "unrunnable in this environment, not faked: `locale -a` lists only C/POSIX and\n" +
      "        en_*, and no git.mo exists under /usr/share/locale/*/LC_MESSAGES, so git\n" +
      "        prints English regardless. Verified rather than assumed — LC_ALL=de_DE.UTF-8\n" +
      "        still produced the English 'leftover conflict marker'.\n" +
      "        TO RUN IT: generate a non-English locale (locale-gen) AND install git's\n" +
      "        translations, then assert the gate stays RED with the pin, and goes\n" +
      "        GREEN-AND-WRONG once the job's env: block is stripped. Until then the\n" +
      "        canary covers deletion of the pin at runtime, but not a regression in it.",
  );
} finally {
  fs.rmSync(CTMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

console.log(`\n${passCount} passed, ${failures.length} failed.`);
if (skipped.length > 0) {
  console.log(
    "Skipped (NOT verified in this environment):\n" + skipped.map((s) => `  - ${s}`).join("\n"),
  );
}
if (failures.length > 0) {
  console.log("Failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
