#!/usr/bin/env node
// harness-slot-heavy.test.mjs — node:test suite for the heavy lock in
// scripts/harness-slot.mjs (decision H1–H7, 2026-11-18, as amended by A1–A4;
// rebuilt on kernel flock, 2026-11-19).
//
// Run the Node 20 binary by its path, under the heavy lock (this suite is a
// heavy job itself):
//   node scripts/harness-slot.mjs heavy run -- ~/.nvm/versions/node/v20.20.2/bin/node --test scripts/harness-slot-heavy.test.mjs
//
// Every lock here lives in a scratch home (HARNESS_HEAVY_TEST_HOME), never the
// account's real heavy.lock, with one exception that takes no lock: the
// scratch-$HOME control reads `heavy status`, which only prints the path and
// what /proc/locks says. The processes are real: wrappers, their commands,
// holder processes, flock(1), SIGTERM and SIGKILL. Whether a lock is held is
// asked of the kernel by a route independent of the code under test: a
// non-blocking flock(1) on the file (lockState).
//
// Retired with the provably-dead design (2026-11-19), because the kernel now
// frees a dead job's lock and there is nothing left to take over:
//   - "SIGKILL of the wrapper AND its command: the lock stays, and the next
//      acquirer takes over from the provably dead holder" — now: freed at once.
//   - "a reused pid (live, but with another start time) is not mistaken for
//      the holder: taken over" — no pid decides who holds the lock.
//   - "a live holder (pid AND start time match) is waited on and reported,
//      never taken over — whatever its group" — now: any holder outside the
//      job, a bare flock(1) included, is waited on.
//   - "not provable is waited on: another host, no pid, an unreadable lock" —
//      now: the info file is display only, held or not is the kernel's.
//   - "provablyDead, case by case" — the function is gone.
//
// Linux only (/proc, /usr/bin/flock). The account check passes on ubuntu-pc as
// user and on the OptiPlex as harnessagent; anywhere else the CLI controls are
// refused, loudly.
//
// No CI job runs this, and the Stop hook does not watch scripts/. Run it by hand.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HEAVY_ACCOUNTS, heavyAccountRefusal, heavyContext, procStart } from "./harness-slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "harness-slot.mjs");
const NODE = process.execPath;
const HOST = os.hostname();
// bitcorn-workflow tests/browser-slot.py:113 keeps waiting only while the
// refusal matches this; anything else fails it at once.
const WORKFLOW_WAIT = /is already locked by |refused: setup\.lock is held by /;

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "heavy-test-"));
const locksDir = (home) => path.join(home, ".bitcorn-dev", "locks");
const lockPath = (home) => path.join(locksDir(home), "heavy.lock");
const infoPath = (home) => path.join(locksDir(home), "heavy.info.json");
const historyPath = (home) => path.join(locksDir(home), "history.log");
const history = (home) => (fs.existsSync(historyPath(home)) ? fs.readFileSync(historyPath(home), "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every test is bounded, so a broken lock fails a test instead of hanging the file.
const ttest = (name, fn) => test(name, { timeout: 60_000 }, fn);

// The kernel's answer, not the code under test's: "free", "held", or a throw.
// (-n takes the lock for an instant when free; nothing here waits on it then.)
function lockState(home) {
  if (!fs.existsSync(lockPath(home))) return "free";
  const r = spawnSync("/usr/bin/flock", ["-n", "-E", "200", lockPath(home), "true"]);
  if (r.status === 0) return "free";
  if (r.status === 200) return "held";
  throw new Error(`flock(1) could not answer: status ${r.status}, ${r.error?.message ?? ""}`);
}

// The CLI under Node 20, its environment built from scratch: no inherited $HOME.
function start(args, { home, env = {}, slotHome, viaSh = false } = {}) {
  // viaSh: run the CLI as a child of a /bin/sh (not exec-ed), so its parent is not this file.
  const [cmd, argv] = viaSh ? ["/bin/sh", ["-c", "\"$0\" \"$@\"; exit $?", NODE, SCRIPT, ...args]] : [NODE, [SCRIPT, ...args]];
  const child = spawn(cmd, argv, {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: slotHome ?? scratch(), HARNESS_HEAVY_TEST_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = once(child, "exit").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, done, err: () => stderr };
}
const cli = (args, opts) => start(args, opts).done;

async function until(cond, what, ms = 10_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const readInfo = (home) => JSON.parse(fs.readFileSync(infoPath(home), "utf8"));
const deadPid = () => spawnSync("true").pid; // exited and reaped by the time this returns
const gone = (pid) => procStart(pid) === null;
function liveSleeper() {
  const p = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  p.unref(); // a failed assertion must not leave the test file waiting on it
  return { pid: p.pid, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
}
// A holder outside every job here: flock(1) itself, holding the file for `secs`.
async function bareHolder(home, secs = 30) {
  fs.mkdirSync(locksDir(home), { recursive: true });
  const p = spawn("/usr/bin/flock", [lockPath(home), "sleep", String(secs)], { detached: true, stdio: "ignore" });
  p.unref();
  await until(() => lockState(home) === "held", "the bare holder");
  return { pid: p.pid, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
}
// A command that logs "start <name> <ms>" and, after `ms`, "end <name> <ms>".
const loggedJob = (log, name, ms) => [NODE, "-e",
  `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${name} "+Date.now()+"\\n");` +
  `setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"end ${name} "+Date.now()+"\\n"),${ms})`];
function intervals(log) {
  const t = {};
  for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
    const [what, name, at] = line.split(" ");
    (t[name] ??= {})[what] = Number(at);
  }
  return Object.entries(t).map(([name, { start: s, end: e }]) => ({ name, s, e })).sort((a, b) => a.s - b.s);
}
function assertNoOverlap(spans) {
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i - 1].e <= spans[i].s,
      `${spans[i].name} started at ${spans[i].s}, before ${spans[i - 1].name} ended at ${spans[i - 1].e}`);
  }
}

ttest("the process under test is Node 20", () => {
  assert.match(process.version, /^v20\./, `run this under Node 20 by its path, not ${process.version}`);
});

// ─── A1: one account per host; the password database, never $HOME ────────

ttest("A1: the host table — ubuntu-pc runs heavy jobs as user, the OptiPlex (bitcorn-harness) as harnessagent", () => {
  assert.deepEqual([...HEAVY_ACCOUNTS], [["ubuntu-pc", "user"], ["bitcorn-harness", "harnessagent"]]);
  assert.equal(heavyAccountRefusal("ubuntu-pc", "user"), null);
  assert.equal(heavyAccountRefusal("bitcorn-harness", "harnessagent"), null);
  for (const account of ["arcagent", "vaultagent", "codeagent"]) {
    assert.match(heavyAccountRefusal("ubuntu-pc", account), new RegExp(`run as user, and this is ${account}`));
  }
  assert.match(heavyAccountRefusal("bitcorn-harness", "user"), /run as harnessagent, and this is user/);
  assert.match(heavyAccountRefusal("some-laptop", "user"), /host "some-laptop" has no heavy-job account/);
});

ttest("A1: another account is refused, and its command never runs", async () => {
  const home = scratch();
  const marker = path.join(home, "ran");
  for (const account of ["arcagent", "vaultagent"]) {
    const r = await cli(["heavy", "run", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
      { home, env: { HARNESS_HEAVY_TEST_ACCOUNT: account } });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`heavy refused: heavy jobs on ${HOST} run as ${HEAVY_ACCOUNTS.get(HOST)}, and this is ${account}`));
    assert.ok(!fs.existsSync(marker), "the refused command must not run");
    assert.ok(!fs.existsSync(lockPath(home)), "a refused account opens no lock");
  }
});

ttest("A1: the test account setting is ignored without the test home, so it cannot move a real run's lock", () => {
  const ctx = heavyContext({ HARNESS_HEAVY_TEST_ACCOUNT: "arcagent" });
  assert.equal(ctx.account, os.userInfo().username);
  assert.equal(ctx.home, os.userInfo().homedir);
  assert.deepEqual(ctx.notes, []);
});

ttest("A1: a scratch $HOME does not move the lock (read-only: heavy status takes nothing)", async () => {
  const fakeHome = scratch();
  // The account's home from the password database, by a route independent of Node.
  const account = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  const passwdHome = spawnSync("getent", ["passwd", account], { encoding: "utf8" }).stdout.trim().split(":")[5];
  assert.ok(passwdHome && passwdHome.startsWith("/"), `getent gave no home for ${account}`);
  assert.notEqual(passwdHome, fakeHome);
  const r = await cli(["heavy", "status"], { home: undefined, slotHome: fakeHome, env: { HARNESS_HEAVY_TEST_HOME: "" } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`heavy lock ${path.join(passwdHome, ".bitcorn-dev", "locks", "heavy.lock")}: `), r.stdout);
  assert.ok(!r.stdout.includes(fakeHome), r.stdout);
});

// ─── H1, A2: two heavy jobs never overlap; the second waits, then runs ────

ttest("two heavy jobs started together never overlap: the second waits, then runs", async () => {
  const home = scratch();
  const log = path.join(home, "jobs.log");
  const [a, b] = await Promise.all([
    cli(["heavy", "run", "--", ...loggedJob(log, "a", 1500)], { home }),
    cli(["heavy", "run", "--", ...loggedJob(log, "b", 1500)], { home }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const spans = intervals(log);
  console.log(spans.map((x) => `${x.name}: ${x.s}–${x.e}`).join("; "));
  assertNoOverlap(spans);
  const waiter = spans[0].name === "a" ? b : a;
  // The holder is JSON-quoted and may itself hold escaped quotes, so match loosely.
  assert.match(waiter.stderr, /heavy lock held by ".*" since \S+ on \S+, pid \d+ running; waiting/);
  const kinds = history(home).trim().split("\n").map((l) => l.split(" ")[1]);
  assert.deepEqual(kinds, ["acquire", "release", "acquire", "release"]);
  assert.equal(lockState(home), "free");
  assert.ok(!fs.existsSync(infoPath(home)), "the info file goes with the last holder");
  assert.ok(fs.existsSync(lockPath(home)), "heavy.lock itself is never removed");
});

// The review's three-way take-over race (race3.mjs) needed a dead holder that
// several waiters take over at once. With the kernel's lock a dead holder
// holds nothing, so this replays its ordering for real: a holder SIGKILLed with
// its command, then three acquirers started together.
ttest("after a SIGKILLed holder, three heavy jobs started together still run one at a time", async () => {
  const home = scratch();
  const dead = start(["heavy", "run", "--", "sleep", "30"], { home });
  await until(() => dead.err().includes("acquired the heavy lock"), "the first holder");
  const { pgid } = readInfo(home);
  dead.child.kill("SIGKILL");
  process.kill(-pgid, "SIGKILL");
  await dead.done;
  const log = path.join(home, "jobs.log");
  const rs = await Promise.all(["x", "y", "z"].map((n) => cli(["heavy", "run", "--", ...loggedJob(log, n, 700)], { home })));
  for (const r of rs) assert.equal(r.code, 0, r.stderr);
  const spans = intervals(log);
  assert.equal(spans.length, 3);
  assertNoOverlap(spans);
  assert.doesNotMatch(history(home), /take-over/);
  assert.equal(lockState(home), "free");
});

// ─── A2: released on success, failure and signals ──────────────────────────

ttest("released on success and on failure; the command's exit code is the wrapper's", async () => {
  const home = scratch();
  for (const code of [0, 7]) {
    const r = await cli(["heavy", "run", "--", NODE, "-e", `process.exit(${code})`], { home });
    assert.equal(r.code, code, r.stderr);
    assert.match(r.stderr, /harness lock released: heavy, holder [^,]+, held .* on \S+$/m);
    assert.doesNotMatch(r.stderr, /; go /, "heavy has no go");
    assert.equal(lockState(home), "free");
  }
  assert.match(history(home), new RegExp(`acquire lock="heavy" holder="${os.userInfo().username}@${HOST}:${NODE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} -e`));
});

ttest("the command holds the lock as its fd 9, and nothing else is passed to it", async () => {
  const home = scratch();
  const r = await cli(["heavy", "run", "--", "sh", "-c", "ls /proc/$$/fd | sort -n | tr '\\n' ' '; echo; readlink /proc/$$/fd/9"], { home });
  assert.equal(r.code, 0, r.stderr);
  const [fds, nine] = r.stdout.trim().split("\n");
  assert.deepEqual(fds.trim().split(" ").map(Number).filter((n) => n !== 3).sort((x, y) => x - y), [0, 1, 2, 9],
    `fds ${fds} (3 is ls's own directory handle)`);
  assert.equal(nine, lockPath(home));
});

ttest("SIGTERM to the wrapper reaches the command, and the lock is released", async () => {
  const home = scratch();
  const run = start(["heavy", "run", "--", "sleep", "30"], { home });
  await until(() => run.err().includes("acquired the heavy lock"), "the lock");
  run.child.kill("SIGTERM");
  const r = await run.done;
  assert.equal(r.signal, "SIGTERM", r.stderr);
  assert.match(r.stderr, /harness lock released: heavy/);
  assert.equal(lockState(home), "free");
});

ttest("SIGKILL of the wrapper AND its command frees the lock at once: the next run does not wait", async () => {
  const home = scratch();
  const run = start(["heavy", "run", "--", "sleep", "30"], { home });
  await until(() => run.err().includes("acquired the heavy lock"), "the lock");
  const info = readInfo(home);
  assert.equal(info.pid, run.child.pid);
  run.child.kill("SIGKILL");
  process.kill(-info.pgid, "SIGKILL"); // the OOM killer's view: everything gone, no finally run
  await run.done;
  await until(() => gone(info.command_pid), "the command to be gone");
  assert.equal(lockState(home), "free", "the kernel frees a dead job's lock");
  const next = await cli(["heavy", "run", "--wait", "0", "--", "true"], { home });
  assert.equal(next.code, 0, next.stderr);
});

ttest("SIGKILL of the wrapper ALONE: its command still runs and keeps the lock until it exits, then the lock frees", async () => {
  const home = scratch();
  const run = start(["heavy", "run", "--", "sleep", "4"], { home });
  await until(() => run.err().includes("acquired the heavy lock"), "the lock");
  const info = readInfo(home);
  run.child.kill("SIGKILL");
  await run.done;
  assert.ok(!gone(info.command_pid), "the command outlives its wrapper");
  assert.equal(lockState(home), "held");
  const blocked = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
  assert.equal(blocked.code, 2, blocked.stderr);
  assert.match(blocked.stderr, new RegExp(`heavy is already locked by .*pid ${info.pid} gone but its command \\(pid ${info.command_pid}\\) still running`));
  assert.match(blocked.stderr, /the command was not run/);
  // A waiter with no limit starts as soon as the command has exited.
  const next = await cli(["heavy", "run", "--", "true"], { home });
  assert.equal(next.code, 0, next.stderr);
  assert.ok(gone(info.command_pid));
});

// ─── A2: who holds it is the kernel's to say ───────────────────────────────

ttest("a holder outside this job (a bare flock(1)) is waited on and reported, never taken", async () => {
  const home = scratch();
  const bare = await bareHolder(home);
  try {
    const marker = path.join(home, "ran");
    const r = await cli(["heavy", "run", "--wait", "1", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { home });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy is already locked by "\(unrecorded\)" \(a holder that names none \(no heavy.info.json: just starting, outside these tools, or an inheritor\)\); waited 1s/);
    assert.ok(!fs.existsSync(marker), "the command must not run");
    assert.equal(lockState(home), "held");
  } finally {
    bare.kill();
  }
});

// The holder records itself just after it locks. A waiter whose first look lands in
// that instant must name the holder, not report one that names none (seen for real
// in done-when 1, 2026-11-18: two jobs started together).
ttest("a waiter whose first look lands before the holder has recorded itself still names the holder", async () => {
  const home = scratch();
  const bare = await bareHolder(home);
  try {
    const waiter = start(["heavy", "run", "--wait", "2", "--", "true"], { home });
    await sleep(150);
    fs.writeFileSync(infoPath(home), JSON.stringify({ holder: "late-writer", acquired_at: "2026-11-18T12:00:00Z", host: HOST, slot: "heavy", kind: "run", pid: bare.pid }));
    const r = await waiter.done;
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy lock held by "late-writer" since \S+ on \S+, pid \d+ running; waiting/);
    assert.doesNotMatch(r.stderr, /names none/);
  } finally {
    bare.kill();
  }
});

ttest("heavy.info.json is display only: without the lock it blocks nothing, and with the lock its absence frees nothing", async () => {
  const home = scratch();
  fs.mkdirSync(locksDir(home), { recursive: true });
  // A stale or fabricated record, a live pid in it, no lock held.
  const p = liveSleeper();
  try {
    fs.writeFileSync(infoPath(home), JSON.stringify({ holder: "ghost", acquired_at: "2026-11-18T12:00:00Z", host: HOST, slot: "heavy", kind: "run", pid: p.pid }));
    const free = await cli(["heavy", "run", "--wait", "0", "--", "true"], { home });
    assert.equal(free.code, 0, free.stderr);
    // An unreadable record beside a held lock: still held.
    fs.writeFileSync(infoPath(home), "{half");
    const bare = await bareHolder(home);
    try {
      const r = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /is already locked by .*unreadable/);
    } finally {
      bare.kill();
    }
  } finally {
    p.kill();
  }
});

ttest("heavy status says free or held as the kernel does, and names the holder", async () => {
  const home = scratch();
  const status = async () => (await cli(["heavy", "status"], { home })).stdout.trim().replace(/^heavy lock \S+: /, "");
  assert.equal(await status(), "free");
  const run = start(["heavy", "run", "--holder", "shown", "--", "sleep", "30"], { home });
  try {
    await until(() => run.err().includes("acquired the heavy lock"), "the lock");
    assert.match(await status(), /^held by "shown" since \S+ on \S+, pid \d+ running$/);
  } finally {
    run.child.kill("SIGTERM");
    await run.done;
  }
  assert.equal(await status(), "free");
});

// ─── A3: a heavy holder never waits for a slot ────────────────────────────

ttest("A3: under the heavy lock, a busy slot is refused at once in words browser-slot.py does not wait on, and heavy is released", async () => {
  const home = scratch();
  const slotHome = scratch();
  const take = (holder, extra = {}) => cli(["lock", "acquire", "--slot", "1", "--holder", holder, "--go", "test"], { home, slotHome, ...extra });
  assert.equal((await take("other-arc")).code, 0);

  // The control: outside the heavy lock the refusal IS the one browser-slot.py waits on.
  const plain = await take("me");
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, WORKFLOW_WAIT);

  const r = await cli(["heavy", "run", "--", NODE, SCRIPT, "lock", "acquire", "--slot", "1", "--holder", "me", "--go", "test"], { home, slotHome });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /slot 1 refused: this job holds the heavy lock, and a heavy-lock holder never waits for a slot; slot 1 is held by "other-arc" since \S+/);
  const refusal = r.stderr.split("\n").find((l) => l.includes("slot 1 refused"));
  assert.doesNotMatch(refusal, WORKFLOW_WAIT);
  assert.match(r.stderr, /harness lock released: heavy/);
  assert.equal(lockState(home), "free", "heavy is released when its slot part fails");

  // The same under a Polar setup window.
  assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "other-arc"], { home, slotHome })).code, 0);
  assert.equal((await cli(["lock", "acquire", "--setup", "--holder", "polar", "--go", "test"], { home, slotHome })).code, 0);
  const s = await cli(["heavy", "run", "--", NODE, SCRIPT, "lock", "acquire", "--slot", "1", "--holder", "me", "--go", "test"], { home, slotHome });
  assert.equal(s.code, 2, s.stderr);
  const setupRefusal = s.stderr.split("\n").find((l) => l.includes("slot 1 refused"));
  assert.match(setupRefusal, /never waits for a slot; a Polar setup window holds setup\.lock \(holder "polar"\)/);
  assert.doesNotMatch(setupRefusal, WORKFLOW_WAIT);
});

