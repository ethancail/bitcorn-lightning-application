#!/usr/bin/env node
// polar-preflight.test.mjs — node:test suite for scripts/polar-preflight.mjs.
//
// Run the Node 20 binary by its path, not whatever `node` is first on PATH:
//   ~/.nvm/versions/node/v20.20.2/bin/node --test scripts/polar-preflight.test.mjs
// (npx and npm are out: both re-resolve `node` from PATH. A test below fails if
// the running major differs from .nvmrc.)
//
// No harness is touched. Every probe is the fake below, and every run asserts:
//   - no docker call was unplanned. The script reads a rejection as CANNOT-LOOK,
//     so a stray write would otherwise pass quietly;
//   - no call carries a forbidden verb, so "no other write" (spec (d)) is held
//     across every scenario rather than in one dedicated test.
//
// No CI job runs this, and the Stop hook does not watch scripts/. Run it by hand.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTAINERS,
  LND_NODES,
  resolveExit,
  runCommand,
  runPreflight,
} from "./polar-preflight.mjs";

const SCRIPT = fileURLToPath(new URL("./polar-preflight.mjs", import.meta.url));
const ROOT = path.resolve(path.dirname(SCRIPT), "..");

// ─── fixtures ─────────────────────────────────────────────────────────────

const HEIGHT = 11769;
const HASH = "09".repeat(32);
const PUB = {
  Treasury: "02" + "aa".repeat(32),
  Merchant1: "03" + "bb".repeat(32),
  Farmer1: "02" + "cc".repeat(32),
  "External-Peer-1": "02" + "dd".repeat(32),
};
const STRANGER = "03" + "ee".repeat(32);
const SPOKES = ["Merchant1", "Farmer1", "External-Peer-1"];
const SPOKE_KEYS = SPOKES.map((n) => PUB[n]);
const ALL_NODES = ["Treasury", ...SPOKES];

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
const bad = (stderr, code = 1) => ({ code, stdout: "", stderr });

const listOut = (names = CONTAINERS) =>
  ok(names.map((n) => JSON.stringify(n)).join("\n") + "\n");
const inspectOut = (names = CONTAINERS, overrides = {}) =>
  ok(JSON.stringify(names.map((n) => ({
    Name: `/${n}`,
    State: { Status: "running" },
    RestartCount: 0,
    ...overrides[n],
  }))));
const chainOut = (overrides = {}) =>
  ok(JSON.stringify({
    blocks: HEIGHT,
    headers: HEIGHT,
    bestblockhash: HASH,
    initialblockdownload: false,
    ...overrides,
  }));
const getinfoOut = (name, overrides = {}) =>
  ok(JSON.stringify({
    identity_pubkey: PUB[name],
    alias: name,
    synced_to_chain: true,
    block_height: HEIGHT,
    block_hash: HASH,
    ...overrides,
  }));
const staleOut = (name, overrides = {}) => getinfoOut(name, { synced_to_chain: false, ...overrides });
const peersOut = (keys = SPOKE_KEYS) =>
  ok(JSON.stringify({ peers: keys.map((pub_key) => ({ pub_key })) }));
const channelsOut = (keys = SPOKE_KEYS) =>
  ok(JSON.stringify({ channels: keys.map((remote_pubkey) => ({ active: true, remote_pubkey })) }));

const lncli = (name, ...rest) =>
  `exec -u lnd polar-n1-${name} lncli --network regtest ${rest.join(" ")}`;
const K = {
  version: "version --format {{json .Server.Version}}",
  context: "context show",
  list: "ps -a --filter name=^polar-n1- --format {{json .Names}}",
  inspect: `inspect ${CONTAINERS.join(" ")}`,
  chain: "exec -u bitcoin polar-n1-backend1 bitcoin-cli -regtest getblockchaininfo",
  mine: 'exec -u bitcoin polar-n1-backend1 bitcoin-cli -regtest generatetodescriptor 1 raw(6a)',
  getinfo: (name) => lncli(name, "getinfo"),
  peers: lncli("Treasury", "listpeers"),
  channels: lncli("Treasury", "listchannels", "--active_only"),
  connect: (name) => lncli("Treasury", "connect", `${PUB[name]}@${name}:9735`),
};

const healthy = () => ({
  [K.version]: ok('"29.9.1"\n'),
  [K.context]: ok("default\n"),
  [K.list]: listOut(),
  [K.inspect]: inspectOut(),
  [K.chain]: chainOut(),
  ...Object.fromEntries(ALL_NODES.map((n) => [K.getinfo(n), getinfoOut(n)])),
  [K.peers]: peersOut(),
  [K.channels]: channelsOut(),
});

