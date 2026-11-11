#!/usr/bin/env node
// polar-preflight.mjs — pre-flight for the Polar regtest gate.
//
// Run:  node scripts/polar-preflight.mjs            (report only, writes nothing)
//       node scripts/polar-preflight.mjs --repair   (opt-in, see below)
//       HARNESS_SLOT=2 node scripts/polar-preflight.mjs   (a slot other than 1)
//
// SLOT: HARNESS_SLOT, default 1, as in scripts/harness-slot.mjs. Slot 1 is
// Polar network 1 and its output is unchanged. Slot N is the network named
// bitcorn-dev-N in ~/.polar/networks/networks.json, and prints a `slot` line
// first; a slot that does not resolve is CANNOT-LOOK for every check. The
// Polar-GUI check stays host-wide in every slot (D10): with several networks on
// one host, a running Polar can rewrite any of their compose files.
//
// LOCK (H14): the CLI refuses, exit 2, before any check, unless the slot's lock
// (~/.bitcorn-dev/locks/slot-N.lock) is held by HARNESS_HOLDER, and while
// setup.lock is held. Acquire it with scripts/harness-slot.mjs lock acquire.
// The report-only run needs the lock too: it is part of the gate.
//
// The procedure this serves is docs/dev-setup.md § Polar regtest gate. It runs
// immediately before each gate and again after it, not once per session,
// because a stale tip can arise while the nodes are up. One run takes about 30
// seconds: the restart-count window.
//
// EXIT CODES (three-valued, as in scripts/loopd-guard-exec.sh):
//   0  every check passed (a check repaired under --repair counts as passed)
//   1  at least one check failed
//   2  the script could not look: docker unreachable, a container missing, or a
//      command errored or printed output that does not parse
//   2 wins over 1. A run with both a FAIL and a CANNOT-LOOK exits 2.
//
// OUTPUT: one line per check, then a summary:
//   <UTC ISO-8601> <PASS|FAIL|REPAIRED|CANNOT-LOOK> <check> <observed value>
//   <UTC ISO-8601> summary pass=N fail=N repaired=N cannot-look=N exit=N
// The summary is lowercase on purpose: "no PASS line" stays true for a plain
// grep. A check that could not run never prints PASS; when an earlier step
// fails, whatever depends on it prints CANNOT-LOOK rather than being skipped.
// docker-endpoint gates every check, including the two that do not use docker,
// so an unreachable daemon can never leave a PASS in the output.
//
// --repair MAKES EXACTLY TWO WRITES, each followed by a re-check:
//   1. Mines one block, only when every LND was read, at least one reports
//      synced_to_chain false, and every unsynced LND's block_height and
//      block_hash both equal bitcoind's best height and hash. One mismatch and
//      the run mines nothing. At most one block per run.
//   2. Runs lncli connect on Treasury, by hostname, only for an expected peer
//      missing from its listpeers. An unexpected peer stays a FAIL.
// It never restarts or stops a container or the daemon, never edits the compose
// file, and never opens or closes a channel. A failed write is FAIL (the script
// did look). A re-check it cannot read is CANNOT-LOOK, beside the repair's FAIL.
//
// EXPECTED SET: pinned from ~/.polar/networks/1/docker-compose.yml, and the same
// five nodes, under the slot's network id, in every slot (D16). No pubkey is
// pinned; each node's comes from its own getinfo at run time. Peers and channels
// compare as sets as well as counts: a right count made of the wrong members is
// a FAIL.
//
// EXEC USERS: `-u bitcoin` because cookie auth only works as that user (root
// gets "Could not locate RPC credentials"), `-u lnd` so lncli finds its files.
//
// DOCKER ENDPOINT: the docker CLI inherits this process's environment and
// resolves the active context or DOCKER_HOST itself. No endpoint is written here.
//
// LOGS: this script reads none.
//
// Spec and decision (vault): specs/2026-10-29-polar-gate-preflight-and-procedure-spec.md,
// decisions/2026-10-29-polar-gate-procedure-preflight-and-stale-ip.md.
// Tests: scripts/polar-preflight.test.mjs.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BITCOIN_NODE, LND_NODE_NAMES, lockRefusal, parseSlot, resolveNetwork } from "./harness-slot.mjs";