ttest("A3: a Node grandchild of the command, which holds no descriptor, still counts as this job (an ancestor holds it)", async () => {
  const home = scratch();
  const slotHome = scratch();
  assert.equal((await cli(["lock", "acquire", "--slot", "1", "--holder", "other-arc", "--go", "test"], { home, slotHome })).code, 0);
  // node → node: the inner node gets no fd 9 (Node marks inherited fds close-on-exec).
  const inner = `const r=require("child_process").spawnSync(${JSON.stringify(NODE)},[${JSON.stringify(SCRIPT)},"lock","acquire","--slot","1","--holder","me","--go","test"],{encoding:"utf8"});` +
    "process.stderr.write(r.stderr);process.exit(r.status)";
  const r = await cli(["heavy", "run", "--", NODE, "-e", inner], { home, slotHome });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /slot 1 refused: this job holds the heavy lock/);
});

ttest("A3: under the heavy lock, a free slot is taken as usual", async () => {
  const home = scratch();
  const slotHome = scratch();
  const r = await cli(["heavy", "run", "--", NODE, SCRIPT, "lock", "acquire", "--slot", "1", "--holder", "me", "--go", "test"], { home, slotHome });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /acquired slot 1 for me/);
});

ttest("A3: after heavy acquire without --pid, the process that ran it never waits for a slot either", async () => {
  const home = scratch();
  const slotHome = scratch();
  assert.equal((await cli(["lock", "acquire", "--slot", "1", "--holder", "other-arc", "--go", "test"], { home, slotHome })).code, 0);
  // One shell: acquire, ask for the busy slot, release. Its children descend from it, the acquire's owner.
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const script = [
    `${q(NODE)} ${q(SCRIPT)} heavy acquire --holder shell-arc`,
    `${q(NODE)} ${q(SCRIPT)} lock acquire --slot 1 --holder shell-arc --go test; echo "slot-exit=$?" >&2`,
    `${q(NODE)} ${q(SCRIPT)} heavy release --holder shell-arc`,
  ].join("\n");
  const sh = spawnSync("sh", ["-c", script], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: slotHome, HARNESS_HEAVY_TEST_HOME: home },
  });
  assert.match(sh.stdout, /acquired heavy for shell-arc: .*\(held by pid \d+ for pid \d+; freed by heavy release/, sh.stderr);
  const refusal = sh.stderr.split("\n").find((l) => l.includes("slot 1"));
  assert.match(refusal, /slot 1 refused: this job holds the heavy lock, and a heavy-lock holder never waits for a slot/);
  assert.doesNotMatch(refusal, WORKFLOW_WAIT);
  assert.match(sh.stderr, /slot-exit=2/);
  assert.match(sh.stdout, /harness lock released: heavy, holder shell-arc/);
  assert.equal(lockState(home), "free");
});

