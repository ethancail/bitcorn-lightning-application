#!/usr/bin/env node
// harness-slot-heavy.test.mjs — node:test suite for the heavy lock in
// scripts/harness-slot.mjs (decision H1–H7, 2026-11-18, as amended by A1–A4;
// rebuilt on kernel flock, 2026-11-19; N slots, 2026-11-20). The tests written
// for the single lock run at HARNESS_HEAVY_LIMIT=1 (start()'s default); the
// "N slots" section runs at 2, with a fake meminfo where memory matters.
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
// The reused-pid property survives in two guards, both tested below (the
// second review's F4): heavy release signals only a holder process that has the
// lock's file open, and a job token counts only while its record's process has
// it open. Ancestry no longer decides who is in the job (F2): the token does.
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

import {
  HEAVY_HOSTS, HOLD_ORPHAN_GRACE_MS, KILL_WAIT_MS, acquireLock, diskFree, forceReleaseLock, heavyAccountRefusal, heavyContext, heavyLocked, heavySettings, heldByThisJob,
  lockHeavy, lockHolders, procStart, procStat, releaseLock, stopAndConfirm, stopHolder,
} from "./harness-slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "harness-slot.mjs");
const NODE = process.execPath;
const HOST = os.hostname();
// bitcorn-workflow tests/browser-slot.py:113 keeps waiting only while the
// refusal matches this; anything else fails it at once.
const WORKFLOW_WAIT = /is already locked by |refused: setup\.lock is held by /;

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "heavy-test-"));
const locksDir = (home) => path.join(home, ".bitcorn-dev", "locks");
// Slot 0 keeps the single lock's names (heavy.lock, heavy.info.json); slot k >= 1 is heavy-k.
const slotName = (k) => (k === 0 ? "heavy" : `heavy-${k}`);
const lockPath = (home, k = 0) => path.join(locksDir(home), `${slotName(k)}.lock`);
const infoPath = (home, k = 0) => path.join(locksDir(home), `${slotName(k)}.info.json`);
const historyPath = (home) => path.join(locksDir(home), "history.log");
const history = (home) => (fs.existsSync(historyPath(home)) ? fs.readFileSync(historyPath(home), "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every test is bounded, so a broken lock fails a test instead of hanging the file.
const ttest = (name, fn) => test(name, { timeout: 60_000 }, fn);

// The kernel's answer, not the code under test's: "free", "held", or a throw.
// (-n takes the lock for an instant when free; nothing here waits on it then.)
function lockState(home, k = 0) {
  if (!fs.existsSync(lockPath(home, k))) return "free";
  const r = spawnSync("/usr/bin/flock", ["-n", "-E", "200", lockPath(home, k), "true"]);
  if (r.status === 0) return "free";
  if (r.status === 200) return "held";
  throw new Error(`flock(1) could not answer: status ${r.status}, ${r.error?.message ?? ""}`);
}

// A fake /proc/meminfo with `mb` MB available (rewritten in place to change it).
function meminfo(mb, file = path.join(scratch(), "meminfo")) {
  fs.writeFileSync(file, `MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:   ${mb * 1024} kB\n`);
  return file;
}
const PLENTY = meminfo(64_000);
// A fake free-disk figure (HARNESS_HEAVY_TEST_DISKFREE), `mb` MB for every filesystem
// (rewritten in place to change it).
function diskfree(mb, file = path.join(scratch(), "diskfree")) {
  fs.writeFileSync(file, `${mb}\n`);
  return file;
}
const PLENTY_DISK = diskfree(1_000_000);
// The in-process seam: fs.statfsSync's shape, `mb()` MB free on every filesystem.
const statfsOf = (mb) => () => ({ bsize: 1024 * 1024, bavail: typeof mb === "function" ? mb() : mb });

// The CLI under Node 20, its environment built from scratch: no inherited $HOME.
// Unless a test says otherwise: one slot (the single-lock behaviour these tests
// were written for, which the OptiPlex keeps) and plenty of memory and disk, so
// no test depends on this machine's MemAvailable or free space.
function start(args, { home, env = {}, slotHome } = {}) {
  const child = spawn(NODE, [SCRIPT, ...args], {
    env: {
      PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: slotHome ?? scratch(), HARNESS_HEAVY_TEST_HOME: home,
      HARNESS_HEAVY_LIMIT: "1", HARNESS_HEAVY_TEST_MEMINFO: PLENTY, HARNESS_HEAVY_TEST_DISKFREE: PLENTY_DISK, ...env,
    },
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

const readInfo = (home, k = 0) => JSON.parse(fs.readFileSync(infoPath(home, k), "utf8"));
const deadPid = () => spawnSync("true").pid; // exited and reaped by the time this returns
const gone = (pid) => procStart(pid) === null;
function liveSleeper() {
  const p = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  p.unref(); // a failed assertion must not leave the test file waiting on it
  return { pid: p.pid, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
}
// A holder outside every job here: flock(1) itself, holding the file for `secs`.
async function bareHolder(home, secs = 30, k = 0) {
  fs.mkdirSync(locksDir(home), { recursive: true });
  const p = spawn("/usr/bin/flock", [lockPath(home, k), "sleep", String(secs)], { detached: true, stdio: "ignore" });
  p.unref();
  await until(() => lockState(home, k) === "held", "the bare holder");
  return { pid: p.pid, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
}
// F7: stops every holder process (`heavy __hold`) that has one of this home's
// slot files open, recorded or not, so a failed assertion cannot leave one
// running. A holder without --pid never exits by itself.
function stopHolders(home) {
  for (const pid of fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n))) {
    let cmdline;
    let fds;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    if (!cmdline.includes("\0__hold\0")) continue;
    const open = fds.some((n) => {
      try { return /^heavy(-[0-9]+)?\.lock$/.test(path.relative(locksDir(home), fs.readlinkSync(`/proc/${pid}/fd/${n}`))); } catch { return false; }
    });
    if (open) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  }
}
// The token line heavy acquire prints, unquoted (these tests use plain holder names).
const tokenOf = (stdout) => stdout.match(/^HARNESS_HEAVY_JOB=(.*)$/m)?.[1];
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

ttest("A1: the host table — ubuntu-pc runs two heavy jobs as user, the OptiPlex (bitcorn-harness) one as harnessagent", () => {
  assert.deepEqual([...HEAVY_HOSTS], [["ubuntu-pc", { account: "user", limit: 2 }], ["bitcorn-harness", { account: "harnessagent", limit: 1 }]]);
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
    assert.match(r.stderr, new RegExp(`heavy refused: heavy jobs on ${HOST} run as ${HEAVY_HOSTS.get(HOST).account}, and this is ${account}`));
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
  assert.ok(r.stdout.startsWith(`heavy ${path.join(passwdHome, ".bitcorn-dev", "locks", "heavy.lock")}: `), r.stdout);
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
  assert.match(waiter.stderr, /heavy lock held by ".*" since \S+ on \S+, pid \d+ running \(heavy\); waiting/);
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

// The listing is of the command's own shell, sampled 20 times, 50 ms apart, with
// no pipeline and no command substitution: a shell running either holds a pipe's
// ends while it forks, and a listing taken then showed them (fds 4, 5). A
// descriptor passed to the command would be in every sample; so must fd 9 be.
ttest("the command holds the lock as its fd 9, and nothing else is passed to it", async () => {
  const home = scratch();
  const r = await cli(["heavy", "run", "--", "sh", "-c",
    "i=0; while [ $i -lt 20 ]; do ls /proc/$$/fd; echo --; i=$((i+1)); sleep 0.05; done; readlink /proc/$$/fd/9"], { home });
  assert.equal(r.code, 0, r.stderr);
  const parts = r.stdout.trim().split("--\n");
  const nine = parts.pop().trim();
  const samples = parts.map((p) => p.trim().split("\n").map(Number));
  const lines = samples.map((s) => s.join(" "));
  assert.equal(samples.length, 20);
  for (const s of samples) assert.ok(s.includes(9), `fd 9 in every sample: ${s}`);
  const everywhere = [...new Set(samples.flat())].filter((n) => samples.every((s) => s.includes(n))).sort((x, y) => x - y);
  assert.deepEqual(everywhere, [0, 1, 2, 9], `the descriptors in every sample (passed to the command): ${everywhere}`);
  assert.ok(samples.some((s) => [...s].sort((x, y) => x - y).join() === "0,1,2,9"), `some sample is exactly 0 1 2 9: ${lines.join(" | ")}`);
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

// ─── F1: nothing the command leaves behind keeps the lock unseen ──────────

ttest("F1: what the command leaves running in its group is ended, and only then is the lock released", async () => {
  const home = scratch();
  // The control (e1abb82): the background sleep kept the lock after "released".
  const r = await cli(["heavy", "run", "--", "sh", "-c", "sleep 30 & exit 0"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /harness lock released: heavy/);
  assert.equal(lockState(home), "free", "the background child must not hold the lock past the release");
  const pgid = Number(history(home).match(/acquire lock="heavy" .* pgid=(\d+)/)?.[1]);
  assert.ok(pgid > 0, history(home));
  assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" }, "the command's process group is empty");
});

ttest("F1: a process that left the group with fd 9 is named: NOT released, no release logged, exit 2", async () => {
  const home = scratch();
  let escapee = null;
  try {
    // setsid: its own session, out of the group the wrapper ends; it keeps fd 9.
    const r = await cli(["heavy", "run", "--holder", "leaky", "--", "sh", "-c", "setsid sleep 30 & sleep 0.3; exit 0"], { home });
    escapee = Number(r.stderr.match(/heavy NOT released: pid (\d+) \(sleep\) still holds its descriptor; it frees when it exits/)?.[1]);
    assert.ok(escapee > 0, r.stderr);
    assert.equal(r.code, 2, "a succeeding command whose lock is not released exits 2");
    assert.doesNotMatch(r.stderr, /harness lock released/);
    assert.doesNotMatch(history(home), /release lock="heavy"/, "no release line while it is held");
    assert.equal(lockState(home), "held");
    assert.equal(readInfo(home).holder, "leaky", "the record stays, naming the job");
    process.kill(escapee, "SIGKILL");
    await until(() => gone(escapee), "the escapee to go");
    assert.equal(lockState(home), "free", "it frees when that process exits");
  } finally {
    if (escapee > 0) try { process.kill(escapee, "SIGKILL"); } catch {}
  }
});

// ─── A2: who holds it is the kernel's to say ───────────────────────────────

ttest("a holder outside this job (a bare flock(1)) is waited on and reported, never taken", async () => {
  const home = scratch();
  const bare = await bareHolder(home);
  try {
    const marker = path.join(home, "ran");
    const r = await cli(["heavy", "run", "--wait", "1", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { home });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy is already locked by a holder that names none \(no heavy info file: just starting, outside these tools, or an inheritor\) \(heavy\); waited 1s/);
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
    assert.match(r.stderr, /heavy lock held by "late-writer" since \S+ on \S+, pid \d+ running \(heavy\); waiting/);
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
  const status = async () => (await cli(["heavy", "status"], { home })).stdout.trim().replace(/^heavy \S+: /, "");
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

// ─── the lock order: heavy first, then the slot (2026-11-20; reverses A3) ──
//
// lock acquire --slot N with no token of its own takes ONE heavy slot (every
// slot with --exclusive; Ethan, 2026-11-20), by a holder process of kind
// "slot", then the slot; lock release releases the slot, then that heavy. A
// heavy holder (by token) just takes the slot, and may wait for it. Most tests
// here run at start()'s limit of 1, where one heavy slot is all of heavy; the
// "limit 2" tests show the slot's heavy sharing the machine. Here the slot locks live in slotHome (the CLI's HOME) and heavy in
// home (HARNESS_HEAVY_TEST_HOME), unless a test passes one home for both. A
// plain slot holder (no heavy) is made with acquireLock directly: a holder from
// before the order, or one that took its slot under a token.

const takeSlot = (holder, extra = []) => ["lock", "acquire", "--slot", "1", "--holder", holder, "--go", "test", ...extra];
const slotLockPath = (slotHome, slot = 1) => path.join(locksDir(slotHome), `slot-${slot}.lock`);
const plainSlot = (slotHome, holder, slot = 1) => acquireLock({ home: slotHome, target: slot, holder, go: "test" });
// history.log's lines as "<verb> <lock>", in order (heavy's and the slot's share it when both homes are one).
const events = (home) => history(home).trim().split("\n").filter(Boolean)
  .map((l) => l.match(/ (acquire|release|force-release) lock="([^"]+)"/)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`);

ttest("order: a slot acquire with no token holds heavy before the slot, and its release releases both, the slot first", async () => {
  const home = scratch();
  try {
    // One home for both, so history.log orders heavy's lines and the slot's together.
    const a = await cli(takeSlot("arc"), { home, slotHome: home });
    assert.equal(a.code, 0, a.stderr);
    assert.deepEqual(events(home), ["acquire heavy", "acquire slot 1"], "heavy before the slot");
    assert.match(a.stdout, /^acquired slot 1 for arc: /m);
    assert.match(a.stdout, /with the heavy lock \(heavy\), taken first, held by pid \d+: released with the slot/);
    const info = readInfo(home);
    assert.equal(info.kind, "slot");
    assert.equal(info.for_slot, 1);
    assert.equal(info.exclusive, undefined, "one ordinary heavy slot, not exclusive");
    assert.equal(tokenOf(a.stdout), info.job, "it prints the holder's token, for the arc's own heavy jobs");
    assert.deepEqual(JSON.parse(fs.readFileSync(slotLockPath(home), "utf8")).heavy, { pid: info.pid, job: info.job },
      "the slot lock records the heavy it was taken with");
    assert.equal(lockState(home), "held");

    // That heavy goes with its slot, not on its own.
    const h = await cli(["heavy", "release", "--holder", "slot-1/arc"], { home, slotHome: home });
    assert.equal(h.code, 2);
    assert.match(h.stderr, /heavy is held for slot 1's lock; release that slot \(lock release --slot 1 --holder <arc>\)/);
    assert.equal(lockState(home), "held");

    const r = await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome: home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^harness lock released: slot 1, holder arc, held .*\nharness lock released: heavy, holder slot-1\/arc, held /);
    assert.equal(lockState(home), "free", "heavy is released with the slot");
    assert.ok(!fs.existsSync(slotLockPath(home)));
    await until(() => gone(info.pid), "the holder process to end");
    assert.deepEqual(events(home), ["acquire heavy", "acquire slot 1", "release slot 1", "release heavy"]);
  } finally {
    stopHolders(home);
  }
});

ttest("order: while one slot holder runs, a second slot acquire waits on heavy, not on the slot", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    assert.equal((await cli(takeSlot("first"), { home, slotHome })).code, 0);
    // The held slot itself is refused at once, before heavy (F6), in the slot's own words.
    const same = await cli(["lock", "acquire", "--slot", "1", "--holder", "second", "--go", "test", "--wait", "2"], { home, slotHome });
    assert.equal(same.code, 2, same.stderr);
    assert.match(same.stderr, /^harness-slot lock: slot 1 is already locked by "first"/m);
    assert.doesNotMatch(same.stderr, /heavy is already locked/);
    // Bounded: on a free slot it gives up on heavy, in words browser-slot.py waits on, and never reached the slot.
    for (const slot of ["2"]) {
      const t0 = Date.now();
      const b = await cli(["lock", "acquire", "--slot", slot, "--holder", "second", "--go", "test", "--wait", "2"], { home, slotHome });
      assert.equal(b.code, 2, b.stderr);
      assert.ok(Date.now() - t0 >= 1900, `slot ${slot}: it waited (${Date.now() - t0} ms)`);
      const refusal = b.stderr.split("\n").find((l) => l.includes("already locked")) ?? "";
      assert.match(refusal, /^harness-slot lock: heavy is already locked by "slot-1\/first" since /);
      assert.match(refusal.replace("harness-slot lock: ", ""), WORKFLOW_WAIT);
      assert.doesNotMatch(b.stderr, /slot \d is already locked/, `slot ${slot}: it never reached the slot`);
    }
    assert.ok(!fs.existsSync(slotLockPath(slotHome, 2)));
    // Unbounded: it waits, holding no slot, and gets heavy then its slot once the first lets go.
    const w = start(["lock", "acquire", "--slot", "2", "--holder", "second", "--go", "test"], { home, slotHome });
    await until(() => w.err().includes("waiting"), "the second to wait on heavy");
    await sleep(1500);
    assert.equal(w.child.exitCode, null, "still waiting");
    assert.ok(!fs.existsSync(slotLockPath(slotHome, 2)), "a waiter holds no slot while it waits on heavy");
    assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "first"], { home, slotHome })).code, 0);
    const done = await w.done;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /^acquired slot 2 for second: /m);
    assert.equal(readInfo(home).holder, "slot-2/second");
    assert.equal((await cli(["lock", "release", "--slot", "2", "--holder", "second"], { home, slotHome })).code, 0);
    assert.equal(lockState(home), "free");
  } finally {
    stopHolders(home);
  }
});

const LIMIT2 = { HARNESS_HEAVY_LIMIT: "2" };

ttest("order, limit 2: a slot holder and one ordinary heavy job run together; a second ordinary job waits", async () => {
  const home = scratch();
  const slotHome = scratch();
  let job1;
  try {
    const a = await cli(takeSlot("arc"), { home, slotHome, env: LIMIT2 });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(lockState(home, 1), "free", "the slot took one heavy slot, not both");
    assert.match(a.stdout, /with the heavy lock \(heavy\), taken first/);
    assert.equal(readInfo(home, 0).kind, "slot");

    job1 = start(["heavy", "run", "--holder", "job1", "--", "sleep", "30"], { home, slotHome, env: LIMIT2 });
    await until(() => job1.err().includes("acquired the heavy lock"), "the ordinary job to run beside the slot holder");
    assert.match(job1.err(), /acquired the heavy lock \(heavy-1\) for "job1".*sharing the machine, so VITEST_MAX_WORKERS=3/);
    assert.equal(lockState(home, 1), "held");

    const t0 = Date.now();
    const job2 = await cli(["heavy", "run", "--holder", "job2", "--wait", "2", "--", "true"], { home, slotHome, env: LIMIT2 });
    assert.equal(job2.code, 2, job2.stderr);
    assert.ok(Date.now() - t0 >= 1900, "it waited");
    assert.match(job2.stderr, /heavy is already locked by "slot-1\/arc" .*\(heavy\) and "job1" .*\(heavy-1\)/);
    assert.doesNotMatch(history(home), /holder="job2"/);
  } finally {
    job1?.child.kill("SIGTERM");
    await job1?.done;
    await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome, env: LIMIT2 });
    stopHolders(home);
  }
  assert.equal(lockState(home, 0), "free");
  assert.equal(lockState(home, 1), "free");
});

ttest("order, limit 2: a slot acquire beside another job passes the memory check, and its wait keeps the words a waiter waits on", async () => {
  const home = scratch();
  const slotHome = scratch();
  const job1 = start(["heavy", "run", "--holder", "job1", "--", "sleep", "30"], { home, slotHome, env: LIMIT2 });
  try {
    await until(() => job1.err().includes("acquired the heavy lock"), "the first job");
    const low = await cli(takeSlot("arc", ["--wait", "2"]), { home, slotHome, env: { ...LIMIT2, HARNESS_HEAVY_TEST_MEMINFO: meminfo(100) } });
    assert.equal(low.code, 2, low.stderr);
    const refusal = low.stderr.split("\n").find((l) => l.includes("not admitted")) ?? "";
    assert.match(refusal, /heavy-1 is free, but MemAvailable is 100 MB, under the 4096 MB/);
    assert.match(refusal.replace("harness-slot lock: ", ""), WORKFLOW_WAIT, "browser-slot.py keeps waiting on a memory wait");
    assert.ok(!fs.existsSync(slotLockPath(slotHome)), "no slot while heavy was not admitted");

    const ok = await cli(takeSlot("arc"), { home, slotHome, env: LIMIT2 });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /with the heavy lock \(heavy-1\), taken first/);
    assert.match(ok.stdout, /^VITEST_MAX_WORKERS=3$/m, "it shares the machine, so its token's jobs get the cap");
    assert.equal(readInfo(home, 1).shared, true);
    assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome, env: LIMIT2 })).code, 0);
  } finally {
    job1.child.kill("SIGTERM");
    await job1.done;
    stopHolders(home);
  }
});