// The expected set for one Polar network, by its id. Container names embed the
// id (polar-n<id>-<Node>); the node names are D16's five in every slot.
export function preflightTargets(networkId) {
  const prefix = `polar-n${networkId}-`;
  const lndNodes = LND_NODE_NAMES.map((name) => ({ name, container: `${prefix}${name}`, host: name }));
  const treasury = `${prefix}Treasury`;
  const backend = `${prefix}${BITCOIN_NODE}`;
  return {
    prefix,
    backend,
    treasury,
    lndNodes,
    containers: [backend, ...lndNodes.map((n) => n.container)],
    treasuryNode: lndNodes.find((n) => n.container === treasury),
    composePath: path.join(os.homedir(), ".polar", "networks", String(networkId), "docker-compose.yml"),
  };
}

// Slot 1, network 1: today's set, still exported under its old names.
const SLOT1 = preflightTargets(1);
export const LND_NODES = SLOT1.lndNodes;
export const CONTAINERS = SLOT1.containers;

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // past Node's 1 MiB default, for a long `ps -ww`
const RESTART_WINDOW_MS = 30_000;
const RECHECK_ATTEMPTS = 15;
const RECHECK_INTERVAL_MS = 2_000;
const MAX_VALUE_CHARS = 200;

// Matched against argv[0] only, so a shell or editor that merely names the file
// is not mistaken for Polar. The first arm is the AppImage runtime; the second
// is the Electron binary inside its FUSE mount, which also catches a renamed
// AppImage. Misses an extracted run and a deb or rpm install.
const POLAR_PROCESS =
  /^\s*\d+\s+(?:\S*\/)?polar-linux-[^\s/]*\.AppImage(?:\s|$)|^\s*\d+\s+\/\S*\/\.mount_[^\s/]*\/(?:polar|AppRun)(?:\s|$)/i;

// ─── injectable runners ───────────────────────────────────────────────────

// Resolves {code, stdout, stderr} for any exit code. Rejects when the command
// never produced one: ENOENT, a timeout, output past the buffer.
export function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        if (typeof error.code === "number" && !error.killed) {
          return resolve({ code: error.code, stdout, stderr });
        }
        reject(error);
      },
    );
  });
}

const defaultDocker = (args) => runCommand("docker", args);
const defaultPs = () => runCommand("ps", ["-ww", "-eo", "pid=,args="]);
const defaultReadCompose = (file) => fs.promises.readFile(file, "utf8");
const defaultReadNetworks = async () =>
  JSON.parse(await fs.promises.readFile(path.join(os.homedir(), ".polar", "networks", "networks.json"), "utf8"));
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── reading, where every failure is CANNOT-LOOK ──────────────────────────

class CannotLook extends Error {}

const oneLine = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_CHARS);

// CANNOT-LOOK is an expected outcome and comes back as data. Any other throw is
// a bug in this script and stays a throw, so it can never be read as a result.
async function attempt(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    if (error instanceof CannotLook) return { reason: error.message };
    throw error;
  }
}