ttest("a slot holder may wait for heavy: holding a slot does not stop a heavy acquire", async () => {
  const home = scratch();
  const slotHome = scratch();
  assert.equal((await cli(["lock", "acquire", "--slot", "1", "--holder", "arc", "--go", "test"], { home, slotHome })).code, 0);
  const r = await cli(["heavy", "run", "--", "true"], { home, slotHome });
  assert.equal(r.code, 0, r.stderr);
});

// ─── nesting, and the commands for callers that cannot wrap ───────────────

ttest("a heavy run inside a heavy run does not wait on itself", async () => {
  const home = scratch();
  const t0 = Date.now();
  const r = await cli(["heavy", "run", "--", NODE, SCRIPT, "heavy", "run", "--wait", "3", "--", "true"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /already held by this job/);
  assert.ok(Date.now() - t0 < 3000, "it must not have waited");
});

ttest("heavy acquire / release: a holder process keeps the lock, so there is no pid-less acquire; release refuses another's", async () => {
  const home = scratch();
  // Acquired from a short-lived sh (which forks the CLI rather than exec-ing it), so the
  // owner is that sh, not this test process: the blocked run below is another job's, not
  // a nested one. (From the owner itself, a heavy run is "already held by this job".)
  const a = await cli(["heavy", "acquire", "--holder", "polar-gate"], { home, viaSh: true });
  assert.equal(a.code, 0, a.stderr);
  const info = readInfo(home);
  assert.equal(info.kind, "acquire");
  assert.ok(Number.isInteger(info.owner_pid) && info.owner_pid !== process.pid, "owned by the sh, not this test");
  assert.ok(Number.isInteger(info.pid) && !gone(info.pid), "the holder process runs");
  assert.ok(fs.readdirSync(`/proc/${info.pid}/fd`).some((n) => {
    try { return fs.readlinkSync(`/proc/${info.pid}/fd/${n}`) === lockPath(home); } catch { return false; }
  }), "and has the lock's file open");
  assert.match(a.stdout, new RegExp(`held by pid ${info.pid} for pid \\d+; freed by heavy release, or --force --reason`));
  assert.equal(lockState(home), "held");
  const blocked = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, new RegExp(`"polar-gate" since \\S+ on \\S+, pid ${info.pid} running`));
  const wrong = await cli(["heavy", "release", "--holder", "someone-else"], { home });
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /heavy is held by "polar-gate", not "someone-else"/);
  assert.equal(lockState(home), "held", "a refused release stops nothing");
  const rel = await cli(["heavy", "release", "--holder", "polar-gate"], { home });
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /^harness lock released: heavy, holder polar-gate, held .* on \S+$/m);
  assert.ok(gone(info.pid), "release stops the holder process");
  assert.equal(lockState(home), "free");
  assert.equal((await cli(["heavy", "release", "--holder", "polar-gate"], { home })).code, 2, "nothing left to release");

  const dead = await cli(["heavy", "acquire", "--holder", "x", "--pid", String(deadPid())], { home });
  assert.equal(dead.code, 2);
  assert.match(dead.stderr, /no such running process/);
});