ttest("order, limit 2: lock acquire --slot N --exclusive takes every heavy slot; an ordinary job waits", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    const a = await cli(takeSlot("arc", ["--exclusive"]), { home, slotHome, env: LIMIT2 });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(lockState(home, 0), "held");
    assert.equal(lockState(home, 1), "held", "--exclusive took every heavy slot");
    assert.match(a.stdout, /with the heavy lock, exclusive \(heavy, heavy-1\), taken first/);
    assert.equal(readInfo(home, 1).exclusive, true);
    const job = await cli(["heavy", "run", "--wait", "2", "--", "true"], { home, slotHome, env: LIMIT2 });
    assert.equal(job.code, 2, job.stderr);
    assert.match(job.stderr, /heavy is already locked by "slot-1\/arc" \(exclusive\)/);
    const r = await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome, env: LIMIT2 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /released: heavy, holder slot-1\/arc.*\n.*released: heavy-1, holder slot-1\/arc/);
    assert.equal(lockState(home, 0), "free");
    assert.equal(lockState(home, 1), "free");
    // --exclusive is the slot acquire's alone.
    const setup = await cli(["lock", "acquire", "--setup", "--holder", "p", "--go", "test", "--exclusive"], { home, slotHome, env: LIMIT2 });
    assert.equal(setup.code, 2);
    assert.match(setup.stderr, /--wait, --pid and --exclusive belong to lock acquire --slot/);
  } finally {
    stopHolders(home);
  }
});

ttest("order: a heavy holder may wait for a busy slot, and takes it once it frees", async () => {
  const home = scratch();
  const slotHome = scratch();
  plainSlot(slotHome, "other-arc");
  // Inside heavy run (its token), poll the slot as browser-slot.py does, logging each refusal.
  const log = path.join(home, "polls.log");
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const poll = `until ${q(NODE)} ${q(SCRIPT)} lock acquire --slot 1 --holder me --go test 2>>${q(log)}; do sleep 0.2; done`;
  const run = start(["heavy", "run", "--holder", "job", "--", "sh", "-c", poll], { home, slotHome });
  try {
    const polls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
    await until(() => polls().length >= 3, "three polls");
    assert.equal(run.child.exitCode, null, "it is still waiting for the slot");
    assert.equal(lockState(home), "held", "holding heavy while it waits");
    for (const line of polls()) {
      assert.match(line, /^harness-slot lock: slot 1 is already locked by "other-arc"/);
      assert.match(line.replace("harness-slot lock: ", ""), WORKFLOW_WAIT, "in the words a waiter waits on");
    }
    releaseLock({ home: slotHome, target: 1, holder: "other-arc" });
    const r = await run.done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^acquired slot 1 for me: /m);
    assert.match(r.stdout, /heavy: already held by this job \(HARNESS_HEAVY_JOB\), so not taken again/);
    const lock = JSON.parse(fs.readFileSync(slotLockPath(slotHome), "utf8"));
    assert.equal(lock.holder, "me");
    assert.deepEqual(Object.keys(lock.heavy), ["job"], "taken under the job's heavy: the slot records that job, no holder of its own");
    assert.match(lock.heavy.job, /^job:\d+$/);
    assert.equal(lockState(home), "free", "the job's heavy ended with the job");
  } finally {
    run.child.kill("SIGKILL");
    stopHolders(home);
  }
});