const allStale = () =>
  Object.fromEntries(ALL_NODES.map((n) => [K.getinfo(n), staleOut(n)]));
const staleThenSynced = () =>
  Object.fromEntries(ALL_NODES.map((n) => [K.getinfo(n), [staleOut(n), getinfoOut(n)]]));

const COMPOSE = `name: polar-network-1
services:
  backend1:
    image: polarlightning/bitcoind:30.0
    container_name: polar-n1-backend1
    command: >-
      bitcoind -server=1 -regtest=1
    restart: unless-stopped
    volumes:
      - ./volumes/bitcoind/backend1:/home/bitcoin/.bitcoin
  Farmer1:
    container_name: polar-n1-Farmer1
    restart: always
  Treasury:
    container_name: polar-n1-Treasury
    restart: always
`;

const QUIET_PS = [
  "      1 /sbin/init splash",
  "2296895 lnd --noseedbackup --alias=Treasury --bitcoind.rpchost=polar-n1-backend1",
  "2296963 bitcoind -server=1 -regtest=1",
].join("\n") + "\n";

const CHECKS = [
  "docker-endpoint",
  "containers",
  "polar-not-running",
  "compose-restart-policy",
  "restart-counts-steady",
  "bitcoind",
  ...ALL_NODES.map((n) => `synced-to-chain:${n}`),
  "treasury-peers",
  "treasury-channels",
];

const FORBIDDEN_DOCKER_VERBS = new Set([
  "restart", "stop", "start", "update", "kill", "rm", "down", "up", "compose", "logs",
]);
const FORBIDDEN_LNCLI_VERBS = ["disconnect", "openchannel", "closechannel", "closeallchannels"];

// ─── the fake and its runner ──────────────────────────────────────────────

async function run(overrides = {}, options = {}) {
  const responses = { ...healthy(), ...overrides };
  const cursor = new Map();
  const calls = [];
  const unplanned = [];
  const sleeps = [];
  const composeReads = [];
  const lines = [];

  const docker = async (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (!(key in responses)) {
      unplanned.push(key);
      throw new Error(`unplanned docker call: ${key}`);
    }
    const entry = responses[key];
    const sequence = Array.isArray(entry) ? entry : [entry];
    const i = cursor.get(key) ?? 0;
    cursor.set(key, i + 1);
    const response = sequence[Math.min(i, sequence.length - 1)];
    if (response instanceof Error) throw response;
    return response;
  };
  const ps = async () => {
    const response = options.ps ?? ok(QUIET_PS);
    if (response instanceof Error) throw response;
    return response;
  };
  const readCompose = async (file) => {
    composeReads.push(file);
    const text = options.compose ?? COMPOSE;
    if (text instanceof Error) throw text;
    return text;
  };

  const { exitCode } = await runPreflight({
    docker,
    ps,
    readCompose,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => new Date("2026-10-30T16:00:00.000Z"),
    print: (line) => lines.push(line),
    env: options.env ?? {},
    repair: options.repair ?? false,
  });

  assert.deepEqual(unplanned, [], "the script made a docker call the scenario did not plan");
  for (const args of calls) {
    assert.ok(!FORBIDDEN_DOCKER_VERBS.has(args[0]), `forbidden docker verb: ${args.join(" ")}`);
    for (const verb of FORBIDDEN_LNCLI_VERBS) {
      assert.ok(!args.includes(verb), `forbidden lncli verb: ${args.join(" ")}`);
    }
  }

  return { exitCode, lines, calls, sleeps, composeReads };
}

function statusOf(lines, name) {
  const found = lines
    .map((l) => l.match(/^\S+ (PASS|FAIL|REPAIRED|CANNOT-LOOK) (\S+)(?: |$)/))
    .filter((m) => m && m[2] === name);
  assert.equal(found.length, 1, `expected exactly one line for ${name}, got:\n${lines.join("\n")}`);
  return found[0][1];
}

const lineOf = (lines, name) => lines.find((l) => l.split(" ")[2] === name);
const mineCalls = (calls) => calls.filter((a) => a.includes("generatetodescriptor"));
const connectCalls = (calls) => calls.filter((a) => a.includes("connect"));
const passLines = (lines) => lines.filter((l) => l.split(" ")[1] === "PASS");

// ─── (a) language and mechanism ───────────────────────────────────────────

test("(a) source: execFile with no shell, no socket path, no jq", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /execFile\(/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /docker\.sock/);
  assert.doesNotMatch(source, /\bjq\b/);
});

