#!/usr/bin/env node
// harness-slot-heavy.test.mjs — node:test suite for the heavy lock in
// scripts/harness-slot.mjs (decision H1–H7, 2026-11-18, as amended by A1–A4).
//
// Run the Node 20 binary by its path, not whatever `node` is first on PATH:
//   ~/.nvm/versions/node/v20.20.2/bin/node --test scripts/harness-slot-heavy.test.mjs
//
// Every lock here lives in a scratch home (HARNESS_HEAVY_TEST_HOME), never the
// account's real heavy.lock, with one exception that takes no lock: the
// scratch-$HOME control reads `heavy status`, which only prints the path.
// The processes are real: wrappers, their commands, their process groups,
// SIGTERM and SIGKILL. The pid-reuse control cannot make the kernel reuse a
// pid, so it records a live, unrelated process's pid with a start time that
// process does not have — what a reused pid looks like to the lock.
//
// Linux only (/proc). The account check passes on ubuntu-pc as user and on the
// OptiPlex as harnessagent; anywhere else the CLI controls are refused, loudly.
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
  HEAVY_ACCOUNTS,
  bootId,
  heavyAccountRefusal,
  heavyContext,
  procStart,
  provablyDead,
} from "./harness-slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "harness-slot.mjs");
const NODE = process.execPath;
const HOST = os.hostname();
const BOOT = bootId();
// bitcorn-workflow tests/browser-slot.py:113 keeps waiting only while the
// refusal matches this; anything else fails it at once.
const WORKFLOW_WAIT = /is already locked by |refused: setup\.lock is held by /;

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "heavy-test-"));
const lockPath = (home) => path.join(home, ".bitcorn-dev", "locks", "heavy.lock");
const historyPath = (home) => path.join(home, ".bitcorn-dev", "locks", "history.log");
const history = (home) => (fs.existsSync(historyPath(home)) ? fs.readFileSync(historyPath(home), "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every test is bounded, so a broken lock fails a test instead of hanging the file.
const ttest = (name, fn) => test(name, { timeout: 60_000 }, fn);

// The CLI under Node 20, its environment built from scratch: no inherited $HOME.
function start(args, { home, env = {}, slotHome } = {}) {
  const child = spawn(NODE, [SCRIPT, ...args], {
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

const readLockJson = (home) => JSON.parse(fs.readFileSync(lockPath(home), "utf8"));
const writeLockJson = (home, lock) => {
  fs.mkdirSync(path.dirname(lockPath(home)), { recursive: true });
  fs.writeFileSync(lockPath(home), `${JSON.stringify(lock, null, 2)}\n`);
};
const deadPid = () => spawnSync("true").pid; // exited and reaped by the time this returns
function liveSleeper() {
  const p = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  p.unref(); // a failed assertion must not leave the test file waiting on it
  return { pid: p.pid, start: procStart(p.pid), kill: () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} } };
}
const fixture = (over = {}) => ({
  holder: "fixture", acquired_at: "2026-11-18T12:00:00Z", host: HOST, slot: "heavy", boot_id: BOOT, ...over,
});

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
    assert.ok(!fs.existsSync(lockPath(home)), "a refused account takes no lock");
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
  const job = (name) => [NODE, "-e",
    `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${name} "+Date.now()+"\\n");` +
    `setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"end ${name} "+Date.now()+"\\n"),1500)`];
  const [a, b] = await Promise.all([cli(["heavy", "run", "--", ...job("a")], { home }), cli(["heavy", "run", "--", ...job("b")], { home })]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const t = {};
  for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
    const [what, name, at] = line.split(" ");
    t[`${what}-${name}`] = Number(at);
  }
  const [first, second] = t["start-a"] < t["start-b"] ? ["a", "b"] : ["b", "a"];
  console.log(`first ${first}: ${t[`start-${first}`]}–${t[`end-${first}`]}; second ${second}: ${t[`start-${second}`]}–${t[`end-${second}`]}`);
  assert.ok(t[`end-${first}`] <= t[`start-${second}`], "the second job started before the first ended");
  const waiter = first === "a" ? b : a;
  // The holder is JSON-quoted and may itself hold escaped quotes, so match loosely.
  assert.match(waiter.stderr, /heavy lock held by ".*" since \S+ on \S+, pid \d+ running; waiting/);
  const kinds = history(home).trim().split("\n").map((l) => l.split(" ")[1]);
  assert.deepEqual(kinds, ["acquire", "release", "acquire", "release"]);
  assert.ok(!fs.existsSync(lockPath(home)));
});

// ─── A2: released on success, failure and signals ──────────────────────────

ttest("released on success and on failure; the command's exit code is the wrapper's", async () => {
  const home = scratch();
  for (const code of [0, 7]) {
    const r = await cli(["heavy", "run", "--", NODE, "-e", `process.exit(${code})`], { home });
    assert.equal(r.code, code, r.stderr);
    assert.match(r.stderr, /harness lock released: heavy, holder [^,]+, held .* on \S+$/m);
    assert.doesNotMatch(r.stderr, /; go /, "heavy has no go");
    assert.ok(!fs.existsSync(lockPath(home)));
  }
  assert.match(history(home), new RegExp(`acquire lock="heavy" holder="${os.userInfo().username}@${HOST}:${NODE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} -e`));
});

ttest("SIGTERM to the wrapper reaches the command, and the lock is released", async () => {
  const home = scratch();
  const run = start(["heavy", "run", "--", "sleep", "30"], { home });
  await until(() => run.err().includes("acquired the heavy lock"), "the lock");
  run.child.kill("SIGTERM");
  const r = await run.done;
  assert.equal(r.signal, "SIGTERM", r.stderr);
  assert.match(r.stderr, /harness lock released: heavy/);
  assert.ok(!fs.existsSync(lockPath(home)));
});

ttest("SIGKILL of the wrapper AND its command: the lock stays, and the next acquirer takes over from the provably dead holder", async () => {
  const home = scratch();
  const run = start(["heavy", "run", "--", "sleep", "30"], { home });
  await until(() => run.err().includes("acquired the heavy lock"), "the lock");
  const lock = readLockJson(home);
  assert.equal(lock.pid, run.child.pid);
  run.child.kill("SIGKILL");
  process.kill(-lock.pgid, "SIGKILL"); // the OOM killer's view: everything gone, no finally run
  await run.done;
  await until(() => procStart(lock.pgid) === null, "the command to be gone");
  assert.ok(fs.existsSync(lockPath(home)), "a SIGKILLed holder cannot release");
  const next = await cli(["heavy", "run", "--wait", "10", "--", "true"], { home });
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stderr, /took over the heavy lock/);
  assert.match(history(home), new RegExp(`take-over lock="heavy" holder="[^"]+" acquired_at="[^"]+" pid=${lock.pid} ` +
    `reason="no process ${lock.pid} runs, and process group ${lock.pgid} has no member"`));
});