ttest("order: a crash of the slot holder (its --pid) frees both, the slot first", async () => {
  const home = scratch();
  const owner = liveSleeper();
  try {
    const a = await cli(takeSlot("arc", ["--pid", String(owner.pid)]), { home, slotHome: home });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, new RegExp(`released with the slot, or when pid ${owner.pid} exits`));
    const holder = readInfo(home).pid;
    assert.equal(lockState(home), "held");
    assert.ok(fs.existsSync(slotLockPath(home)));
    owner.kill(); // SIGKILL: nothing of it runs a finally
    await until(() => !fs.existsSync(slotLockPath(home)) && lockState(home) === "free", "both to be freed");
    await until(() => gone(holder), "the holder process to end");
    assert.deepEqual(events(home), ["acquire heavy", "acquire slot 1", "release slot 1", "release heavy"]);
    // And the next acquire gets both at once.
    const b = await cli(takeSlot("next", ["--wait", "2"]), { home, slotHome: home });
    assert.equal(b.code, 0, b.stderr);
    assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "next"], { home, slotHome: home })).code, 0);
  } finally {
    owner.kill();
    stopHolders(home);
  }
});

// ─── the orphan (2026-11-23): a slot's heavy holder outlives its slot lock no more ──
//
// The incident: bitcorn-workflow's browser-slot-harness.py took slot 1 in a scratch
// lock home (its $HOME) and heavy-1 in the account's, then deleted the scratch
// home with the slot lock in it; the holder, which no release reached, kept
// heavy-1 for 2.5 days. Controls on the code before the fix: T1 and T2 timed out
// with the holder still holding; T5 printed no ORPHANED (lock status: "no locks
// held"). T3 and T4 passed before it too: they guard the fix's edges.

// T1
ttest("orphan: a slot's holder lets go of heavy by itself once its slot lock's home is deleted (no --pid), saying why", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    const a = await cli(takeSlot("workflow-app"), { home, slotHome });
    assert.equal(a.code, 0, a.stderr);
    const info = readInfo(home);
    assert.equal(info.for_slot_home, slotHome, "the holder records where its slot lock lives");
    assert.equal(lockState(home), "held");
    fs.rmSync(slotHome, { recursive: true, force: true }); // as the harness test's end_run() did
    await until(() => gone(info.pid) && lockState(home) === "free", "the holder to let go");
    assert.deepEqual(events(home), ["acquire heavy", "release heavy"]);
    assert.match(history(home), /^\S+ release lock="heavy" holder="slot-1\/workflow-app" acquired_at="\S+" held="\S+" reason="slot lock gone"$/m);
  } finally {
    stopHolders(home);
  }
});

// T2
ttest("orphan: a slot's holder lets go once its slot lock is another lock, even under the same holder name, and leaves that lock alone", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    assert.equal((await cli(takeSlot("arc"), { home, slotHome })).code, 0);
    const { pid } = readInfo(home);
    // Replaced in one rename, so it is never seen gone: same holder, another heavy.
    const lock = JSON.parse(fs.readFileSync(slotLockPath(slotHome), "utf8"));
    const replaced = `${JSON.stringify({ ...lock, acquired_at: "2026-11-23T00:00:00Z", heavy: { pid: 1, job: "other:1" } }, null, 2)}\n`;
    const tmp = `${slotLockPath(slotHome)}.t2`;
    fs.writeFileSync(tmp, replaced);
    fs.renameSync(tmp, slotLockPath(slotHome));
    await until(() => gone(pid) && lockState(home) === "free", "the holder to let go");
    assert.match(history(home), /^\S+ release lock="heavy" holder="slot-1\/arc" acquired_at="\S+" held="\S+" reason="slot lock changed"$/m);
    assert.equal(fs.readFileSync(slotLockPath(slotHome), "utf8"), replaced, "the other lock is left as it was");
  } finally {
    stopHolders(home);
  }
});

// T3
ttest("orphan: a live slot lock keeps its holder, as does one out for under the grace or one it cannot read; a normal release names no reason", async () => {
  const home = scratch();
  const slotHome = scratch();
  const file = slotLockPath(slotHome);
  try {
    assert.equal((await cli(takeSlot("arc"), { home, slotHome })).code, 0);
    const { pid } = readInfo(home);
    const held = () => !gone(pid) && lockState(home) === "held";
    await sleep(HOLD_ORPHAN_GRACE_MS + 500);
    assert.ok(held(), "a live slot lock keeps its holder");
    // Out for 1.5 s (a look lands meanwhile), then put back byte for byte: under the grace.
    fs.renameSync(file, `${file}.aside`);
    await sleep(1500);
    fs.renameSync(`${file}.aside`, file);
    await sleep(HOLD_ORPHAN_GRACE_MS + 1000);
    assert.ok(held(), "a slot lock out for under the grace keeps its holder");
    // Unreadable for longer than the grace: a lock it cannot read is not a lock gone.
    fs.chmodSync(file, 0o000);
    try {
      await sleep(HOLD_ORPHAN_GRACE_MS + 1500);
      assert.ok(held(), "an unreadable slot lock keeps its holder");
    } finally {
      fs.chmodSync(file, 0o644);
    }
    const r = await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^harness lock released: slot 1, holder arc, held .*\nharness lock released: heavy, holder slot-1\/arc, held /);
    assert.deepEqual(events(home), ["acquire heavy", "release heavy"]);
    assert.doesNotMatch(history(home), /reason=/, "a normal release is not an orphan's");
  } finally {
    stopHolders(home);
  }
});

// T4
ttest("orphan: a slot's holder whose CLI goes away before taking the slot lets go of heavy", async () => {
  const home = scratch();
  const slotHome = scratch();
  const spec = { holder: "slot-1/gone-cli", waitMs: null, ownerPid: null, ownerStart: null, watch: false, exclusive: false,
    slot: { target: 1, home: slotHome } };
  const child = spawn(NODE, [SCRIPT, "heavy", "__hold", JSON.stringify(spec)], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: slotHome, HARNESS_HEAVY_TEST_HOME: home, HARNESS_HEAVY_LIMIT: "1", HARNESS_HEAVY_TEST_MEMINFO: PLENTY, HARNESS_HEAVY_TEST_DISKFREE: PLENTY_DISK },
    stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true,
  });
  try {
    const m = await new Promise((resolve) => child.on("message", (msg) => { if (msg?.acquired) resolve(msg); }));
    assert.equal(lockState(home), "held");
    child.disconnect(); // the CLI gone: no slotTaken, no abandon
    child.unref();
    await until(() => gone(m.pid) && lockState(home) === "free", "the holder to let go");
    assert.deepEqual(events(home), ["acquire heavy", "release heavy"]);
    assert.doesNotMatch(history(home), /reason=/);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    stopHolders(home);
  }
});

// T5. A holder that does not watch (older code) is stood in for by a bare flock(1) on heavy and a
// hand-written record of kind "slot".
ttest("orphan: lock status and heavy status flag a slot's heavy holder ORPHANED when its slot lock is gone or records another heavy, naming the command that frees it", async () => {
  const home = scratch();
  const slotHome = scratch();
  const bare = await bareHolder(home, 30, 0);
  try {
    const job = `slot-1/ghost:${bare.pid}`;
    fs.writeFileSync(infoPath(home), `${JSON.stringify({ holder: "slot-1/ghost", acquired_at: "2026-11-21T00:47:24Z", host: HOST,
      slot: "heavy", kind: "slot", pid: bare.pid, job, for_slot: 1, for_slot_home: slotHome }, null, 2)}\n`);
    // heavy status from another $HOME: the record says where the slot lock lives.
    const heavyStatus = async () => (await cli(["heavy", "status"], { home, slotHome: scratch() })).stdout;
    const lockStatus = async () => (await cli(["lock", "status"], { home, slotHome })).stdout;
    const frees = String.raw` — status frees nothing; free it with: heavy release --force --slot 0 --reason "<why>"$`;
    const where = `slot 1's lock \\(${slotLockPath(slotHome).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`;

    // Gone.
    let h = await heavyStatus();
    assert.match(h, new RegExp(`^heavy \\S+: held by "slot-1/ghost" .* — ORPHANED: ${where} is gone${frees}`, "m"));
    let l = await lockStatus();
    assert.match(l, new RegExp(`^heavy: held by "slot-1/ghost" .*, for slot 1 — ORPHANED: ${where} is gone${frees}`, "m"));
    assert.doesNotMatch(l, /no locks held/);

    // Recorded: the slot lock carries this holder's pid.
    acquireLock({ home: slotHome, target: 1, holder: "ghost", go: "test", heavy: { pid: bare.pid, job } });
    h = await heavyStatus();
    assert.match(h, /^heavy \S+: held by "slot-1\/ghost" /m);
    assert.doesNotMatch(h, /ORPHANED/);
    l = await lockStatus();
    assert.match(l, /^slot 1: held by ghost /m);
    assert.doesNotMatch(l, /ORPHANED/);

    // Another heavy recorded.
    releaseLock({ home: slotHome, target: 1, holder: "ghost" });
    acquireLock({ home: slotHome, target: 1, holder: "ghost", go: "test", heavy: { pid: 1, job: "other:1" } });
    const another = `${where} records heavy holder pid 1, not this holder's pid ${bare.pid}`;
    assert.match(await heavyStatus(), new RegExp(`ORPHANED: ${another}${frees}`, "m"));
    assert.match(await lockStatus(), new RegExp(`^heavy: .* — ORPHANED: ${another}${frees}`, "m"));
  } finally {
    bare.kill();
  }
});

// F6: a slot already held is refused before heavy is even waited for. The control
// (the pre-check removed): the acquire waited on the bare holder's heavy until --wait ran out.
ttest("F6: a held slot is refused at once, before any heavy holder starts, in the words a waiter waits on", async () => {
  const home = scratch();
  const slotHome = scratch();
  plainSlot(slotHome, "other-arc");
  const bare = await bareHolder(home, 30);
  try {
    const t0 = Date.now();
    const r = await cli(takeSlot("me", ["--wait", "5"]), { home, slotHome });
    assert.ok(Date.now() - t0 < 3000, `it must not wait on heavy (took ${Date.now() - t0} ms)`);
    assert.equal(r.code, 2, r.stderr);
    const refusal = r.stderr.split("\n").find((l) => l.includes("already locked")) ?? "";
    assert.match(refusal, /^harness-slot lock: slot 1 is already locked by "other-arc" since \S+, go "test"$/);
    assert.match(refusal.replace("harness-slot lock: ", ""), WORKFLOW_WAIT);
    assert.doesNotMatch(r.stderr, /waiting|heavy is already locked/);
    assert.deepEqual(events(home), [], "no heavy was taken or let go");
  } finally {
    bare.kill();
  }
});

ttest("order: a slot that cannot be had lets heavy go again, and its refusal is the slot's own", async () => {
  const home = scratch();
  const slotHome = scratch();
  // Under a Polar setup window, which the slot pre-check (F6) does not look at, so heavy is taken first.
  acquireLock({ home: slotHome, target: "setup", holder: "polar", go: "test" });
  const s = await cli(takeSlot("me"), { home, slotHome });
  assert.equal(s.code, 2);
  assert.match(s.stderr, /harness-slot lock: heavy \(heavy\) let go again: slot 1 was not taken/);
  const refusal = s.stderr.split("\n").find((l) => l.includes("refused")) ?? "";
  assert.match(refusal.replace("harness-slot lock: ", ""), WORKFLOW_WAIT);
  assert.equal(lockState(home), "free");
  assert.deepEqual(events(home), ["acquire heavy", "release heavy"]);
});