ttest("heavy release --force stops an acquire's holder process, and refuses a running heavy job", async () => {
  const home = scratch();
  assert.equal((await cli(["heavy", "acquire", "--holder", "stuck"], { home })).code, 0);
  const { pid } = readInfo(home);
  const forced = await cli(["heavy", "release", "--force", "--reason", "test"], { home });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /harness lock FORCE-released: heavy, was held by stuck since \S+; reason "test"/);
  assert.match(history(home), /force-release lock="heavy" holder="stuck" acquired_at="\S+" reason="test"/);
  assert.ok(gone(pid));
  assert.equal(lockState(home), "free");

  const run = start(["heavy", "run", "--holder", "busy", "--", "sleep", "30"], { home });
  try {
    await until(() => run.err().includes("acquired the heavy lock"), "the lock");
    const refused = await cli(["heavy", "release", "--force", "--reason", "test"], { home });
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /not by a heavy acquire holder process: the kernel frees it when that job ends/);
    assert.equal(lockState(home), "held");
    assert.equal((await cli(["heavy", "release", "--holder", "busy"], { home })).code, 2, "nor by name");
  } finally {
    run.child.kill("SIGTERM");
    await run.done;
  }
});

ttest("heavy acquire --pid: the named process is the holder's owner, and its death frees the lock to the next acquirer", async () => {
  const home = scratch();
  const p = liveSleeper();
  let holderPid;
  try {
    const a = await cli(["heavy", "acquire", "--holder", "session", "--pid", String(p.pid)], { home });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, new RegExp(`for pid ${p.pid}, freed when it exits\\)`));
    holderPid = readInfo(home).pid;
    assert.equal((await cli(["heavy", "run", "--wait", "1", "--", "true"], { home })).code, 2);
  } finally {
    p.kill();
  }
  const r = await cli(["heavy", "run", "--wait", "10", "--", "true"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(gone(holderPid), "the holder let go and ended");
  assert.match(history(home), /release lock="heavy" holder="session" acquired_at="\S+" held="\S+"/);
});

ttest("heavy acquire stopped while it waits: its holder process gives up, and never takes the lock for nobody", async () => {
  const home = scratch();
  const bare = await bareHolder(home);
  const acq = start(["heavy", "acquire", "--holder", "late"], { home });
  await until(() => acq.err().includes("waiting"), "the acquire to wait");
  acq.child.kill("SIGKILL"); // no handler runs: the holder sees its IPC channel close
  await acq.done;
  bare.kill();
  await until(() => lockState(home) === "free", "the bare holder to go");
  await sleep(1500);
  assert.equal(lockState(home), "free", "the abandoned holder must not have taken it");
  assert.ok(!fs.existsSync(infoPath(home)));
});

// ─── exit codes (review findings #3, #4) ───────────────────────────────────

ttest("a command that cannot start exits 127, runs nothing, and the lock is free after", async () => {
  const home = scratch();
  const r = await cli(["heavy", "run", "--", "/nonexistent/command"], { home });
  assert.equal(r.code, 127, r.stderr);
  assert.match(r.stderr, /could not start "\/nonexistent\/command": .*ENOENT.*; the command was not run/);
  assert.equal(lockState(home), "free");
  assert.doesNotMatch(history(home), /acquire/, "nothing ran, so nothing was recorded");
});

ttest("a command killed by a signal Node ignores or handles still gives 128 + its number", async () => {
  const home = scratch();
  for (const [sig, code] of [["PIPE", 141], ["USR1", 138], ["TERM", 143]]) {
    const r = await cli(["heavy", "run", "--", "sh", "-c", `kill -${sig} $$`], { home });
    const got = r.code ?? 128 + os.constants.signals[r.signal];
    assert.equal(got, code, `SIG${sig}: ${r.stderr}`);
    assert.equal(lockState(home), "free");
  }
});