ttest("SIGKILL of the wrapper ALONE: its command still runs, so the lock is waited on, not taken over — until the command ends", async () => {
  const home = scratch();
  const run = start(["heavy", "run", "--", "sleep", "30"], { home });
  await until(() => run.err().includes("acquired the heavy lock"), "the lock");
  const lock = readLockJson(home);
  run.child.kill("SIGKILL");
  await run.done;
  assert.ok(procStart(lock.pgid) !== null, "the command outlives its wrapper");
  const blocked = await cli(["heavy", "run", "--wait", "2", "--", "true"], { home });
  assert.equal(blocked.code, 2, blocked.stderr);
  assert.match(blocked.stderr, /heavy is already locked by .*pid \d+ gone but its command \(process group \d+\) still running/);
  assert.match(blocked.stderr, /the command was not run/);
  assert.doesNotMatch(history(home), /take-over/);
  process.kill(-lock.pgid, "SIGKILL");
  await until(() => procStart(lock.pgid) === null, "the command to be gone");
  const next = await cli(["heavy", "run", "--wait", "10", "--", "true"], { home });
  assert.equal(next.code, 0, next.stderr);
  assert.match(history(home), /take-over lock="heavy"/);
});

// ─── A2: what counts as provably dead ─────────────────────────────────────