ttest("order: a Node grandchild of a heavy command, which holds no descriptor, still counts as the job (its token is inherited)", async () => {
  const home = scratch();
  const slotHome = scratch();
  // node → node: the inner node gets no fd 9 (Node marks inherited fds close-on-exec). Outside the job it
  // would wait on the run's heavy until --wait ran out; inside it, it takes the (free) slot at once.
  const inner = `const r=require("child_process").spawnSync(${JSON.stringify(NODE)},[${JSON.stringify(SCRIPT)},"lock","acquire","--slot","1","--holder","me","--go","test","--wait","3"],{encoding:"utf8"});` +
    "process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status)";
  const t0 = Date.now();
  const r = await cli(["heavy", "run", "--", NODE, "-e", inner], { home, slotHome });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Date.now() - t0 < 3000, `it must not wait on heavy (took ${Date.now() - t0} ms)`);
  assert.match(r.stdout, /^acquired slot 1 for me: /m);
  assert.match(r.stdout, /heavy: already held by this job \(HARNESS_HEAVY_JOB\)/);
  assert.doesNotMatch(r.stderr, /heavy is already locked/);
});

// F2: separate shells, as separate Claude Code Bash calls are (each its own
// short-lived bash, so no process of the first is an ancestor of the next).
ttest("order (F2): after heavy acquire, a later separate command carrying its token reaches the slot; one without it waits on heavy", async () => {
  const home = scratch();
  const slotHome = scratch();
  const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: slotHome, HARNESS_HEAVY_TEST_HOME: home, HARNESS_HEAVY_LIMIT: "1", HARNESS_HEAVY_TEST_MEMINFO: PLENTY, HARNESS_HEAVY_TEST_DISKFREE: PLENTY_DISK };
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const shell = (line, extra = {}) => spawnSync("sh", ["-c", line], { encoding: "utf8", timeout: 30_000, env: { ...env, ...extra } });
  try {
    plainSlot(slotHome, "other-arc");
    const a = shell(`${q(NODE)} ${q(SCRIPT)} heavy acquire --holder shell-arc`);
    assert.equal(a.status, 0, a.stderr);
    const token = tokenOf(a.stdout);
    assert.equal(token, `shell-arc:${readInfo(home).pid}`, a.stdout);
    const slot = (n) => `${q(NODE)} ${q(SCRIPT)} lock acquire --slot ${n} --holder shell-arc --go test --wait 1`;

    // No token: outside the job, so heavy comes first, and it waits there (slot 2 is free:
    // a held slot is refused before heavy, F6).
    const without = shell(slot(2));
    assert.equal(without.status, 2);
    assert.match(without.stderr, /heavy is already locked by "shell-arc"/);
    assert.doesNotMatch(without.stderr, /slot 2 is already locked/);
    assert.ok(!fs.existsSync(slotLockPath(slotHome, 2)));

    // The token: inside the job, so straight to the slot, which is busy: the refusal a waiter waits on.
    const withToken = shell(slot(1), { HARNESS_HEAVY_JOB: token });
    assert.equal(withToken.status, 2);
    assert.match(withToken.stderr, /harness-slot lock: slot 1 is already locked by "other-arc"/);
    assert.equal(lockState(home), "held", "the job keeps its heavy");

    // A token naming another job does not count.
    const stale = shell(slot(2), { HARNESS_HEAVY_JOB: `shell-arc:${deadPid()}` });
    assert.match(stale.stderr, /heavy is already locked by "shell-arc"/);

    const rel = shell(`${q(NODE)} ${q(SCRIPT)} heavy release --holder shell-arc`);
    assert.match(rel.stdout, /harness lock released: heavy, holder shell-arc/, rel.stderr);
    assert.equal(lockState(home), "free");
  } finally {
    stopHolders(home);
  }
});

// THE HANDOFF (2026-11-23): heavy, then setup, then the slot. Setup's holder
// takes its slot inside a heavy job (the token), so it never waits on heavy
// while holding setup, and releases setup only after the slot is taken.
ttest("handoff: heavy, then setup, then the slot under the token, then setup released — in that order in history.log", async () => {
  const home = scratch();
  try {
    const opts = (env = {}) => ({ home, slotHome: home, env }); // one home, so history.log orders all four locks together
    const h = await cli(["heavy", "acquire", "--holder", "repair-arc"], opts());
    assert.equal(h.code, 0, h.stderr);
    const token = tokenOf(h.stdout);
    const s = await cli(["lock", "acquire", "--setup", "--holder", "repair-arc", "--go", "test"], opts());
    assert.equal(s.code, 0, s.stderr);
    const slot = await cli(takeSlot("repair-arc"), opts({ HARNESS_HEAVY_JOB: token }));
    assert.equal(slot.code, 0, slot.stderr);
    assert.match(slot.stdout, /^acquired slot 1 for repair-arc: /m);
    const rel = await cli(["lock", "release", "--setup", "--holder", "repair-arc"], opts());
    assert.equal(rel.code, 0, rel.stderr);
    const order = events(home);
    console.log(order.join("\n"));
    assert.deepEqual(order, ["acquire heavy", "acquire setup", "acquire slot 1", "release setup"]);
    assert.ok(order.indexOf("acquire slot 1") < order.indexOf("release setup"), "no moment with neither setup nor the slot");
    assert.equal(lockState(home), "held", "the job's heavy is still held");
    // the pre-flight's view at this point: the slot's holder, setup gone
    assert.ok(fs.existsSync(slotLockPath(home)) && !fs.existsSync(path.join(locksDir(home), "setup.lock")));
    const out = await cli(["lock", "release", "--slot", "1", "--holder", "repair-arc"], opts());
    assert.match(out.stdout, /heavy: left to job/, out.stderr);
    assert.equal((await cli(["heavy", "release", "--holder", "repair-arc"], opts())).code, 0);
  } finally {
    stopHolders(home);
  }
});

ttest("handoff order: setup's holder outside a heavy job is refused at once — lock acquire --slot, heavy run, heavy acquire — taking no heavy", async () => {
  const home = scratch();
  const slotHome = scratch();
  acquireLock({ home: slotHome, target: "setup", holder: "repair-arc", go: "test" });
  const t0 = Date.now();
  const slot = await cli(takeSlot("repair-arc", ["--wait", "5"]), { home, slotHome });
  assert.ok(Date.now() - t0 < 3000, `refused at once (took ${Date.now() - t0} ms)`);
  assert.equal(slot.code, 2, slot.stderr);
  console.log(slot.stderr.trim());
  assert.match(slot.stderr, /slot 1 refused: "repair-arc" holds setup\.lock, and waiting on heavy while holding setup breaks the lock order \(heavy, then setup, then the slot\)/);
  assert.ok(!fs.existsSync(slotLockPath(slotHome)));
  for (const args of [["heavy", "run", "--wait", "5", "--", "true"], ["heavy", "acquire", "--holder", "repair-arc", "--wait", "5"]]) {
    const r = await cli(args, { home, slotHome, env: { HARNESS_HOLDER: "repair-arc" } });
    assert.equal(r.code, 2, `${args[1]}: ${r.stderr}`);
    assert.match(r.stderr, /heavy refused: "repair-arc" holds setup\.lock, and waiting on heavy while holding setup/, args[1]);
  }
  assert.deepEqual(events(home), [], "no heavy was taken");
  // another holder's setup is not this guard's business: that slot acquire takes heavy, then meets setup's refusal
  const other = await cli(takeSlot("drive-mode"), { home, slotHome });
  assert.equal(other.code, 2);
  assert.match(other.stderr, /slot 1 refused: setup\.lock is held by "repair-arc"/);
  assert.doesNotMatch(other.stderr, /holds setup\.lock, and waiting/);
});

// F2: ancestry no longer joins processes to the job. At e1abb82 both runs below
// descended from the --pid owner, counted as "already held by this job", and
// ran at once.
ttest("F2: two heavy runs that descend from a --pid owner, without its token, wait and run one at a time", async () => {
  const home = scratch();
  const log = path.join(home, "jobs.log");
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const run = (name) => [NODE, SCRIPT, "heavy", "run", "--", ...loggedJob(log, name, 700)].map(q).join(" ");
  const out = path.join(home, "runs.err");
  try {
    // The owner starts both runs, lives 1.5 s, and exits; its holder then lets go.
    const sh = spawn("sh", ["-c",
      `${q(NODE)} ${q(SCRIPT)} heavy acquire --holder session --pid $$ >/dev/null; ` +
      `(${run("a")}) 2>>${q(out)} & (${run("b")}) 2>>${q(out)} & sleep 1.5; exit 0`], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: scratch(), HARNESS_HEAVY_TEST_HOME: home, HARNESS_HEAVY_LIMIT: "1", HARNESS_HEAVY_TEST_MEMINFO: PLENTY, HARNESS_HEAVY_TEST_DISKFREE: PLENTY_DISK }, stdio: "ignore",
    });
    await once(sh, "exit");
    await until(() => fs.existsSync(log) && (fs.readFileSync(log, "utf8").match(/^end /gm) ?? []).length === 2, "both runs", 20_000);
    const spans = intervals(log);
    assertNoOverlap(spans);
    assert.doesNotMatch(fs.readFileSync(out, "utf8"), /already held by this job/);
    await until(() => lockState(home) === "free", "the lock to free");
  } finally {
    stopHolders(home);
  }
});

// F2: ancestry plays no part, even the descriptor's. A child of the holder that
// has fd 9 but not the token is outside the job, so it waits (here, bounded).
ttest("F2: a child of the holder without the token is outside the job, even holding fd 9", async () => {
  const home = scratch();
  const r = await cli(["heavy", "run", "--holder", "parent", "--",
    "env", "-u", "HARNESS_HEAVY_JOB", NODE, SCRIPT, "heavy", "run", "--wait", "1", "--", "true"], { home });
  assert.equal(r.code, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /already held by this job/);
  assert.match(r.stderr, /heavy is already locked by "parent"/);
  assert.equal(lockState(home), "free");
});

ttest("F2: inside one token, concurrency is the caller's: two heavy runs with the same token both run, at once", async () => {
  const home = scratch();
  const log = path.join(home, "jobs.log");
  try {
    const a = await cli(["heavy", "acquire", "--holder", "shared"], { home });
    const token = tokenOf(a.stdout);
    assert.ok(token, a.stdout);
    const rs = await Promise.all(["a", "b"].map((n) =>
      cli(["heavy", "run", "--", ...loggedJob(log, n, 1000)], { home, env: { HARNESS_HEAVY_JOB: token } })));
    for (const r of rs) {
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /already held by this job \("shared"\); running without acquiring again/);
    }
    const [x, y] = intervals(log);
    assert.ok(y.s < x.e, "they overlap: the token makes them one job");
  } finally {
    stopHolders(home);
  }
});

ttest("order: a slot's holder runs its heavy jobs inside the slot's token; without it they wait on heavy", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    const a = await cli(["lock", "acquire", "--slot", "1", "--holder", "arc", "--go", "test"], { home, slotHome });
    assert.equal(a.code, 0, a.stderr);
    const inside = await cli(["heavy", "run", "--", "true"], { home, slotHome, env: { HARNESS_HEAVY_JOB: tokenOf(a.stdout) } });
    assert.equal(inside.code, 0, inside.stderr);
    assert.match(inside.stderr, /already held by this job \("slot-1\/arc"\); running without acquiring again/);
    const outside = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home, slotHome });
    assert.equal(outside.code, 2);
    assert.match(outside.stderr, /heavy is already locked by "slot-1\/arc"/);
    assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome })).code, 0);
  } finally {
    stopHolders(home);
  }
});