async function read(run, what) {
  let result;
  try {
    result = await run();
  } catch (error) {
    throw new CannotLook(`${what} could not run: ${oneLine(error.message)}`);
  }
  if (result.code !== 0) {
    throw new CannotLook(`${what} exited ${result.code}: ${oneLine(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

function parse(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CannotLook(`${what} output does not parse`);
  }
}

function field(object, key, type, what) {
  if (typeof object?.[key] !== type) throw new CannotLook(`${what} has no ${type} ${key}`);
  return object[key];
}

function list(object, key, what) {
  if (!Array.isArray(object?.[key])) throw new CannotLook(`${what} has no array ${key}`);
  return object[key];
}

async function readJson(docker, args, what) {
  return parse(await read(() => docker(args), what), what);
}

const lndArgs = (node, ...rest) =>
  ["exec", "-u", "lnd", node.container, "lncli", "--network", "regtest", ...rest];

async function readEndpoint(docker, env) {
  const server = await readJson(docker, ["version", "--format", "{{json .Server.Version}}"], "docker version");
  if (typeof server !== "string") throw new CannotLook("docker version gave no server version");
  if (env.DOCKER_HOST) return `DOCKER_HOST=${env.DOCKER_HOST} server=${server}`;
  const context = await read(() => docker(["context", "show"]), "docker context show");
  return `context=${oneLine(context)} server=${server}`;
}

async function listContainers(docker, t) {
  const args = ["ps", "-a", "--filter", `name=^${t.prefix}`, "--format", "{{json .Names}}"];
  const stdout = await read(() => docker(args), "docker ps");
  return stdout.split("\n").filter(Boolean).map((line) => {
    const name = parse(line, "docker ps");
    if (typeof name !== "string") throw new CannotLook("docker ps gave a name that is not a string");
    return name;
  });
}

async function inspectContainers(docker, names) {
  const documents = await readJson(docker, ["inspect", ...names], "docker inspect");
  if (!Array.isArray(documents)) throw new CannotLook("docker inspect did not return an array");
  const seen = new Map();
  for (const document of documents) {
    const name = field(document, "Name", "string", "docker inspect").replace(/^\//, "");
    seen.set(name, {
      status: field(document?.State, "Status", "string", `${name} State`),
      restartCount: field(document, "RestartCount", "number", name),
    });
  }
  const absent = names.filter((n) => !seen.has(n));
  if (absent.length > 0) throw new CannotLook(`docker inspect omitted ${absent.join(",")}`);
  return seen;
}

async function readChain(docker, t) {
  const args = ["exec", "-u", "bitcoin", t.backend, "bitcoin-cli", "-regtest", "getblockchaininfo"];
  const chain = await readJson(docker, args, "getblockchaininfo");
  return {
    blocks: field(chain, "blocks", "number", "getblockchaininfo"),
    headers: field(chain, "headers", "number", "getblockchaininfo"),
    bestHash: field(chain, "bestblockhash", "string", "getblockchaininfo"),
    ibd: field(chain, "initialblockdownload", "boolean", "getblockchaininfo"),
  };
}

async function readGetinfo(docker, node) {
  const what = `${node.name} getinfo`;
  const info = await readJson(docker, lndArgs(node, "getinfo"), what);
  return {
    pubkey: field(info, "identity_pubkey", "string", what),
    synced: field(info, "synced_to_chain", "boolean", what),
    height: field(info, "block_height", "number", what),
    hash: field(info, "block_hash", "string", what),
  };
}

async function readPeers(docker, t) {
  const peers = list(await readJson(docker, lndArgs(t.treasuryNode, "listpeers"), "listpeers"), "peers", "listpeers");
  return peers.map((p) => field(p, "pub_key", "string", "listpeers"));
}

async function readChannels(docker, t) {
  const what = "listchannels";
  const output = await readJson(docker, lndArgs(t.treasuryNode, "listchannels", "--active_only"), what);
  return list(output, "channels", what).map((c) => field(c, "remote_pubkey", "string", what));
}

// ─── decisions ────────────────────────────────────────────────────────────

export function resolveExit(statuses) {
  if (statuses.length === 0 || statuses.includes("CANNOT-LOOK")) return 2;
  return statuses.includes("FAIL") ? 1 : 0;
}

function compareSets(expected, observed) {
  const missing = expected.filter((key) => !observed.includes(key));
  const unexpected = observed.filter((key) => !expected.includes(key));
  const ok = missing.length === 0 && unexpected.length === 0 && observed.length === expected.length;
  return { ok, missing, unexpected };
}

const matchesTip = (info, chain) => info.height === chain.blocks && info.hash === chain.bestHash;

function decideMine({ repair, chain, nodes }) {
  if (!repair || !chain || nodes.some((n) => !n.info)) return false;
  const unsynced = nodes.filter((n) => !n.info.synced);
  return unsynced.length > 0 && unsynced.every((n) => matchesTip(n.info, chain));
}

// Scoped to backend1's block, because every LND carries a restart line too.
function composeRestartPolicy(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^ {2}backend1:\s*$/.test(line));
  if (start === -1) throw new CannotLook("compose file has no backend1 service");
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    const match = line.match(/^ {4}restart:\s*["']?([^"'\s#]+)/);
    if (match) return match[1];
  }
  return null;
}

// ─── the run ──────────────────────────────────────────────────────────────

export async function runPreflight({
  docker = defaultDocker,
  ps = defaultPs,
  readCompose = defaultReadCompose,
  sleep = defaultSleep,
  now = () => new Date(),
  print = console.log,
  env = process.env,
  repair = false,
  readNetworks = defaultReadNetworks,
} = {}) {
  const statuses = [];
  const report = (status, name, value) => {
    statuses.push(status);
    print(`${now().toISOString()} ${status} ${name} ${value}`);
  };
  const finish = () => {
    const count = (status) => statuses.filter((s) => s === status).length;
    const exitCode = resolveExit(statuses);
    print(
      `${now().toISOString()} summary pass=${count("PASS")} fail=${count("FAIL")} ` +
      `repaired=${count("REPAIRED")} cannot-look=${count("CANNOT-LOOK")} exit=${exitCode}`,
    );
    return { exitCode };
  };

  const blocked = [
    "containers", "polar-not-running", "compose-restart-policy", "restart-counts-steady", "bitcoind",
    ...LND_NODE_NAMES.map((n) => `synced-to-chain:${n}`),
    "treasury-peers", "treasury-channels",
  ];

  // HARNESS_SLOT picks the Polar network (H10). Slot 1 is network 1 and reads
  // nothing, printing no slot line, so its output is today's. Slot N resolves
  // bitcorn-dev-N from networks.json; a slot that cannot resolve looks at nothing.
  let t;
  try {
    const slot = parseSlot(env.HARNESS_SLOT);
    if (slot === 1) {
      t = SLOT1;
    } else {
      const network = resolveNetwork(slot, await readNetworks());
      t = preflightTargets(network.id);
      report("PASS", "slot", `slot=${slot} network=${network.id} name=${network.name}`);
    }
  } catch (error) {
    report("CANNOT-LOOK", "slot", oneLine(error.message));
    for (const name of ["docker-endpoint", ...blocked]) report("CANNOT-LOOK", name, "blocked-by=slot");
    return finish();
  }

  const endpoint = await attempt(() => readEndpoint(docker, env));
  if (endpoint.reason !== undefined) {
    report("CANNOT-LOOK", "docker-endpoint", endpoint.reason);
    for (const name of blocked) report("CANNOT-LOOK", name, "blocked-by=docker-endpoint");
    return finish();
  }
  report("PASS", "docker-endpoint", endpoint.value);

  const { running, firstSample } = await checkContainers(docker, report, t);
  await checkPolar(ps, report);
  await checkCompose(readCompose, report, t);
  await checkRestartCounts({ docker, sleep, report, firstSample, t });
  const chain = await checkBitcoind({ docker, report, running, t });
  const nodes = await checkLnds({ docker, sleep, report, running, chain, repair, t });
  const peersRepaired = await checkPeers({ docker, report, running, nodes, repair, t });
  await checkChannels({ docker, sleep, report, running, nodes, peersRepaired, t });
  return finish();
}

async function checkContainers(docker, report, t) {
  const name = "containers";
  const listed = await attempt(() => listContainers(docker, t));
  if (listed.reason !== undefined) {
    report("CANNOT-LOOK", name, listed.reason);
    return { running: new Set(), firstSample: null };
  }

  const { missing, unexpected } = compareSets(t.containers, listed.value);
  const present = t.containers.filter((c) => !missing.includes(c));
  const sample = await attempt(async () =>
    present.length > 0 ? inspectContainers(docker, present) : new Map());
  if (sample.reason !== undefined) {
    report("CANNOT-LOOK", name, sample.reason);
    return { running: new Set(), firstSample: null };
  }

  const stopped = present.filter((c) => sample.value.get(c).status !== "running");
  const running = new Set(present.filter((c) => !stopped.includes(c)));
  const value =
    `expected=${t.containers.length} found=${listed.value.length} missing=[${missing}] ` +
    `unexpected=[${unexpected}] not-running=[${stopped}]`;
  if (missing.length > 0) {
    report("CANNOT-LOOK", name, value);
    return { running, firstSample: null };
  }
  report(unexpected.length > 0 || stopped.length > 0 ? "FAIL" : "PASS", name, value);
  return { running, firstSample: sample.value };
}

async function checkPolar(ps, report) {
  const name = "polar-not-running";
  const listing = await attempt(() => read(ps, "ps"));
  if (listing.reason !== undefined) return report("CANNOT-LOOK", name, listing.reason);
  const processes = listing.value.split("\n").filter((line) => /^\s*\d+\s/.test(line));
  if (processes.length === 0) return report("CANNOT-LOOK", name, "ps listed no processes");
  const polar = processes.filter((line) => POLAR_PROCESS.test(line));
  if (polar.length > 0) return report("FAIL", name, `running: ${oneLine(polar[0])}`);
  report("PASS", name, `processes=${processes.length} matched=0`);
}

async function checkCompose(readCompose, report, t) {
  const name = "compose-restart-policy";
  const file = t.composePath;
  const policy = await attempt(async () => {
    let text;
    try {
      text = await readCompose(file);
    } catch (error) {
      throw new CannotLook(`compose file unreadable: ${oneLine(error.message)}`);
    }
    return composeRestartPolicy(text);
  });
  if (policy.reason !== undefined) return report("CANNOT-LOOK", name, policy.reason);
  report(policy.value === "unless-stopped" ? "PASS" : "FAIL", name, `backend1 restart=${policy.value ?? "absent"}`);
}

async function checkRestartCounts({ docker, sleep, report, firstSample, t }) {
  const name = "restart-counts-steady";
  if (!firstSample) return report("CANNOT-LOOK", name, "blocked-by=containers");
  await sleep(RESTART_WINDOW_MS);
  const second = await attempt(() => inspectContainers(docker, t.containers));
  if (second.reason !== undefined) return report("CANNOT-LOOK", name, second.reason);
  const counts = (sample, c) => sample.get(c).restartCount;
  const changed = t.containers
    .filter((c) => counts(firstSample, c) !== counts(second.value, c))
    .map((c) => `${c}:${counts(firstSample, c)}->${counts(second.value, c)}`);
  const value = `window=${RESTART_WINDOW_MS / 1000}s changed=[${changed}]`;
  report(changed.length > 0 ? "FAIL" : "PASS", name, value);
}

async function checkBitcoind({ docker, report, running, t }) {
  const name = "bitcoind";
  if (!running.has(t.backend)) {
    report("CANNOT-LOOK", name, "blocked-by=containers");
    return null;
  }
  const chain = await attempt(() => readChain(docker, t));
  if (chain.reason !== undefined) {
    report("CANNOT-LOOK", name, chain.reason);
    return null;
  }
  const { blocks, headers, bestHash, ibd } = chain.value;
  const value = `blocks=${blocks} headers=${headers} hash=${bestHash} initialblockdownload=${ibd}`;
  report(blocks === headers ? "PASS" : "FAIL", name, value);
  return chain.value;
}

async function readNode(docker, node, running) {
  if (!running.has(node.container)) return { ...node, info: null, reason: "blocked-by=containers" };
  const info = await attempt(() => readGetinfo(docker, node));
  return { ...node, info: info.value ?? null, reason: info.reason };
}

const describeNode = (info, chain) =>
  `synced=${info.synced} height=${info.height} hash=${info.hash}` +
  (chain ? ` bitcoind-match=${matchesTip(info, chain) ? "yes" : "no"}` : "");

async function checkLnds({ docker, sleep, report, running, chain, repair, t }) {
  const before = await Promise.all(t.lndNodes.map((node) => readNode(docker, node, running)));
  let after = null;

  if (repair && before.some((n) => n.info && !n.info.synced)) {
    if (decideMine({ repair, chain, nodes: before })) {
      after = await mineAndRecheck({ docker, sleep, report, running, before, t });
    } else {
      report("FAIL", "repair-stale-tip", "mined=0 reason=stale-tip-condition-not-met");
    }
  }

  for (const [i, node] of before.entries()) {
    const name = `synced-to-chain:${node.name}`;
    const current = after ? after[i] : node;
    if (!current.info) {
      report("CANNOT-LOOK", name, current.reason);
    } else if (current.info.synced) {
      const status = node.info && !node.info.synced ? "REPAIRED" : "PASS";
      report(status, name, describeNode(current.info, after ? null : chain));
    } else {
      report("FAIL", name, describeNode(current.info, after ? null : chain));
    }
  }
  return after ?? before;
}

async function mineAndRecheck({ docker, sleep, report, running, before, t }) {
  const args = ["exec", "-u", "bitcoin", t.backend, "bitcoin-cli", "-regtest", "generatetodescriptor", "1", "raw(6a)"];
  const mined = await attempt(() => read(() => docker(args), "generatetodescriptor"));
  if (mined.reason !== undefined) {
    report("FAIL", "repair-stale-tip", mined.reason);
    return null;
  }

  // LNDs flip within seconds of the block, not at once.
  let nodes = before;
  for (let i = 0; i < RECHECK_ATTEMPTS; i++) {
    await sleep(RECHECK_INTERVAL_MS);
    nodes = await Promise.all(t.lndNodes.map((node) => readNode(docker, node, running)));
    if (nodes.every((n) => n.info?.synced)) break;
  }
  const done = nodes.every((n) => n.info?.synced);
  report(done ? "REPAIRED" : "FAIL", "repair-stale-tip", `mined=1 re-check=${done ? "all-synced" : "not-all-synced"}`);
  return nodes;
}

function spokes(nodes, running, t) {
  const others = nodes.filter((n) => n.container !== t.treasury);
  const blocked = others.filter((n) => !n.info).map((n) => n.name);
  if (!running.has(t.treasury)) return { blockedBy: "blocked-by=containers" };
  if (blocked.length > 0) return { blockedBy: `blocked-by=getinfo:${blocked}` };
  return { others, expected: others.map((n) => n.info.pubkey) };
}

const describeSets = ({ missing, unexpected }, others, observed) => {
  const nameOf = (key) => others.find((n) => n.info.pubkey === key)?.name ?? key;
  return `expected=${others.length} observed=${observed.length} ` +
    `missing=[${missing.map(nameOf)}] unexpected=[${unexpected.map(nameOf)}]`;
};

async function checkPeers({ docker, report, running, nodes, repair, t }) {
  const name = "treasury-peers";
  const { blockedBy, others, expected } = spokes(nodes, running, t);
  if (blockedBy) {
    report("CANNOT-LOOK", name, blockedBy);
    return false;
  }

  const peers = await attempt(() => readPeers(docker, t));
  if (peers.reason !== undefined) {
    report("CANNOT-LOOK", name, peers.reason);
    return false;
  }
  const before = compareSets(expected, peers.value);
  if (before.ok) {
    report("PASS", name, describeSets(before, others, peers.value));
    return false;
  }
  if (!repair || before.missing.length === 0) {
    report("FAIL", name, describeSets(before, others, peers.value));
    return false;
  }

  const attempted = [];
  for (const pubkey of before.missing) {
    const node = others.find((n) => n.info.pubkey === pubkey);
    const args = lndArgs(t.treasuryNode, "connect", `${pubkey}@${node.host}:9735`);
    const connected = await attempt(() => read(() => docker(args), "lncli connect"));
    if (connected.reason !== undefined) report("FAIL", `repair-peer:${node.name}`, connected.reason);
    else attempted.push(node);
  }

  const recheck = await attempt(() => readPeers(docker, t));
  if (recheck.reason !== undefined) {
    for (const node of attempted) report("FAIL", `repair-peer:${node.name}`, "re-check unreadable");
    report("CANNOT-LOOK", name, recheck.reason);
    return false;
  }
  for (const node of attempted) {
    const present = recheck.value.includes(node.info.pubkey);
    report(present ? "REPAIRED" : "FAIL", `repair-peer:${node.name}`, `present=${present}`);
  }
  const after = compareSets(expected, recheck.value);
  report(after.ok ? "REPAIRED" : "FAIL", name, describeSets(after, others, recheck.value));
  return attempted.length > 0;
}

async function checkChannels({ docker, sleep, report, running, nodes, peersRepaired, t }) {
  const name = "treasury-channels";
  const { blockedBy, others, expected } = spokes(nodes, running, t);
  if (blockedBy) return report("CANNOT-LOOK", name, blockedBy);

  // A channel goes active a moment after its peer reconnects. This only waits;
  // it repairs nothing.
  const attempts = peersRepaired ? RECHECK_ATTEMPTS : 1;
  let channels;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(RECHECK_INTERVAL_MS);
    channels = await attempt(() => readChannels(docker, t));
    if (channels.value && compareSets(expected, channels.value).ok) break;
  }
  if (channels.reason !== undefined) return report("CANNOT-LOOK", name, channels.reason);
  const result = compareSets(expected, channels.value);
  report(result.ok ? "PASS" : "FAIL", name, describeSets(result, others, channels.value));
}

// ─── entry point ──────────────────────────────────────────────────────────

// The lock (H14, D11a): the CLI refuses, exit 2, before any check runs, unless
// the slot's lock is held by HARNESS_HOLDER, as the dev:* scripts do. It refuses
// after the argument check, so an unknown flag is still named as one.
export async function main(args = process.argv.slice(2), {
  env = process.env, home = os.homedir(), run = runPreflight, err = console.error,
} = {}) {
  const unknown = args.find((arg) => arg !== "--repair");
  if (unknown !== undefined) {
    err(`polar-preflight: unknown argument ${unknown}; the only flag is --repair`);
    return 2;
  }
  let refusal;
  try {
    refusal = lockRefusal(parseSlot(env.HARNESS_SLOT), env.HARNESS_HOLDER, home);
  } catch (error) {
    refusal = error.message;
  }
  if (refusal) {
    err(`polar-preflight: ${refusal}`);
    return 2;
  }
  const { exitCode } = await run({ repair: args.includes("--repair"), env });
  return exitCode;
}

// realpath both ways: a mismatch here would import this file, run nothing and
// exit 0, which is the one outcome a gate must not produce.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`polar-preflight failed: ${error.stack ?? error}`);
      process.exit(2);
    },
  );
}