test("(a) runCommand: a non-zero exit resolves with its code", async () => {
  const r = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(r.code, 3);
});

test("(a) runCommand: a missing binary rejects", async () => {
  await assert.rejects(runCommand("/nonexistent/polar-preflight-binary", []));
});

test("(e) runCommand: the child inherits this process's environment, so DOCKER_HOST reaches docker", async () => {
  process.env.POLAR_PREFLIGHT_PROBE = "inherited";
  try {
    const r = await runCommand(process.execPath, ["-p", "process.env.POLAR_PREFLIGHT_PROBE"]);
    assert.equal(r.stdout.trim(), "inherited");
  } finally {
    delete process.env.POLAR_PREFLIGHT_PROBE;
  }
});

test("(a) cli: an unknown flag exits 2 and runs nothing", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--repiar"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--repiar/);
});

// ─── (b) the expected set ─────────────────────────────────────────────────

test("(b) the pinned set is the five containers and four LND nodes from the live compose", () => {
  assert.deepEqual(CONTAINERS, [
    "polar-n1-backend1",
    "polar-n1-Treasury",
    "polar-n1-Merchant1",
    "polar-n1-Farmer1",
    "polar-n1-External-Peer-1",
  ]);
  assert.deepEqual(LND_NODES.map((n) => n.host), ALL_NODES);
});

test("(b) healthy harness: one PASS per check, exit 0, no write", async () => {
  const { exitCode, lines, calls } = await run();
  assert.equal(exitCode, 0);
  for (const name of CHECKS) assert.equal(statusOf(lines, name), "PASS");
  assert.equal(lines.length, CHECKS.length + 1);
  assert.deepEqual(mineCalls(calls), []);
  assert.deepEqual(connectCalls(calls), []);
});

test("peers: missing expected peer is FAIL", async () => {
  const { exitCode, lines } = await run({ [K.peers]: peersOut(SPOKE_KEYS.slice(0, 2)) });
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.match(lineOf(lines, "treasury-peers"), /External-Peer-1/);
  assert.equal(exitCode, 1);
});

test("peers: extra unexpected peer is FAIL", async () => {
  const { exitCode, lines } = await run({ [K.peers]: peersOut([...SPOKE_KEYS, STRANGER]) });
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.match(lineOf(lines, "treasury-peers"), new RegExp(STRANGER));
  assert.equal(exitCode, 1);
});

test("peers: right count, wrong member is FAIL", async () => {
  const swapped = [PUB.Merchant1, PUB.Farmer1, STRANGER];
  const { exitCode, lines } = await run({ [K.peers]: peersOut(swapped) });
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.equal(exitCode, 1);
});

test("channels: 2 active is FAIL", async () => {
  const { exitCode, lines } = await run({ [K.channels]: channelsOut(SPOKE_KEYS.slice(0, 2)) });
  assert.equal(statusOf(lines, "treasury-channels"), "FAIL");
  assert.equal(exitCode, 1);
});

test("channels: 3 active, two to Farmer1, is FAIL", async () => {
  const twoToFarmer = [PUB.Merchant1, PUB.Farmer1, PUB.Farmer1];
  const { exitCode, lines } = await run({ [K.channels]: channelsOut(twoToFarmer) });
  assert.equal(statusOf(lines, "treasury-channels"), "FAIL");
  assert.equal(exitCode, 1);
});

test("channels: 3 active with a foreign pubkey is FAIL", async () => {
  const foreign = [PUB.Merchant1, PUB.Farmer1, STRANGER];
  const { exitCode, lines } = await run({ [K.channels]: channelsOut(foreign) });
  assert.equal(statusOf(lines, "treasury-channels"), "FAIL");
  assert.equal(exitCode, 1);
});