ttest("a reused pid (live, but with another start time) is not mistaken for the holder: taken over", async () => {
  const home = scratch();
  const other = liveSleeper();
  try {
    assert.notEqual(other.start, "1");
    writeLockJson(home, fixture({ pid: other.pid, pid_start: "1", pgid: deadPid() }));
    const r = await cli(["heavy", "run", "--wait", "5", "--", "true"], { home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(history(home), new RegExp(`take-over .* reason="pid ${other.pid} is another process \\(started at tick ${other.start}, the holder at 1\\)`));
  } finally {
    other.kill();
  }
});

ttest("a live holder (pid AND start time match) is waited on and reported, never taken over — whatever its group", async () => {
  const holder = liveSleeper();
  try {
    // Its own group alive; the group it names empty; no group named (a --pid holder).
    // The pid check alone must hold the last two: the group check cannot.
    for (const [what, pgid] of [["group alive", holder.pid], ["group empty", deadPid()], ["no group", undefined]]) {
      const home = scratch();
      writeLockJson(home, fixture({ pid: holder.pid, pid_start: holder.start, pgid }));
      const before = fs.readFileSync(lockPath(home), "utf8");
      const r = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
      assert.equal(r.code, 2, `${what}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`heavy is already locked by "fixture" since 2026-11-18T12:00:00Z .*pid ${holder.pid} running`), what);
      assert.equal(fs.readFileSync(lockPath(home), "utf8"), before, what);
      assert.doesNotMatch(history(home), /take-over/, what);
    }
  } finally {
    holder.kill();
  }
});

ttest("not provable is waited on: another host, no pid, an unreadable lock", async () => {
  for (const [what, write] of [
    ["another host", (home) => writeLockJson(home, fixture({ host: "elsewhere", pid: deadPid(), pid_start: "1" }))],
    ["no pid", (home) => writeLockJson(home, fixture())],
    ["unreadable", (home) => { fs.mkdirSync(path.dirname(lockPath(home)), { recursive: true }); fs.writeFileSync(lockPath(home), "{half"); }],
  ]) {
    const home = scratch();
    write(home);
    const r = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
    assert.equal(r.code, 2, `${what}: ${r.stderr}`);
    assert.match(r.stderr, /is already locked by/, what);
    assert.ok(fs.existsSync(lockPath(home)), `${what}: the lock must stay`);
  }
});

ttest("provablyDead, case by case", () => {
  const alive = (pid) => (pid === 100 ? "500" : null);
  const ctx = { host: "h", boot: "b", start: alive, group: (g) => g === 200 };
  const lock = { host: "h", boot_id: "b", pid: 100, pid_start: "500", pgid: 300 };
  assert.equal(provablyDead(lock, ctx), null, "running");
  assert.match(provablyDead({ ...lock, pid: 101 }, ctx), /^no process 101 runs, and process group 300 has no member$/);
  assert.match(provablyDead({ ...lock, pid_start: "499" }, ctx), /^pid 100 is another process/);
  assert.equal(provablyDead({ ...lock, pid: 101, pgid: 200 }, ctx), null, "wrapper dead, command's group alive");
  assert.match(provablyDead({ ...lock, pid: 101, pgid: undefined }, ctx), /^no process 101 runs$/, "--pid holder: no group");
  assert.match(provablyDead({ ...lock, boot_id: "a" }, ctx), /booted since/);
  assert.equal(provablyDead({ ...lock, host: "g" }, ctx), null, "another host");
  assert.equal(provablyDead({ ...lock, pid: undefined }, ctx), null, "no pid");
  assert.equal(provablyDead({ ...lock, pid_start: undefined }, ctx), null, "no start time");
  assert.equal(provablyDead({ ...lock, pgid: 1 }, ctx), null, "pgid 1 would ask about every process");
  assert.equal(provablyDead({ unreadable: true }, ctx), null);
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
  assert.ok(!fs.existsSync(lockPath(home)), "heavy is released when its slot part fails");

  // The same under a Polar setup window.
  assert.equal((await cli(["lock", "release", "--slot", "1", "--holder", "other-arc"], { home, slotHome })).code, 0);
  assert.equal((await cli(["lock", "acquire", "--setup", "--holder", "polar", "--go", "test"], { home, slotHome })).code, 0);
  const s = await cli(["heavy", "run", "--", NODE, SCRIPT, "lock", "acquire", "--slot", "1", "--holder", "me", "--go", "test"], { home, slotHome });
  assert.equal(s.code, 2, s.stderr);
  const setupRefusal = s.stderr.split("\n").find((l) => l.includes("slot 1 refused"));
  assert.match(setupRefusal, /never waits for a slot; a Polar setup window holds setup\.lock \(holder "polar"\)/);
  assert.doesNotMatch(setupRefusal, WORKFLOW_WAIT);
});

ttest("A3: under the heavy lock, a free slot is taken as usual", async () => {
  const home = scratch();
  const slotHome = scratch();
  const r = await cli(["heavy", "run", "--", NODE, SCRIPT, "lock", "acquire", "--slot", "1", "--holder", "me", "--go", "test"], { home, slotHome });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /acquired slot 1 for me/);
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

ttest("heavy acquire / release, for callers that cannot wrap: no pid means no take-over, only a release", async () => {
  const home = scratch();
  const a = await cli(["heavy", "acquire", "--holder", "polar-gate"], { home });
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /no pid: freed only by heavy release, or --force --reason/);
  const blocked = await cli(["heavy", "run", "--wait", "1", "--", "true"], { home });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /no pid recorded/);
  const wrong = await cli(["heavy", "release", "--holder", "someone-else"], { home });
  assert.equal(wrong.code, 2);
  const rel = await cli(["heavy", "release", "--holder", "polar-gate"], { home });
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /^harness lock released: heavy, holder polar-gate, held .* on \S+$/m);

  const gone = await cli(["heavy", "acquire", "--holder", "x", "--pid", String(deadPid())], { home });
  assert.equal(gone.code, 2);
  assert.match(gone.stderr, /no such running process/);

  assert.equal((await cli(["heavy", "acquire", "--holder", "stuck"], { home })).code, 0);
  const forced = await cli(["heavy", "release", "--force", "--reason", "test"], { home });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(history(home), /force-release lock="heavy" holder="stuck"/);
});

ttest("heavy acquire --pid: the named process is the holder, and its death frees the lock to the next acquirer", async () => {
  const home = scratch();
  const p = liveSleeper();
  try {
    const a = await cli(["heavy", "acquire", "--holder", "session", "--pid", String(p.pid)], { home });
    assert.equal(a.code, 0, a.stderr);
    assert.equal((await cli(["heavy", "run", "--wait", "1", "--", "true"], { home })).code, 2);
  } finally {
    p.kill();
  }
  await until(() => procStart(p.pid) === null, "the holder to die");
  const r = await cli(["heavy", "run", "--wait", "10", "--", "true"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(history(home), new RegExp(`take-over lock="heavy" holder="session" .*reason="no process ${p.pid} runs"`));
});