// F1 (1). The control (the refusal removed): heavy release --force stopped the slot's
// holder and reported FORCE-released, leaving slot-1.lock naming a heavy that was gone.
// The orphan (2026-11-23) rewrote the second half: a slot-only release used to leave the holder for
// heavy release --force; now the holder lets go by itself, and says why.
ttest("F1: heavy release --force refuses a slot's heavy while the slot lock records it, pointing to the slot's own --force; once it no longer does, the holder lets go by itself", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    assert.equal((await cli(takeSlot("arc"), { home, slotHome })).code, 0);
    const { pid } = readInfo(home);
    const forced = await cli(["heavy", "release", "--force", "--reason", "test"], { home, slotHome });
    assert.equal(forced.code, 2, forced.stderr);
    assert.match(forced.stderr, new RegExp(`heavy is held for slot 1's lock, which still records it \\(holder pid ${pid}\\); ` +
      `free both, the slot first: lock release --slot 1 --force --reason "<why>"`));
    assert.ok(!gone(pid), "the holder was not signalled");
    assert.equal(lockState(home), "held");
    assert.doesNotMatch(history(home), /force-release/);
    // The way it points to frees both, the slot first.
    const slot = await cli(["lock", "release", "--slot", "1", "--force", "--reason", "test"], { home, slotHome });
    assert.equal(slot.code, 0, slot.stderr);
    assert.match(slot.stdout, /^harness lock FORCE-released: slot 1, .*\nharness lock FORCE-released: heavy, was held by slot-1\/arc/);
    assert.equal(lockState(home), "free");
    assert.ok(!fs.existsSync(slotLockPath(slotHome)));

    // The refusal reads the slot lock where the holder recorded it, not the caller's $HOME.
    assert.equal((await cli(takeSlot("arc2"), { home, slotHome })).code, 0);
    const second = readInfo(home).pid;
    const elsewhere = await cli(["heavy", "release", "--force", "--reason", "test"], { home, slotHome: scratch() });
    assert.equal(elsewhere.code, 2, elsewhere.stderr);
    assert.match(elsewhere.stderr, /heavy is held for slot 1's lock, which still records it/);
    assert.ok(!gone(second), "the holder was not signalled");
    // Once the slot lock no longer records it (here, a slot-only force release, which stops no holder),
    // the holder lets go by itself, its release line saying why: nothing is left to force.
    forceReleaseLock({ home: slotHome, target: 1, reason: "test" });
    await until(() => gone(second) && lockState(home) === "free", "the holder to let go by itself");
    assert.match(history(home), /^\S+ release lock="heavy" holder="slot-1\/arc2" acquired_at="\S+" held="\S+" reason="slot lock gone"$/m);
    assert.doesNotMatch(history(home), /force-release lock="heavy" holder="slot-1\/arc2"/);
  } finally {
    stopHolders(home);
  }
});

// F1 (2). The control (status not checking a pid record): the slot read as any other,
// with nothing about its heavy being gone.
ttest("F1: lock status flags a slot SUSPECT once its recorded heavy pid no longer holds a heavy slot; its holder's heavy run then refuses", async () => {
  const home = scratch();
  const slotHome = scratch();
  try {
    assert.equal((await cli(takeSlot("arc"), { home, slotHome })).code, 0);
    const { pid } = readInfo(home);
    const live = await cli(["lock", "status"], { home, slotHome });
    assert.equal(live.code, 0, live.stderr);
    assert.match(live.stdout, /^slot 1: held by arc /m);
    assert.doesNotMatch(live.stdout, /heavy holder pid|heavy check could not run/, "its heavy holds");
    // The holder dies: the kernel frees heavy at once; the slot lock stays.
    process.kill(pid, "SIGKILL");
    await until(() => gone(pid) && lockState(home) === "free", "the holder to die and heavy to free");
    const stale = await cli(["lock", "status"], { home, slotHome });
    assert.equal(stale.code, 0, stale.stderr);
    assert.match(stale.stdout, new RegExp(`^slot 1: held by arc .* — SUSPECT: .*its heavy holder pid ${pid} no longer holds a heavy slot.* — ` +
      "status frees nothing; if it is stale: lock release --slot 1 --force --reason", "m"));
    assert.ok(fs.existsSync(slotLockPath(slotHome)), "status frees nothing");
    // F2, for a pid record: the slot's holder would now wait on heavy while holding the slot, so it is refused at once.
    const t0 = Date.now();
    const run = await cli(["heavy", "run", "--wait", "5", "--", "true"], { home, slotHome, env: { HARNESS_HOLDER: "arc" } });
    assert.ok(Date.now() - t0 < 3000, `refused at once (took ${Date.now() - t0} ms)`);
    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, new RegExp(`heavy refused: HARNESS_HOLDER "arc" holds slot 1 \\(heavy holder pid ${pid}, not live\\)`));
    assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome })).code, 0);
  } finally {
    stopHolders(home);
  }
});