test("channels: 4 active covering all 3 peers is FAIL", async () => {
  const fourChannels = [...SPOKE_KEYS, PUB.Farmer1];
  const { exitCode, lines } = await run({ [K.channels]: channelsOut(fourChannels) });
  assert.equal(statusOf(lines, "treasury-channels"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(b) a missing container is CANNOT-LOOK, its dependents too, and the run exits 2", async () => {
  const present = CONTAINERS.filter((c) => c !== "polar-n1-Farmer1");
  const { exitCode, lines, calls, sleeps } = await run({
    [K.list]: listOut(present),
    [`inspect ${present.join(" ")}`]: inspectOut(present),
  });
  assert.equal(statusOf(lines, "containers"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "restart-counts-steady"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "synced-to-chain:Farmer1"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "treasury-peers"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "treasury-channels"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
  assert.ok(!calls.some((a) => a.includes("polar-n1-Farmer1")));
  assert.ok(!sleeps.includes(30_000), "no point waiting out a window that cannot be sampled");
});

test("(b) a sixth polar-n1 container is FAIL, and the other checks still run", async () => {
  const { exitCode, lines } = await run({ [K.list]: listOut([...CONTAINERS, "polar-n1-Extra"]) });
  assert.equal(statusOf(lines, "containers"), "FAIL");
  assert.match(lineOf(lines, "containers"), /polar-n1-Extra/);
  assert.equal(statusOf(lines, "treasury-peers"), "PASS");
  assert.equal(exitCode, 1);
});

test("(b) a stopped container is FAIL, and what needs it is CANNOT-LOOK", async () => {
  const stopped = inspectOut(CONTAINERS, { "polar-n1-Farmer1": { State: { Status: "exited" } } });
  const { exitCode, lines, calls } = await run({ [K.inspect]: stopped });
  assert.equal(statusOf(lines, "containers"), "FAIL");
  assert.equal(statusOf(lines, "synced-to-chain:Farmer1"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "treasury-peers"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
  assert.ok(!calls.some((a) => a.includes("exec") && a.includes("polar-n1-Farmer1")));
});

test("(b) one node's getinfo down: every check needing its pubkey is CANNOT-LOOK, never PASS", async () => {
  const { exitCode, lines } = await run({ [K.getinfo("Merchant1")]: bad("rpc down") });
  assert.equal(statusOf(lines, "synced-to-chain:Merchant1"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "treasury-peers"), "CANNOT-LOOK");
  assert.equal(statusOf(lines, "treasury-channels"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
});

// ─── (c) exit codes and output ────────────────────────────────────────────

test("(c) resolveExit: 2 wins over 1, REPAIRED counts as passed, nothing checked is not a pass", () => {
  assert.equal(resolveExit(["PASS", "PASS"]), 0);
  assert.equal(resolveExit(["PASS", "REPAIRED"]), 0);
  assert.equal(resolveExit(["PASS", "FAIL"]), 1);
  assert.equal(resolveExit(["PASS", "CANNOT-LOOK"]), 2);
  assert.equal(resolveExit(["FAIL", "CANNOT-LOOK"]), 2);
  assert.equal(resolveExit(["CANNOT-LOOK", "FAIL"]), 2);
  assert.equal(resolveExit([]), 2);
});

test("(c) exit 2 wins over exit 1, end to end", async () => {
  const noRestartLine = COMPOSE.replace("    restart: unless-stopped\n", "");
  const { exitCode, lines } = await run(
    { [K.channels]: bad("listchannels errored") },
    { compose: noRestartLine },
  );
  assert.equal(statusOf(lines, "compose-restart-policy"), "FAIL");
  assert.equal(statusOf(lines, "treasury-channels"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
  assert.match(lines.at(-1), / exit=2$/);
});

test("(c) line format: UTC timestamp, status, check name, value; then a timestamped summary", async () => {
  const { lines } = await run(allStale());
  for (const line of lines.slice(0, -1)) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (PASS|FAIL|REPAIRED|CANNOT-LOOK) \S+ \S/);
  }
  assert.equal(
    lines.at(-1),
    "2026-10-30T16:00:00.000Z summary pass=8 fail=4 repaired=0 cannot-look=0 exit=1",
  );
});

for (const [label, failure] of [
  ["exits non-zero", bad("Cannot connect to the Docker daemon")],
  ["rejects", new Error("spawn docker ENOENT")],
]) {
  test(`(c) CANNOT-LOOK exits 2, never 0, and prints no PASS: docker ${label}`, async () => {
    const { exitCode, lines, calls } = await run({ [K.version]: failure });
    assert.equal(exitCode, 2);
    for (const name of CHECKS) assert.equal(statusOf(lines, name), "CANNOT-LOOK");
    assert.deepEqual(passLines(lines), []);
    assert.ok(!lines.join("\n").includes("PASS"), "done-when 2 is checked with a plain grep");
    assert.equal(calls.length, 1, "nothing else is attempted once docker is unreachable");
  });
}

for (const [label, overrides, name] of [
  ["empty stdout", { [K.chain]: ok("") }, "bitcoind"],
  ["non-JSON stdout", { [K.chain]: ok("error: not json") }, "bitcoind"],
  ["blocks missing", { [K.chain]: ok('{"headers":1,"bestblockhash":"x","initialblockdownload":false}') }, "bitcoind"],
  ["initialblockdownload missing", { [K.chain]: ok(`{"blocks":1,"headers":1,"bestblockhash":"${HASH}"}`) }, "bitcoind"],
  ["blocks a string", { [K.chain]: chainOut({ blocks: "11769" }) }, "bitcoind"],
  ["block_hash missing", { [K.getinfo("Farmer1")]: getinfoOut("Farmer1", { block_hash: undefined }) }, "synced-to-chain:Farmer1"],
  ["synced_to_chain a string", { [K.getinfo("Farmer1")]: getinfoOut("Farmer1", { synced_to_chain: "true" }) }, "synced-to-chain:Farmer1"],
  ["identity_pubkey missing", { [K.getinfo("Farmer1")]: getinfoOut("Farmer1", { identity_pubkey: undefined }) }, "synced-to-chain:Farmer1"],
  ["peers absent", { [K.peers]: ok("{}") }, "treasury-peers"],
  ["a peer with no pub_key", { [K.peers]: ok('{"peers":[{}]}') }, "treasury-peers"],
  ["channels not an array", { [K.channels]: ok('{"channels":3}') }, "treasury-channels"],
  ["RestartCount missing", { [K.inspect]: inspectOut(CONTAINERS, { "polar-n1-Treasury": { RestartCount: undefined } }) }, "containers"],
  ["inspect short by one container", { [K.inspect]: inspectOut(CONTAINERS.slice(1)) }, "containers"],
  ["a listed name not a string", { [K.list]: ok("42\n") }, "containers"],
]) {
  test(`(c) unparsable output is CANNOT-LOOK, never PASS: ${label}`, async () => {
    const { exitCode, lines } = await run(overrides);
    assert.equal(statusOf(lines, name), "CANNOT-LOOK");
    assert.equal(exitCode, 2);
  });
}

// ─── (d) --repair: without it, nothing is written ─────────────────────────

test("(d) without --repair, a stale tip and a missing peer make no write", async () => {
  const { exitCode, lines, calls } = await run({
    ...allStale(),
    [K.peers]: peersOut(SPOKE_KEYS.slice(0, 2)),
  });
  assert.deepEqual(mineCalls(calls), []);
  assert.deepEqual(connectCalls(calls), []);
  assert.equal(statusOf(lines, "synced-to-chain:Treasury"), "FAIL");
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.equal(exitCode, 1);
});

// ─── (d) stale tip ────────────────────────────────────────────────────────

test("(d) exact match: one mining call with these exact args, REPAIRED after the re-check", async () => {
  const { exitCode, lines, calls } = await run(
    { ...staleThenSynced(), [K.mine]: ok(`["${"ab".repeat(32)}"]`) },
    { repair: true },
  );
  assert.deepEqual(mineCalls(calls), [[
    "exec", "-u", "bitcoin", "polar-n1-backend1",
    "bitcoin-cli", "-regtest", "generatetodescriptor", "1", "raw(6a)",
  ]]);
  for (const node of ALL_NODES) assert.equal(statusOf(lines, `synced-to-chain:${node}`), "REPAIRED");
  assert.equal(statusOf(lines, "repair-stale-tip"), "REPAIRED");
  assert.equal(exitCode, 0);
});

test("(d) every LND is re-checked after the block, including one that was already synced", async () => {
  const overrides = {
    ...staleThenSynced(),
    [K.getinfo("Farmer1")]: getinfoOut("Farmer1"),
    [K.mine]: ok("[]"),
  };
  const { lines, calls } = await run(overrides, { repair: true });
  const farmerReads = calls.filter((a) => a.includes("polar-n1-Farmer1") && a.includes("getinfo"));
  assert.ok(farmerReads.length >= 2);
  assert.equal(statusOf(lines, "synced-to-chain:Farmer1"), "PASS");
  assert.equal(statusOf(lines, "synced-to-chain:Treasury"), "REPAIRED");
});

test("(d) height mismatch: no block is mined", async () => {
  const overrides = { ...allStale(), [K.getinfo("Treasury")]: staleOut("Treasury", { block_height: HEIGHT - 1 }) };
  const { exitCode, lines, calls } = await run(overrides, { repair: true });
  assert.deepEqual(mineCalls(calls), []);
  assert.equal(statusOf(lines, "repair-stale-tip"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(d) hash mismatch: no block is mined", async () => {
  const overrides = { ...allStale(), [K.getinfo("Treasury")]: staleOut("Treasury", { block_hash: "ff".repeat(32) }) };
  const { exitCode, calls } = await run(overrides, { repair: true });
  assert.deepEqual(mineCalls(calls), []);
  assert.equal(exitCode, 1);
});

test("(d) two unsynced, one mismatched: the run mines nothing at all", async () => {
  const overrides = {
    [K.getinfo("Treasury")]: staleOut("Treasury"),
    [K.getinfo("Farmer1")]: staleOut("Farmer1", { block_height: HEIGHT - 1 }),
  };
  const { calls } = await run(overrides, { repair: true });
  assert.deepEqual(mineCalls(calls), []);
});

test("(d) an unreadable LND: no block is mined", async () => {
  const overrides = { ...allStale(), [K.getinfo("Farmer1")]: bad("rpc down") };
  const { exitCode, calls } = await run(overrides, { repair: true });
  assert.deepEqual(mineCalls(calls), []);
  assert.equal(exitCode, 2);
});

test("(d) an unreadable bitcoind: no block is mined", async () => {
  const { exitCode, calls } = await run({ ...allStale(), [K.chain]: bad("rpc down") }, { repair: true });
  assert.deepEqual(mineCalls(calls), []);
  assert.equal(exitCode, 2);
});

test("(d) still unsynced after the block: FAIL, and only the one block", async () => {
  const { exitCode, lines, calls, sleeps } = await run(
    { ...allStale(), [K.mine]: ok("[]") },
    { repair: true },
  );
  assert.equal(mineCalls(calls).length, 1);
  assert.equal(statusOf(lines, "repair-stale-tip"), "FAIL");
  assert.equal(statusOf(lines, "synced-to-chain:Treasury"), "FAIL");
  assert.ok(sleeps.length > 1, "the re-check polls rather than reading once");
  assert.equal(exitCode, 1);
});

test("(d) a failed mining command is FAIL, not CANNOT-LOOK", async () => {
  const { exitCode, lines } = await run(
    { ...allStale(), [K.mine]: bad("rpc error") },
    { repair: true },
  );
  assert.equal(statusOf(lines, "repair-stale-tip"), "FAIL");
  assert.equal(statusOf(lines, "synced-to-chain:Treasury"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(d) an unreadable re-check: the repair is FAIL, the check is CANNOT-LOOK, exit 2", async () => {
  const { exitCode, lines } = await run(
    {
      ...staleThenSynced(),
      [K.getinfo("Farmer1")]: [staleOut("Farmer1"), bad("rpc down")],
      [K.mine]: ok("[]"),
    },
    { repair: true },
  );
  assert.equal(statusOf(lines, "repair-stale-tip"), "FAIL");
  assert.equal(statusOf(lines, "synced-to-chain:Farmer1"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
});

// ─── (d) missing peer ─────────────────────────────────────────────────────

test("(d) connect: exactly one, by hostname, for the missing expected peer; REPAIRED and exit 0", async () => {
  const { exitCode, lines, calls } = await run(
    {
      [K.peers]: [peersOut([PUB.Merchant1, PUB["External-Peer-1"]]), peersOut()],
      [K.connect("Farmer1")]: ok("{}"),
    },
    { repair: true },
  );
  assert.deepEqual(connectCalls(calls), [[
    "exec", "-u", "lnd", "polar-n1-Treasury", "lncli", "--network", "regtest",
    "connect", `${PUB.Farmer1}@Farmer1:9735`,
  ]]);
  assert.equal(statusOf(lines, "repair-peer:Farmer1"), "REPAIRED");
  assert.equal(statusOf(lines, "treasury-peers"), "REPAIRED");
  assert.equal(exitCode, 0);
});

test("(d) connect: never for an unexpected pubkey, no disconnect, and the unexpected peer stays a FAIL", async () => {
  const { exitCode, lines, calls } = await run(
    {
      [K.peers]: [
        peersOut([PUB.Merchant1, PUB["External-Peer-1"], STRANGER]),
        peersOut([...SPOKE_KEYS, STRANGER]),
      ],
      [K.connect("Farmer1")]: ok("{}"),
    },
    { repair: true },
  );
  assert.equal(connectCalls(calls).length, 1);
  assert.ok(!calls.some((a) => a.join(" ").includes(`connect ${STRANGER}`)));
  assert.equal(statusOf(lines, "repair-peer:Farmer1"), "REPAIRED");
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(d) connect: an unexpected peer alone makes no connect", async () => {
  const { calls, exitCode } = await run({ [K.peers]: peersOut([...SPOKE_KEYS, STRANGER]) }, { repair: true });
  assert.deepEqual(connectCalls(calls), []);
  assert.equal(exitCode, 1);
});

test("(d) connect error is FAIL, not CANNOT-LOOK", async () => {
  const { exitCode, lines } = await run(
    {
      [K.peers]: peersOut([PUB.Merchant1, PUB["External-Peer-1"]]),
      [K.connect("Farmer1")]: bad("connection refused"),
    },
    { repair: true },
  );
  assert.equal(statusOf(lines, "repair-peer:Farmer1"), "FAIL");
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(d) connect succeeded but the peer is still missing on re-check: FAIL", async () => {
  const { exitCode, lines } = await run(
    {
      [K.peers]: peersOut([PUB.Merchant1, PUB["External-Peer-1"]]),
      [K.connect("Farmer1")]: ok("{}"),
    },
    { repair: true },
  );
  assert.equal(statusOf(lines, "repair-peer:Farmer1"), "FAIL");
  assert.equal(statusOf(lines, "treasury-peers"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(d) unreadable peer re-check: the repair is FAIL, the check is CANNOT-LOOK, exit 2", async () => {
  const { exitCode, lines } = await run(
    {
      [K.peers]: [peersOut([PUB.Merchant1, PUB["External-Peer-1"]]), bad("rpc down")],
      [K.connect("Farmer1")]: ok("{}"),
    },
    { repair: true },
  );
  assert.equal(statusOf(lines, "repair-peer:Farmer1"), "FAIL");
  assert.equal(statusOf(lines, "treasury-peers"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
});

test("(d) after a peer repair, channels get time to come back active", async () => {
  const { exitCode, lines } = await run(
    {
      [K.peers]: [peersOut([PUB.Merchant1, PUB["External-Peer-1"]]), peersOut()],
      [K.channels]: [channelsOut([PUB.Merchant1, PUB["External-Peer-1"]]), channelsOut()],
      [K.connect("Farmer1")]: ok("{}"),
    },
    { repair: true },
  );
  assert.equal(statusOf(lines, "treasury-channels"), "PASS");
  assert.equal(exitCode, 0);
});

// ─── (e) the other checks ─────────────────────────────────────────────────

test("(e) compose: read from the home directory at run time", async () => {
  const { composeReads } = await run();
  assert.deepEqual(composeReads, [path.join(os.homedir(), ".polar", "networks", "1", "docker-compose.yml")]);
});

test("(e) compose: backend1's restart line absent is FAIL, though the LNDs keep theirs", async () => {
  const noRestartLine = COMPOSE.replace("    restart: unless-stopped\n", "");
  const { exitCode, lines } = await run({}, { compose: noRestartLine });
  assert.equal(statusOf(lines, "compose-restart-policy"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(e) compose: backend1 on a different policy is FAIL", async () => {
  const always = COMPOSE.replace("restart: unless-stopped", "restart: always");
  const { lines } = await run({}, { compose: always });
  assert.equal(statusOf(lines, "compose-restart-policy"), "FAIL");
  assert.match(lineOf(lines, "compose-restart-policy"), /restart=always/);
});

test("(e) compose: a quoted policy still reads as the policy", async () => {
  const quoted = COMPOSE.replace("restart: unless-stopped", "restart: 'unless-stopped'");
  const { lines } = await run({}, { compose: quoted });
  assert.equal(statusOf(lines, "compose-restart-policy"), "PASS");
});

test("(e) compose: file unreadable is CANNOT-LOOK", async () => {
  const { exitCode, lines } = await run({}, { compose: new Error("ENOENT: no such file") });
  assert.equal(statusOf(lines, "compose-restart-policy"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
});

test("(e) compose: no backend1 service in the file is CANNOT-LOOK", async () => {
  const noBackend = "services:\n  Farmer1:\n    restart: always\n";
  const { lines } = await run({}, { compose: noBackend });
  assert.equal(statusOf(lines, "compose-restart-policy"), "CANNOT-LOOK");
});

for (const line of [
  "1001 /home/user/Downloads/polar-linux-x86_64-v4.0.0.AppImage",
  "1002 ./polar-linux-x86_64-v4.0.0.AppImage --no-sandbox",
  "1003 /tmp/.mount_polar-AbCdEf/polar --no-sandbox",
  "1004 /tmp/.mount_polar-AbCdEf/polar --type=renderer --enable-crash-reporter",
  "1005 /tmp/.mount_Polar.AxYz12/polar",
  "1006 /tmp/.mount_polar-AbCdEf/AppRun",
]) {
  test(`(e) polar running: FAIL for ${line}`, async () => {
    const { exitCode, lines } = await run({}, { ps: ok(`${QUIET_PS}${line}\n`) });
    assert.equal(statusOf(lines, "polar-not-running"), "FAIL");
    assert.match(lineOf(lines, "polar-not-running"), new RegExp(line.split(" ")[0]));
    assert.equal(exitCode, 1);
  });
}

for (const line of [
  "2001 lnd --noseedbackup --alias=Treasury --bitcoind.rpchost=polar-n1-backend1",
  "2002 bitcoind -server=1 -regtest=1",
  "2003 claude --worktree polar-gate",
  "2004 node scripts/polar-preflight.mjs",
  "2005 ls -la /home/user/Downloads/polar-linux-x86_64-v4.0.0.AppImage",
  "2006 /bin/bash -c unsquashfs -l ~/Downloads/polar-linux-x86_64-v4.0.0.AppImage",
  "2007 vim /tmp/.mount_polar-AbCdEf/polar",
]) {
  test(`(e) polar decoy: PASS for ${line}`, async () => {
    const { lines } = await run({}, { ps: ok(`${QUIET_PS}${line}\n`) });
    assert.equal(statusOf(lines, "polar-not-running"), "PASS");
  });
}

for (const [label, response] of [
  ["exits non-zero", bad("ps: error")],
  ["rejects", new Error("spawn ps ENOENT")],
  ["prints nothing", ok("")],
  ["prints no process lines", ok("not a process table\n")],
]) {
  test(`(e) polar probe ${label}: CANNOT-LOOK, never PASS`, async () => {
    const { exitCode, lines } = await run({}, { ps: response });
    assert.equal(statusOf(lines, "polar-not-running"), "CANNOT-LOOK");
    assert.equal(exitCode, 2);
  });
}

test("(e) restart counts: two samples about 30 seconds apart", async () => {
  const { lines, sleeps, calls } = await run();
  assert.equal(sleeps.filter((ms) => ms === 30_000).length, 1);
  assert.equal(calls.filter((a) => a.join(" ") === K.inspect).length, 2);
  assert.equal(statusOf(lines, "restart-counts-steady"), "PASS");
});

test("(e) restart counts: a change is FAIL and names the container", async () => {
  const { exitCode, lines } = await run({
    [K.inspect]: [
      inspectOut(),
      inspectOut(CONTAINERS, { "polar-n1-Treasury": { RestartCount: 3 } }),
    ],
  });
  assert.equal(statusOf(lines, "restart-counts-steady"), "FAIL");
  assert.match(lineOf(lines, "restart-counts-steady"), /polar-n1-Treasury/);
  assert.equal(exitCode, 1);
});

test("(e) restart counts: an unreadable second sample is CANNOT-LOOK", async () => {
  const { exitCode, lines } = await run({ [K.inspect]: [inspectOut(), bad("inspect failed")] });
  assert.equal(statusOf(lines, "restart-counts-steady"), "CANNOT-LOOK");
  assert.equal(exitCode, 2);
});

test("(e) logs: the script reads none, repair or not", async () => {
  const quiet = await run();
  const repairing = await run({ ...staleThenSynced(), [K.mine]: ok("[]") }, { repair: true });
  for (const { calls } of [quiet, repairing]) {
    assert.ok(!calls.some((a) => a.includes("logs") || a.includes("--since")));
  }
  assert.doesNotMatch(fs.readFileSync(SCRIPT, "utf8"), /--since/);
});

test("(e) bitcoind: blocks != headers is FAIL", async () => {
  const { exitCode, lines } = await run({ [K.chain]: chainOut({ headers: HEIGHT + 1 }) });
  assert.equal(statusOf(lines, "bitcoind"), "FAIL");
  assert.equal(exitCode, 1);
});

test("(e) bitcoind: the IBD value is printed as observed, not tested", async () => {
  const { lines } = await run({ [K.chain]: chainOut({ initialblockdownload: true }) });
  assert.equal(statusOf(lines, "bitcoind"), "PASS");
  assert.match(lineOf(lines, "bitcoind"), /initialblockdownload=true/);
});

test("(e) docker endpoint: DOCKER_HOST is reported when set, the context otherwise", async () => {
  const fromContext = await run();
  assert.match(lineOf(fromContext.lines, "docker-endpoint"), /context=default server=29\.9\.1/);
  const fromEnv = await run({}, { env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" } });
  assert.match(lineOf(fromEnv.lines, "docker-endpoint"), /DOCKER_HOST=unix:\/\/\/run\/user\/1000\/docker\.sock/);
  assert.ok(!fromEnv.calls.some((a) => a[0] === "context"));
});

// ─── (h) the pin ──────────────────────────────────────────────────────────

test("(h) running under the Node major pinned in .nvmrc", () => {
  const pinned = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
  assert.equal(process.version.split(".")[0], `v${pinned}`);
});