// F2. Controls: the slot taken under a token recorded no heavy; status said nothing once
// the job's hold was gone; heavy run ran its command and heavy acquire took heavy.
ttest("F2: a slot taken inside a job records that job; status flags it once the job's hold is gone, and the holder's heavy run and heavy acquire then refuse at once", async () => {
  const home = scratch();
  const slotHome = scratch();
  const marker = path.join(home, "ran");
  try {
    const outer = await cli(["heavy", "acquire", "--holder", "outer"], { home, slotHome });
    assert.equal(outer.code, 0, outer.stderr);
    const token = tokenOf(outer.stdout);
    const s = await cli(takeSlot("arc"), { home, slotHome, env: { HARNESS_HEAVY_JOB: token } });
    assert.equal(s.code, 0, s.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(slotLockPath(slotHome), "utf8")).heavy, { job: token });
    const live = await cli(["lock", "status"], { home, slotHome });
    assert.doesNotMatch(live.stdout, /heavy job|heavy check could not run/, "the job's heavy holds");

    // While it holds, the holder's heavy jobs are not refused: inside the token they nest; outside it they wait.
    const inside = await cli(["heavy", "run", "--", "true"], { home, slotHome, env: { HARNESS_HOLDER: "arc", HARNESS_HEAVY_JOB: token } });
    assert.equal(inside.code, 0, inside.stderr);
    assert.match(inside.stderr, /already held by this job \("outer"\)/);
    const outside = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home, slotHome, env: { HARNESS_HOLDER: "arc" } });
    assert.equal(outside.code, 2);
    assert.match(outside.stderr, /heavy is already locked by "outer"/);
    assert.doesNotMatch(outside.stderr, /heavy refused/);

    // The job's hold ends; the slot lock stays.
    assert.equal((await cli(["heavy", "release", "--holder", "outer"], { home, slotHome })).code, 0);
    assert.equal(lockState(home), "free");
    const stale = await cli(["lock", "status"], { home, slotHome });
    assert.match(stale.stdout, new RegExp(`^slot 1: held by arc .* — SUSPECT: .*the heavy job "${token}" it was taken under no longer holds heavy`, "m"));

    for (const args of [["heavy", "run", "--wait", "5", "--", "touch", marker], ["heavy", "acquire", "--holder", "later", "--wait", "5"]]) {
      const t0 = Date.now();
      const r = await cli(args, { home, slotHome, env: { HARNESS_HOLDER: "arc" } });
      assert.ok(Date.now() - t0 < 3000, `${args[1]}: refused at once (took ${Date.now() - t0} ms)`);
      assert.equal(r.code, 2, `${args[1]}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`heavy refused: HARNESS_HOLDER "arc" holds slot 1 \\(heavy job "${token}", not live\\), and waiting on ` +
        "heavy while holding a slot breaks the lock order \\(heavy first, then the slot\\); release the slot \\(lock release --slot 1 --holder arc\\)"));
    }
    assert.ok(!fs.existsSync(marker), "the command was not run");
    assert.equal(lockState(home), "free", "nothing was acquired");
    assert.doesNotMatch(history(home), /holder="later"/);
    // Another holder's heavy jobs are not refused.
    const other = await cli(["heavy", "run", "--", "true"], { home, slotHome, env: { HARNESS_HOLDER: "someone-else" } });
    assert.equal(other.code, 0, other.stderr);

    // The slot's release leaves the job's heavy to the job.
    const rel = await cli(["lock", "release", "--slot", "1", "--holder", "arc"], { home, slotHome });
    assert.equal(rel.code, 0, rel.stderr);
    assert.match(rel.stdout, new RegExp(`^heavy: left to job "${token}", which held it before the slot was taken$`, "m"));
  } finally {
    stopHolders(home);
  }
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

// F3. The control (e1abb82): the inner acquire's holder waited on "outer" until --wait ran out.
ttest("F3: a heavy acquire inside a job that holds heavy refuses at once, and acquires nothing", async () => {
  const home = scratch();
  try {
    const t0 = Date.now();
    const r = await cli(["heavy", "run", "--holder", "outer", "--", NODE, SCRIPT, "heavy", "acquire", "--holder", "inner", "--wait", "5"], { home });
    assert.ok(Date.now() - t0 < 4000, `it must not wait (took ${Date.now() - t0} ms)`);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /harness-slot heavy: already held by this job \("outer"\); nothing acquired/);
    assert.doesNotMatch(r.stderr, /waiting/);
    assert.doesNotMatch(history(home), /holder="inner"/);
    // The same from a command carrying an acquire's token.
    const a = await cli(["heavy", "acquire", "--holder", "first"], { home });
    const again = await cli(["heavy", "acquire", "--holder", "second", "--wait", "5"], { home, env: { HARNESS_HEAVY_JOB: tokenOf(a.stdout) } });
    assert.equal(again.code, 2, again.stderr);
    assert.match(again.stderr, /already held by this job \("first"\); nothing acquired/);
    assert.equal(readInfo(home).holder, "first");
  } finally {
    stopHolders(home);
  }
});

ttest("heavy acquire / release: a holder process keeps the lock, so there is no pid-less acquire; release refuses another's", async () => {
  const home = scratch();
  try {
    const a = await cli(["heavy", "acquire", "--holder", "polar-gate"], { home });
    assert.equal(a.code, 0, a.stderr);
    const info = readInfo(home);
    assert.equal(info.kind, "acquire");
    assert.equal(info.job, `polar-gate:${info.pid}`);
    assert.equal(tokenOf(a.stdout), info.job, "the token is printed");
    assert.ok(info.owner_pid === undefined, "without --pid, no owner is recorded");
    assert.ok(Number.isInteger(info.pid) && !gone(info.pid), "the holder process runs");
    assert.ok(fs.readdirSync(`/proc/${info.pid}/fd`).some((n) => {
      try { return fs.readlinkSync(`/proc/${info.pid}/fd/${n}`) === lockPath(home); } catch { return false; }
    }), "and has the lock's file open");
    assert.match(a.stdout, new RegExp(`held by pid ${info.pid}; freed by heavy release, or --force --reason`));
    assert.equal(lockState(home), "held");
    // This test process ran the acquire, but carries no token: outside the job, it waits.
    const blocked = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, new RegExp(`"polar-gate" since \\S+ on \\S+, pid ${info.pid} running`));
    const wrong = await cli(["heavy", "release", "--holder", "someone-else"], { home });
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /heavy is held by "polar-gate" since \S+ \(heavy\), not "someone-else"/);
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
  } finally {
    stopHolders(home);
  }
});

ttest("heavy release --force stops an acquire's holder process, and refuses a running heavy job", async () => {
  const home = scratch();
  try {
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
  } finally {
    stopHolders(home);
  }
});

// F4 (1): the reused-pid property, in release's kill target. The mutant (no
// hasOpen in heavyRelease's holderProcess) SIGKILLed the unrelated process and
// reported FORCE-released while the lock stayed held.
ttest("F4: heavy release never signals a process its record names unless that process has the lock open", async () => {
  const home = scratch();
  const bare = await bareHolder(home);
  const victim = liveSleeper();
  try {
    // A stale or forged record: an acquire holder, a live pid that is not the holder.
    fs.writeFileSync(infoPath(home), JSON.stringify({
      holder: "ghost", acquired_at: "2026-11-19T12:00:00Z", host: HOST, slot: "heavy", kind: "acquire",
      pid: victim.pid, job: `ghost:${victim.pid}`,
    }));
    for (const args of [["--force", "--reason", "test"], ["--holder", "ghost"]]) {
      const r = await cli(["heavy", "release", ...args], { home });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /not by a heavy acquire holder process/);
      assert.ok(!gone(victim.pid), `release ${args.join(" ")} must not signal pid ${victim.pid}`);
      assert.equal(lockState(home), "held");
    }
    assert.doesNotMatch(history(home), /force-release|release lock="heavy"/);
  } finally {
    victim.kill();
    bare.kill();
  }
  // The positive control: a genuine holder process is released by both.
  const home2 = scratch();
  try {
    for (const args of [["--force", "--reason", "test"], ["--holder", "real"]]) {
      assert.equal((await cli(["heavy", "acquire", "--holder", "real"], { home: home2 })).code, 0);
      const { pid } = readInfo(home2);
      const r = await cli(["heavy", "release", ...args], { home: home2 });
      assert.equal(r.code, 0, r.stderr);
      // Waited for, bounded: what this test proves is who is signalled. That a release is never
      // reported before the lock is free is proved, deterministically, by "a release is never reported early".
      await until(() => gone(pid) && lockState(home2) === "free", "the holder gone and its lock free", 5000);
    }
  } finally {
    stopHolders(home2);
  }
});

// ─── a release is never reported before the lock is free (2026-11-20) ─────
//
// A probe found a SIGKILLed Node holder's main thread reading Z (gone) while a
// thread still held its descriptor, and the flock, for ~5 ms. These fixtures make
// that window deterministic: a holder pid that ends while another process keeps
// the same open file (a shell's background child), and a process whose leader has
// exited while a thread keeps it (Python's main thread calling pthread_exit).

// A holder record of kind "acquire" naming a shell that holds heavy.lock, whose background child
// shares the descriptor for `childSecs`; resolves to { pid, kill } once the lock is held.
async function holderWithStraggler(home, childSecs) {
  fs.mkdirSync(locksDir(home), { recursive: true });
  const p = spawn("sh", ["-c", `exec 9>>"$1"; /usr/bin/flock 9; (sleep ${childSecs}) & exec sleep 300`, "sh", lockPath(home)],
    { detached: true, stdio: "ignore" });
  p.unref();
  await until(() => lockState(home) === "held", "the fixture's lock");
  await until(() => fs.readlinkSync(`/proc/${p.pid}/exe`).endsWith("/sleep"), "the fixture's exec");
  fs.writeFileSync(infoPath(home), JSON.stringify({
    holder: "fake", acquired_at: "2026-11-20T12:00:00Z", host: HOST, slot: "heavy", kind: "acquire", pid: p.pid, job: `fake:${p.pid}`,
  }));
  return { pid: p.pid, kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
}

ttest("a release is never reported early: it waits (bounded) for the last process holding the lock, or says NOT released", async () => {
  // A straggler that lets go within the bound: released, and only once the lock is free.
  for (const args of [["--holder", "fake"], ["--force", "--reason", "test"]]) {
    const home = scratch();
    const h = await holderWithStraggler(home, 1.5);
    try {
      const t0 = Date.now();
      const r = await cli(["heavy", "release", ...args], { home });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(lockState(home), "free", `${args[0]}: the release was reported while the lock was still held`);
      assert.ok(Date.now() - t0 >= 1000, `${args[0]}: it waited for the straggler (${Date.now() - t0} ms)`);
      assert.match(history(home), args[0] === "--force" ? /force-release lock="heavy"/ : /release lock="heavy" holder="fake"/);
    } finally {
      h.kill();
    }
  }
  // One that outlasts the bound: NOT released, nothing logged, the record kept.
  const home = scratch();
  const h = await holderWithStraggler(home, 30);
  try {
    const r = await cli(["heavy", "release", "--force", "--reason", "test"], { home });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy NOT released: pid \d+ \(sleep\) still holds the lock 3 s after holder pid \d+ ended; it frees when it exits/);
    assert.equal(lockState(home), "held");
    assert.doesNotMatch(history(home), /release/);
    assert.ok(fs.existsSync(infoPath(home)), "the record stays");
  } finally {
    h.kill();
  }
});

ttest("a holder whose main thread has exited while a thread keeps the lock is still seen holding it", async () => {
  const home = scratch();
  fs.mkdirSync(locksDir(home), { recursive: true });
  const py = path.join(home, "zombie-leader.py");
  fs.writeFileSync(py, [
    "import ctypes, fcntl, os, sys, threading, time",
    "f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX)",
    "def hold():",
    "    time.sleep(float(sys.argv[2])); os._exit(0)",
    "threading.Thread(target=hold).start()",
    "sys.stdout.write('locked\\n'); sys.stdout.flush()",
    "ctypes.CDLL(None).pthread_exit(None)", // the main thread exits; the process lives on in `hold`
  ].join("\n"));
  const p = spawn("/usr/bin/python3", ["-I", py, lockPath(home), "4"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await until(() => procStat(p.pid)?.state === "Z", "the leader to exit");
    assert.equal(lockState(home), "held", "the fixture: a thread still holds the lock");
    const key = `${fs.statSync(lockPath(home)).dev}:${fs.statSync(lockPath(home)).ino}`;
    assert.ok(lockHolders(key).includes(p.pid), "lockHolders sees the process by its thread");
    assert.equal(heavyLocked(home, 0), true, "heavyLocked sees it held");
    const s = await cli(["heavy", "status"], { home });
    assert.match(s.stdout, /^heavy \S+: held by/m);
  } finally {
    p.kill("SIGKILL");
  }
});

ttest("heavy run waits (bounded) for a straggler holding its descriptor to let go, then releases", async () => {
  const home = scratch();
  // setsid: the straggler leaves the command's process group, so the wrapper does not end it.
  const r = await cli(["heavy", "run", "--", "sh", "-c", "setsid sleep 1 & exit 0"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /NOT released/);
  assert.match(r.stderr, /harness lock released: heavy/);
  assert.equal(lockState(home), "free", "released only once the straggler let go");
});

// F4 (2): the reused-pid property, in the job token. The mutant (no hasOpen in
// heldByThisJob) counted a token whose record's pid was alive but not the holder.
ttest("F4: a job token counts only while its record's process has the lock's file open", async () => {
  const home = scratch();
  const bare = await bareHolder(home); // flock(1): has heavy.lock open
  const other = liveSleeper(); // alive, has it not open: a dead holder's reused pid
  try {
    const put = (pid) => fs.writeFileSync(infoPath(home), JSON.stringify({
      holder: "h", acquired_at: "2026-11-19T12:00:00Z", host: HOST, slot: "heavy", kind: "acquire", pid, job: `h:${pid}`,
    }));
    put(bare.pid);
    assert.equal(heldByThisJob(home, { env: { HARNESS_HEAVY_JOB: `h:${bare.pid}` } }), true, "the positive control");
    assert.equal(heldByThisJob(home, { env: { HARNESS_HEAVY_JOB: `h:${other.pid}` } }), false, "a token not the record's");
    assert.equal(heldByThisJob(home, { env: {} }), false, "no token");
    put(other.pid);
    assert.equal(heldByThisJob(home, { env: { HARNESS_HEAVY_JOB: `h:${other.pid}` } }), false,
      "the record's pid is alive but does not have the lock open");
  } finally {
    other.kill();
    bare.kill();
  }
});

// F6: /proc/locks prints the device its own way, so a line is matched on the
// inode alone; another filesystem's flocked file with the same inode number
// must not read as heavy held. The mutant (no open-file check) read it as held.
ttest("F6: heavyLocked needs a process with the slot's file itself open, not just its inode number in /proc/locks", async () => {
  const home = scratch();
  fs.mkdirSync(locksDir(home), { recursive: true });
  fs.writeFileSync(lockPath(home), "");
  const ino = fs.statSync(lockPath(home)).ino;
  const foreign = () => `1: FLOCK  ADVISORY  WRITE 4242 00:4f:${ino} 0 EOF\n`;
  assert.equal(heavyLocked(home, 0, { procLocks: foreign }), false, "same inode number, nobody has heavy.lock open");
  assert.equal(heavyLocked(home, 0, { procLocks: () => "" }), false);
  const bare = await bareHolder(home);
  try {
    assert.equal(heavyLocked(home, 0), true, "the positive control: really held");
    assert.equal(heavyLocked(home, 0, { procLocks: foreign }), true, "listed, and heavy.lock is open");
  } finally {
    bare.kill();
  }
  await until(() => lockState(home) === "free", "the bare holder to go");
  assert.equal(heavyLocked(home, 0), false);
});

// F4 (1). The control (the admission flock waiting with no bound): the run sat on
// heavy-admit.lock until the bare holder let go of it, 10 s, past its --wait 1.
ttest("F4: a job's --wait bounds its wait for the admission lock too", async () => {
  const home = scratch();
  fs.mkdirSync(locksDir(home), { recursive: true });
  const admitPath = path.join(locksDir(home), "heavy-admit.lock");
  const p = spawn("/usr/bin/flock", [admitPath, "sleep", "10"], { detached: true, stdio: "ignore" });
  p.unref();
  try {
    await until(() => spawnSync("/usr/bin/flock", ["-n", "-E", "200", admitPath, "true"]).status === 200, "the admission lock to be held");
    const t0 = Date.now();
    const r = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
    const took = Date.now() - t0;
    assert.equal(r.code, 2, r.stderr);
    assert.ok(took >= 900 && took < 4000, `it gave up when its wait ran out (took ${took} ms)`);
    assert.match(r.stderr, /heavy not admitted: the admission lock \(heavy-admit\.lock\) was held by another job's admission until this one's wait ran out; waited \d+s; the command was not run/);
    assert.equal(lockState(home), "free");
  } finally {
    try { process.kill(-p.pid, "SIGKILL"); } catch {}
  }
});

// F4 (2). The control (no cap after the SIGKILL): stopHolder never returned while its
// holder kept running, so the release hung instead of saying NOT released.
ttest("F4: a holder still running 2 s after its SIGKILL is reported NOT released, not waited on without end", async () => {
  let alive = true; // lets a mutant's endless loop end once the test is over
  const sent = [];
  const fake = { kill: (_, s) => sent.push(s), isRunning: () => alive };
  const hung = (ms) => sleep(ms).then(() => "hung");
  try {
    const t0 = Date.now();
    assert.equal(await Promise.race([stopHolder(999_999, "SIGKILL", fake), hung(6000)]), false);
    const took = Date.now() - t0;
    assert.ok(took >= KILL_WAIT_MS && took < KILL_WAIT_MS + 1500, `gave up ${KILL_WAIT_MS} ms after the SIGKILL (took ${took} ms)`);
    assert.deepEqual(sent, ["SIGKILL"]);
    // Through the release path: NOT released, naming the holder, and nothing logged.
    const home = scratch();
    fs.mkdirSync(locksDir(home), { recursive: true });
    const r = await Promise.race([stopAndConfirm(home, 999_999, "SIGKILL", [0], fake).then(() => "resolved", (e) => e), hung(6000)]);
    assert.ok(r instanceof Error, `it must reject, got ${r}`);
    assert.match(r.message, /^heavy NOT released: holder pid 999999 \([^)]*\) is still running 2 s after its SIGKILL; it frees when it exits$/);
    assert.equal(history(home), "");
    // A holder that does end is reported gone.
    alive = false;
    assert.equal(await stopHolder(999_999, "SIGKILL", fake), true);
  } finally {
    alive = false;
  }
});

// F5. The control (no close before the error): this process kept heavy-1 locked after lockHeavy threw.
ttest("F5: a MemAvailable read that fails lets go of the slot it took before the error leaves", async () => {
  const home = scratch();
  const bare = await bareHolder(home, 30, 0); // slot 0 held, so slot 1's admission reads MemAvailable
  const bad = path.join(scratch(), "meminfo");
  fs.writeFileSync(bad, "MemTotal:       16000000 kB\n");
  try {
    await assert.rejects(lockHeavy({
      home, limit: 2, meminfo: bad, waitMs: 0, statfs: statfsOf(1_000_000),
      record: { holder: "f5", host: HOST, kind: "run", pid: process.pid, job: "f5:1" },
    }), /no MemAvailable line in /);
    assert.equal(lockState(home, 1), "free", "heavy-1 is not left locked by this process");
    assert.ok(!fs.existsSync(infoPath(home, 1)));
  } finally {
    bare.kill();
  }
});

ttest("heavy acquire --pid: the named process is the holder's owner, and its death frees the lock to the next acquirer", async () => {
  const home = scratch();
  const p = liveSleeper();
  try {
    const a = await cli(["heavy", "acquire", "--holder", "session", "--pid", String(p.pid)], { home });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, new RegExp(`for pid ${p.pid}, freed when it exits\\)`));
    const holderPid = readInfo(home).pid;
    assert.equal((await cli(["heavy", "run", "--wait", "1", "--", "true"], { home })).code, 2);
    p.kill();
    const r = await cli(["heavy", "run", "--wait", "10", "--", "true"], { home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(gone(holderPid), "the holder let go and ended");
    assert.match(history(home), /release lock="heavy" holder="session" acquired_at="\S+" held="\S+"/);
  } finally {
    p.kill();
    stopHolders(home);
  }
});

ttest("heavy acquire stopped while it waits: its holder process gives up, and never takes the lock for nobody", async () => {
  const home = scratch();
  const bare = await bareHolder(home);
  try {
    const acq = start(["heavy", "acquire", "--holder", "late"], { home });
    await until(() => acq.err().includes("waiting"), "the acquire to wait");
    acq.child.kill("SIGKILL"); // no handler runs: the holder sees its IPC channel close
    await acq.done;
    bare.kill();
    await until(() => lockState(home) === "free", "the bare holder to go");
    await sleep(1500);
    assert.equal(lockState(home), "free", "the abandoned holder must not have taken it");
    assert.ok(!fs.existsSync(infoPath(home)));
  } finally {
    bare.kill();
    stopHolders(home);
  }
});

// ─── N slots: two heavy jobs at a time (Ethan's ruling, 2026-11-20) ────────

const TWO = { HARNESS_HEAVY_LIMIT: "2" };
// The most spans running at any one instant.
function maxConcurrent(spans) {
  const events = spans.flatMap((x) => [[x.s, 1], [x.e, -1]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let now = 0;
  let most = 0;
  for (const [, d] of events) most = Math.max(most, (now += d));
  return most;
}
// A command that prints, for each slot, flock(1)'s answer from a fresh open: 0 free, 200 held.
const probeSlots = (home, n = 2) => ["sh", "-c",
  [...Array(n).keys()].map((k) => `/usr/bin/flock -n -E 200 '${lockPath(home, k)}' true; echo "slot${k}=$?"`).join("; ")];

ttest("the limit is the host table's: 2 on ubuntu-pc, 1 on the OptiPlex and on a host not in it; HARNESS_HEAVY_LIMIT only beside the test home", () => {
  assert.equal(heavySettings({}, "ubuntu-pc").limit, 2);
  assert.equal(heavySettings({}, "bitcorn-harness").limit, 1);
  assert.equal(heavySettings({}, "some-laptop").limit, 1);
  assert.equal(heavySettings({ HARNESS_HEAVY_LIMIT: "5" }, "ubuntu-pc").limit, 2, "the test override is ignored without the test home");
  const t = heavySettings({ HARNESS_HEAVY_TEST_HOME: "/tmp/x", HARNESS_HEAVY_LIMIT: "1" }, "ubuntu-pc");
  assert.equal(t.limit, 1);
  assert.match(t.notes.join("\n"), /a TEST slot limit, 1 \(HARNESS_HEAVY_LIMIT\), not this host's 2/);
  const d = heavySettings({ HARNESS_HEAVY_TEST_MEMINFO: "/tmp/m" }, "ubuntu-pc");
  assert.deepEqual([d.minFreeMb, d.sharedWorkers, d.meminfo, d.notes], [4096, 3, "/proc/meminfo", []],
    "defaults: 4 GB, 3 workers, the real meminfo (its test seam ignored without the test home)");
  const s = heavySettings({ HARNESS_HEAVY_MIN_FREE_MB: "6000", HARNESS_HEAVY_SHARED_WORKERS: "2" }, "ubuntu-pc");
  assert.deepEqual([s.minFreeMb, s.sharedWorkers], [6000, 2]);
  assert.equal(s.notes.length, 2, "each setting away from its default is announced");
  assert.throws(() => heavySettings({ HARNESS_HEAVY_MIN_FREE_MB: "4GB" }, "ubuntu-pc"), /whole number/);
  assert.equal(heavyContext({}, { host: "bitcorn-harness", user: { username: "harnessagent", homedir: "/home/harnessagent" } }).limit, 1);
});

ttest("limit 2: two heavy jobs started together run at once, each in its own slot, and history names the slots", async () => {
  const home = scratch();
  const log = path.join(home, "jobs.log");
  const rs = await Promise.all(["a", "b"].map((n) => cli(["heavy", "run", "--holder", n, "--", ...loggedJob(log, n, 1500)], { home, env: TWO })));
  for (const r of rs) assert.equal(r.code, 0, r.stderr);
  const [x, y] = intervals(log);
  assert.ok(y.s < x.e, `they overlap: ${x.name} ${x.s}–${x.e}, ${y.name} ${y.s}–${y.e}`);
  const h = history(home);
  for (const k of [0, 1]) {
    assert.match(h, new RegExp(`acquire lock="${slotName(k)}" holder="[ab]"`), h);
    assert.match(h, new RegExp(`release lock="${slotName(k)}" holder="[ab]"`), h);
  }
  assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["free", "free"]);
});

ttest("limit 2: three started together — at most two run at once, and the third starts only once one has ended", async () => {
  const home = scratch();
  const log = path.join(home, "jobs.log");
  const rs = await Promise.all([["a", 1500], ["b", 1500], ["c", 500]].map(([n, ms]) =>
    cli(["heavy", "run", "--holder", n, "--", ...loggedJob(log, n, ms)], { home, env: TWO })));
  for (const r of rs) assert.equal(r.code, 0, r.stderr);
  const spans = intervals(log);
  console.log(spans.map((x) => `${x.name}: ${x.s}–${x.e}`).join("; "));
  assert.equal(maxConcurrent(spans), 2, "two overlap, never three");
  const [first, second, third] = spans;
  assert.ok(third.s >= Math.min(first.e, second.e), `the third (${third.name}) started at ${third.s}, before either of the first two ended`);
  const waiter = rs[["a", "b", "c"].indexOf(third.name)];
  assert.match(waiter.stderr, /heavy lock held by ".*" since .* \(heavy(?:-1)?\) and ".*" since .* \(heavy(?:-1)?\); waiting/);
});

ttest("memory: a second job waits while MemAvailable is under 4096 MB, and starts when it rises; the first, alone, is never checked", async () => {
  const home = scratch();
  const mem = meminfo(2000);
  const env = { ...TWO, HARNESS_HEAVY_TEST_MEMINFO: mem };
  const marker = path.join(home, "second-ran");
  const first = start(["heavy", "run", "--holder", "first", "--", "sleep", "30"], { home, env });
  let second = null;
  try {
    await until(() => first.err().includes("acquired the heavy lock"), "the first job, alone, under 2000 MB");
    second = start(["heavy", "run", "--holder", "second", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { home, env });
    await until(() => second.err().includes("waiting"), "the second job to wait");
    assert.match(second.err(), /heavy-1 is free, but MemAvailable is 2000 MB, under the 4096 MB a job sharing the machine needs, while heavy is held by "first"/);
    await sleep(1500);
    assert.ok(!fs.existsSync(marker), "the second job must not run under the threshold");
    assert.equal(lockState(home, 1), "free");
    meminfo(4096, mem);
    // Bounded, so a second job that never starts fails this test rather than holding the file open.
    await until(() => fs.existsSync(marker), "the second job to run once MemAvailable reached the threshold");
    const r = await second.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lockState(home, 0), "held", "while the first still ran");
  } finally {
    second?.child.kill("SIGTERM");
    first.child.kill("SIGTERM");
    await first.done;
  }
});

// ─── the disk floor (2026-11-23) ─────────────────────────────────────────

ttest("disk: the floor is 5120 MB by default; HARNESS_HEAVY_MIN_FREE_DISK_MB sets it, announced; its test seam only beside the test home", () => {
  const d = heavySettings({ HARNESS_HEAVY_TEST_DISKFREE: "/tmp/d" }, "ubuntu-pc");
  assert.equal(d.minFreeDiskMb, 5120);
  assert.equal(d.statfs, fs.statfsSync, "the real statfs: the test seam is ignored without the test home");
  assert.deepEqual(d.notes, []);
  const s = heavySettings({ HARNESS_HEAVY_MIN_FREE_DISK_MB: "8000" }, "ubuntu-pc");
  assert.equal(s.minFreeDiskMb, 8000);
  assert.match(s.notes.join("\n"), /every heavy job needs 8000 MB free disk \(HARNESS_HEAVY_MIN_FREE_DISK_MB\), not 5120/);
  assert.throws(() => heavySettings({ HARNESS_HEAVY_MIN_FREE_DISK_MB: "5GB" }, "ubuntu-pc"), /whole number/);
  const file = diskfree(1234);
  const t = heavySettings({ HARNESS_HEAVY_TEST_HOME: "/tmp/x", HARNESS_HEAVY_TEST_DISKFREE: file }, "ubuntu-pc");
  assert.deepEqual(diskFree(["/tmp"], { statfs: t.statfs }).map((f) => f.mb), [1234]);
  assert.match(t.notes.join("\n"), /a TEST free-disk figure/);
});

ttest("disk: diskFree names each filesystem once, by its mount point, with every path it holds; a read that fails throws", () => {
  const home = scratch(); // under os.tmpdir(): the same filesystem as /tmp here
  const fsys = diskFree(["/tmp", home], { statfs: statfsOf(777) });
  assert.equal(fsys.length, 1, JSON.stringify(fsys));
  assert.deepEqual(fsys[0].paths, ["/tmp", home]);
  assert.equal(fsys[0].mb, 777);
  const viaDf = spawnSync("df", ["--output=target", "/tmp"], { encoding: "utf8" });
  assert.equal(viaDf.status, 0, viaDf.stderr);
  assert.equal(fsys[0].mount, viaDf.stdout.trim().split("\n").at(-1).trim(), "the mount point df(1) gives");
  const real = diskFree(["/tmp"]);
  const viaDfFree = spawnSync("df", ["-B1", "--output=avail", "/tmp"], { encoding: "utf8" });
  assert.equal(viaDfFree.status, 0, viaDfFree.stderr);
  const dfMb = Math.floor(Number(viaDfFree.stdout.trim().split("\n").at(-1)) / (1024 * 1024));
  assert.ok(Math.abs(real[0].mb - dfMb) <= 64, `statfs says ${real[0].mb} MB, df(1) ${dfMb} MB`);
  assert.throws(() => diskFree(["/tmp"], { statfs: () => { throw new Error("EIO"); } }), /EIO/);
  assert.throws(() => diskFree(["/tmp"], { statfs: () => ({}) }), /gave no free space/);
});

ttest("disk: a FIRST job, alone, waits while free disk is under 5120 MB, naming the filesystem and its free space, and starts when it rises", async () => {
  const home = scratch();
  const disk = diskfree(3000);
  const marker = path.join(home, "ran");
  const job = start(["heavy", "run", "--holder", "first", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
    { home, env: { HARNESS_HEAVY_TEST_DISKFREE: disk } });
  try {
    await until(() => job.err().includes("waiting"), "the first job to wait");
    assert.match(job.err(),
      /the filesystem at \/\S* \(holding \/tmp and \/\S+\) has 3000 MB free, under the 5120 MB every heavy job needs \(HARNESS_HEAVY_MIN_FREE_DISK_MB\); waiting/);
    assert.doesNotMatch(job.err(), /while heavy is held/, "nothing holds heavy: the disk alone stops it");
    await sleep(1500);
    assert.ok(!fs.existsSync(marker), "the job must not run under the floor");
    assert.equal(lockState(home, 0), "free", "a waiter on disk holds no slot");
    diskfree(5120, disk);
    // Bounded, so a job that never starts fails this test rather than holding the file open.
    await until(() => fs.existsSync(marker), "the job to run once free disk reached the floor");
    const r = await job.done;
    assert.equal(r.code, 0, r.stderr);
  } finally {
    job.child.kill("SIGTERM");
  }
});

ttest("disk: a wait that runs out on disk exits 2 with the reason, the command not run", async () => {
  const home = scratch();
  const marker = path.join(home, "ran");
  const r = await cli(["heavy", "run", "--wait", "1", "--holder", "w", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
    { home, env: { HARNESS_HEAVY_TEST_DISKFREE: diskfree(10) } });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /heavy not admitted: the filesystem at \/\S* \(holding \/tmp and \/\S+\) has 10 MB free, under the 5120 MB/);
  assert.ok(!fs.existsSync(marker));
});

ttest("disk: a SECOND job waits on disk too, with memory to spare, and the message names the holder", async () => {
  const home = scratch();
  const bare = await bareHolder(home, 30, 0);
  try {
    let mb = 100;
    const said = [];
    const p = lockHeavy({
      home, limit: 2, meminfo: PLENTY, statfs: statfsOf(() => mb), waitMs: 10_000, pollMs: 100, say: (m) => said.push(m),
      record: { holder: "second", host: HOST, kind: "run", pid: process.pid, job: "second:1" },
    });
    await until(() => said.length > 0, "the second job to say why it waits");
    assert.match(said[0], /has 100 MB free, under the 5120 MB every heavy job needs .*, while heavy is held by .*\(heavy\); waiting/);
    assert.equal(lockState(home, 1), "free");
    mb = 6000;
    const r = await p;
    assert.ok(r.hold, r.message);
    assert.deepEqual(r.hold.slots, [1]);
    assert.equal(r.hold.shared, true);
    r.hold.release();
  } finally {
    bare.kill();
  }
});

ttest("disk: an exclusive job is refused too, and a wait that runs out leaves no slot held; a statfs that fails rejects, no slot held", async () => {
  const home = scratch();
  const record = { holder: "x", host: HOST, kind: "run", pid: process.pid, job: "x:1" };
  const r = await lockHeavy({ home, limit: 2, exclusive: true, meminfo: PLENTY, statfs: statfsOf(5119), waitMs: 300, pollMs: 100, record });
  assert.equal(r.hold, null);
  assert.match(r.message, /heavy not admitted: the filesystem at .* has 5119 MB free, under the 5120 MB/);
  assert.match(r.notRun, /has 5119 MB free/);
  assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["free", "free"]);
  await assert.rejects(lockHeavy({ home, limit: 2, meminfo: PLENTY, statfs: () => { throw new Error("statfs EIO"); }, waitMs: 0, record }), /statfs EIO/);
  assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["free", "free"]);
  const ok = await lockHeavy({ home, limit: 2, exclusive: true, meminfo: PLENTY, statfs: statfsOf(5120), waitMs: 0, record });
  assert.ok(ok.hold, ok.message);
  assert.deepEqual(ok.hold.slots, [0, 1], "at the floor exactly, admitted");
  ok.hold.release();
});

ttest("a crash of either job frees exactly its own slot", async () => {
  for (const victim of [0, 1]) {
    const home = scratch();
    const runs = [];
    try {
      for (const n of ["a", "b"]) {
        const run = start(["heavy", "run", "--holder", n, "--", "sleep", "30"], { home, env: TWO });
        runs.push(run);
        await until(() => run.err().includes("acquired the heavy lock"), `job ${n}`);
      }
      assert.deepEqual([readInfo(home, 0).holder, readInfo(home, 1).holder], ["a", "b"]);
      const info = readInfo(home, victim);
      runs[victim].child.kill("SIGKILL");
      process.kill(-info.pgid, "SIGKILL"); // the OOM killer's view: no finally runs
      await runs[victim].done;
      await until(() => lockState(home, victim) === "free", `${slotName(victim)} to free`);
      const other = 1 - victim;
      assert.equal(lockState(home, other), "held", `${slotName(other)} stays with its live job`);
      assert.equal(readInfo(home, other).holder, ["a", "b"][other]);
    } finally {
      for (const run of runs) run.child.kill("SIGTERM");
      await Promise.all(runs.map((run) => run.done));
    }
  }
});

ttest("a token holds one slot: a heavy run nested under it never takes the second, even with it free", async () => {
  const home = scratch();
  const r = await cli(["heavy", "run", "--holder", "outer", "--", NODE, SCRIPT, "heavy", "run", "--", ...probeSlots(home)], { home, env: TWO });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /already held by this job \("outer"\); running without acquiring again/);
  assert.match(r.stdout, /^slot0=200\nslot1=0$/m, "heavy is the outer job's, heavy-1 stays free");
  assert.equal((history(home).match(/ acquire /g) ?? []).length, 1, history(home));
  assert.doesNotMatch(history(home), /heavy-1/);
});

ttest("on a host with limit 1 the second job waits, with the second slot never touched", async () => {
  const home = scratch();
  const first = start(["heavy", "run", "--holder", "first", "--", "sleep", "30"], { home, env: { HARNESS_HEAVY_LIMIT: "1" } });
  try {
    await until(() => first.err().includes("acquired the heavy lock"), "the first job");
    const r = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home, env: { HARNESS_HEAVY_LIMIT: "1" } });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy is already locked by "first" since .* \(heavy\); waited 1s; the command was not run/);
    assert.ok(!fs.existsSync(lockPath(home, 1)), "no heavy-1.lock under limit 1");
  } finally {
    first.child.kill("SIGTERM");
    await first.done;
  }
});

ttest("exclusive: waits while one slot is held, lets go of what it took if the wait runs out, then takes every slot", async () => {
  const home = scratch();
  const marker = path.join(home, "ran");
  const bare = await bareHolder(home, 30, 1);
  try {
    const r = await cli(["heavy", "run", "--exclusive", "--wait", "1", "--", NODE, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
      { home, env: TWO });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy is already locked by a holder that names none .* \(heavy-1\); waited 1s; the command was not run/);
    assert.ok(!fs.existsSync(marker), "the command must not run");
    assert.equal(lockState(home, 0), "free", "the slot it held while waiting is let go");
    assert.ok(!fs.existsSync(infoPath(home, 0)), "and its record with it");
    const ex = start(["heavy", "run", "--exclusive", "--holder", "ex", "--", ...probeSlots(home)], { home, env: TWO });
    await until(() => ex.err().includes("for every slot (exclusive)"), "the exclusive job to wait");
    assert.equal(lockState(home, 0), "held", "it holds heavy while it waits for heavy-1");
    bare.kill();
    const done = await ex.done;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /slot0=200\nslot1=200/, "its command holds both slots");
    assert.match(done.stderr, /acquired the heavy lock \(heavy, heavy-1\) for "ex"/);
    const h = history(home);
    for (const k of [0, 1]) assert.match(h, new RegExp(`acquire lock="${slotName(k)}" holder="ex" .* exclusive=true`), h);
    assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["free", "free"]);
  } finally {
    bare.kill();
  }
});

ttest("exclusive: a normal job waits while an exclusive job holds every slot; heavy acquire --exclusive holds and releases both", async () => {
  const home = scratch();
  const ex = start(["heavy", "run", "--exclusive", "--holder", "ex", "--", "sleep", "30"], { home, env: TWO });
  try {
    await until(() => ex.err().includes("acquired the heavy lock"), "the exclusive job");
    assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["held", "held"], "it holds both slots");
    const r = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home, env: TWO });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /heavy is already locked by "ex" \(exclusive\) since .* \(heavy\) and "ex" \(exclusive\) since .* \(heavy-1\)/);
  } finally {
    ex.child.kill("SIGTERM");
    await ex.done;
  }
  try {
    const a = await cli(["heavy", "acquire", "--exclusive", "--holder", "gate"], { home, env: TWO });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /acquired heavy for gate: \S+heavy\.lock, \S+heavy-1\.lock \(held by pid \d+/);
    assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["held", "held"]);
    const rel = await cli(["heavy", "release", "--holder", "gate"], { home, env: TWO });
    assert.equal(rel.code, 0, rel.stderr);
    assert.match(rel.stdout, /^harness lock released: heavy, holder gate,.*\nharness lock released: heavy-1, holder gate,/m);
    assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["free", "free"]);
  } finally {
    stopHolders(home);
  }
});

ttest("the worker cap: a job that shares the machine gets VITEST_MAX_WORKERS=3, a job alone gets none", async () => {
  const home = scratch();
  const show = ["sh", "-c", 'echo "workers=${VITEST_MAX_WORKERS-none}"'];
  const solo = await cli(["heavy", "run", "--", ...show], { home, env: TWO });
  assert.equal(solo.code, 0, solo.stderr);
  assert.match(solo.stdout, /^workers=none$/m);
  const first = start(["heavy", "run", "--holder", "first", "--", "sleep", "30"], { home, env: TWO });
  try {
    await until(() => first.err().includes("acquired the heavy lock"), "the first job");
    const second = await cli(["heavy", "run", "--", ...show], { home, env: TWO });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^workers=3$/m);
    assert.match(second.stderr, /sharing the machine, so VITEST_MAX_WORKERS=3/);
    assert.match(history(home), /acquire lock="heavy-1" .* shared=true/);
    const acq = await cli(["heavy", "acquire", "--holder", "acq"], { home, env: TWO });
    assert.equal(acq.code, 0, acq.stderr);
    assert.match(acq.stdout, /^VITEST_MAX_WORKERS=3$/m, "heavy acquire prints it for its caller to set");
  } finally {
    stopHolders(home);
    first.child.kill("SIGTERM");
    await first.done;
  }
});

ttest("two holders: status lists each slot; release frees only the named holder's slot and refuses another's; --force takes --slot", async () => {
  const home = scratch();
  try {
    for (const n of ["a", "b"]) assert.equal((await cli(["heavy", "acquire", "--holder", n], { home, env: TWO })).code, 0);
    const status = (await cli(["heavy", "status"], { home, env: TWO })).stdout;
    assert.match(status, /^heavy \S+heavy\.lock: held by "a" since \S+ on \S+, pid \d+ running\nheavy-1 \S+heavy-1\.lock: held by "b" since/, status);
    const wrong = await cli(["heavy", "release", "--holder", "c"], { home, env: TWO });
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /heavy is held by "a" since \S+ \(heavy\) and "b" since \S+ \(heavy-1\), not "c"/);
    const rel = await cli(["heavy", "release", "--holder", "b"], { home, env: TWO });
    assert.equal(rel.code, 0, rel.stderr);
    assert.deepEqual([lockState(home, 0), lockState(home, 1)], ["held", "free"], "only b's slot");
    const forced = await cli(["heavy", "release", "--force", "--reason", "test", "--slot", "0"], { home, env: TWO });
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /FORCE-released: heavy, was held by a/);
    assert.equal(lockState(home, 0), "free");
  } finally {
    stopHolders(home);
  }
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
    // The wrapper never sends itself SIGUSR1 (or SIGPIPE): SIGUSR1 starts Node's inspector,
    // whose start aborted Node 20 now and then (exit 134), and which says so on stderr.
    assert.doesNotMatch(r.stderr, /Debugger listening|inspector/i, `SIG${sig}: the wrapper must not start Node's inspector`);
    await until(() => lockState(home) === "free", `SIG${sig}: the lock free`, 5000);
  }
});
