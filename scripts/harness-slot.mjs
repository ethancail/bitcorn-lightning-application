#!/usr/bin/env node
// harness-slot.mjs — the dev harness's slot-dependent values, computed from a
// slot number, and the dev:* npm scripts' command lines built from them.
//
// Run:  node scripts/harness-slot.mjs command <npm-script>   print the resolved command line
//       node scripts/harness-slot.mjs run <npm-script> [args]  run it under sh
//       node scripts/harness-slot.mjs lock acquire|release|status ...   the slot locks (H14)
//       node scripts/harness-slot.mjs heavy run -- <command> [args]    one heavy job per machine
//       node scripts/harness-slot.mjs heavy acquire|release|status ... (see "the heavy lock" below)
// The root package.json's dev:* scripts call `run`. The slot comes from
// HARNESS_SLOT, default 1. Callers in other repos run the main checkout's copy
// (ruling 6), under Node 20, with an argument list.
//
// THE LOCK (H14, D11): `run` refuses every script unless the slot's lock,
// ~/.bitcorn-dev/locks/slot-N.lock, exists and its holder equals
// HARNESS_HOLDER, and refuses while setup.lock is held. The refusal names the
// holder, or "no lock". Read-only needs no lock: `command`, `lock status` and
// dev:kill --print. scripts/polar-preflight.mjs enforces the same lock.
//
// SLOT 1 IS TODAY'S HARNESS (D6). Its command lines are byte-identical to the
// scripts at 523e6ab, except dev:loopserver (D13: the bridge network, bound to
// 127.0.0.1) and dev:kill (H11: no loopserver port, the loopd REST ports added,
// a --print mode; H15: listening sockets only) and the API lines, which carry
// API_LISTEN_HOST=127.0.0.1 (dev-safety R2, superseding D15 for that one
// value). Slot 1 injects nothing else: today's .env.dev.<role> files stay
// authoritative for every other value.
//
// SLOT N (N >= 2), per D8:
//   API ports        3101-3103 + 10(N-1)     web ports   5173-5175 + 10(N-1)
//   loopserver       11009 + 100(N-1)        loopd RPC   11010/11020/11030 + 100(N-1)
//   loopd REST       8801-8803 + 100(N-1)
//   data dirs        ~/.bitcorn-dev/slot-N/<role>
//   loopserver name  bitcorn-loopserver-N
//   Polar network    the one named bitcorn-dev-N in ~/.polar/networks/networks.json;
//                    absent is an error, never a fallback to network 1
//   API env files    .env.dev.slot-N.<role> (D14: slot N's identity), with the
//                    computed values above, BITCOIN_NETWORK=regtest,
//                    LOOP_GRPC_HOST=127.0.0.1 and API_LISTEN_HOST=127.0.0.1
//                    injected over them (D7; R2). dotenv-cli
//                    does not override a variable already set, so the injected
//                    values win; the scripts must never pass it -o.
//
// Refused: a computed port equal to a reserved one (3109, 13009), so slot 21 is
// an error; a Polar network whose node names are not D16's five.
//
// Spec (vault): specs/2026-11-09-harness-host-b2-slot-implementation-spec.md,
// H7 to H12, H14 (the lock) and H15 (dev:kill, listeners only). The heavy lock:
// decisions/2026-11-18-workflow-app-heavy-lock-and-rulings-… (H1–H7) and
// specs/2026-11-18-heavy-lock-spec.md, as amended by Ethan's A1–A4.
// Tests: scripts/harness-slot.test.mjs and scripts/harness-slot-heavy.test.mjs,
// run by hand under Node 20.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RESERVED_PORTS = new Map([
  [3109, "the app's reserved node-to-node port"],
  [13009, "lnagent's tunnel port"],
]);

// D16: every slot's Polar network has exactly these nodes.
export const BITCOIN_NODE = "backend1";
export const LND_NODE_NAMES = ["Treasury", "Merchant1", "Farmer1", "External-Peer-1"];

export const ROLES = [
  { role: "treasury", key: "T", node: "Treasury", api: "dev:treasury" },
  { role: "member-a", key: "A", node: "Farmer1", api: "dev:memberA" },
  { role: "member-b", key: "B", node: "Merchant1", api: "dev:memberB" },
];

// ─── the slot and its values ──────────────────────────────────────────────

export function parseSlot(raw) {
  if (raw === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_SLOT must be a whole number from 1, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function assertNoReserved(ports, slot) {
  for (const port of ports) {
    if (RESERVED_PORTS.has(port)) {
      throw new Error(`slot ${slot} refused: its computed port ${port} is ${RESERVED_PORTS.get(port)}`);
    }
  }
}

export function slotPorts(slot) {
  const k = slot - 1;
  const ports = {
    api: [3101, 3102, 3103].map((p) => p + 10 * k),
    web: [5173, 5174, 5175].map((p) => p + 10 * k),
    loopserver: 11009 + 100 * k,
    loopdRpc: [11010, 11020, 11030].map((p) => p + 100 * k),
    loopdRest: [8801, 8802, 8803].map((p) => p + 100 * k),
  };
  assertNoReserved([...ports.api, ...ports.web, ports.loopserver, ...ports.loopdRpc, ...ports.loopdRest], slot);
  return ports;
}

// The command lines are shell text, so a home directory outside this set is
// refused rather than quoted: quoting would change slot 1's text.
function checkHome(home) {
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(home)) {
    throw new Error(`home directory ${JSON.stringify(home)} has characters these command lines do not quote`);
  }
  return home;
}

export const dataDir = (slot, role, home) =>
  slot === 1 ? `${checkHome(home)}/.bitcorn-dev/${role}` : `${checkHome(home)}/.bitcorn-dev/slot-${slot}/${role}`;

export const loopserverContainer = (slot) => (slot === 1 ? "bitcorn-loopserver" : `bitcorn-loopserver-${slot}`);

export const envFile = (slot, role) => (slot === 1 ? `.env.dev.${role}` : `.env.dev.slot-${slot}.${role}`);

// Slot 1 resolves by id 1 (named bitcorn-dev, not bitcorn-dev-1); slot N by the
// name bitcorn-dev-N. Either way the node names must be D16's five.
export function resolveNetwork(slot, networksJson) {
  const networks = networksJson?.networks;
  if (!Array.isArray(networks)) throw new Error("networks.json has no networks array");
  const wanted = slot === 1 ? "id 1" : `the name bitcorn-dev-${slot}`;
  const matches = networks.filter((n) => (slot === 1 ? n.id === 1 : n.name === `bitcorn-dev-${slot}`));
  if (matches.length === 0) throw new Error(`slot ${slot}: no Polar network with ${wanted} in networks.json`);
  if (matches.length > 1) throw new Error(`slot ${slot}: ${matches.length} Polar networks with ${wanted}`);
  const network = matches[0];

  const nodes = network.nodes ?? {};
  const all = Object.values(nodes).flat().map((n) => n?.name).sort();
  const bitcoin = (nodes.bitcoin ?? []).map((n) => n?.name);
  const expected = [BITCOIN_NODE, ...LND_NODE_NAMES].sort();
  if (JSON.stringify(all) !== JSON.stringify(expected) || !bitcoin.includes(BITCOIN_NODE)) {
    throw new Error(
      `slot ${slot}: Polar network ${network.id} (${network.name}) has nodes [${all}], ` +
      `not the five every slot uses [${expected}]`,
    );
  }

  const lndGrpcPort = {};
  for (const node of nodes.lightning ?? []) {
    if (!Number.isInteger(node.ports?.grpc)) {
      throw new Error(`slot ${slot}: networks.json gives ${node.name} no integer grpc port`);
    }
    lndGrpcPort[node.name] = node.ports.grpc;
  }
  if (!Number.isInteger(network.id)) throw new Error(`slot ${slot}: networks.json gives no integer network id`);
  return { id: network.id, name: network.name, lndGrpcPort };
}

const lndVolume = (home, networkId, node) => `${checkHome(home)}/.polar/networks/${networkId}/volumes/lnd/${node}`;

// Slot N's files hold identity only (D14), so the two settings a dev API cannot
// do without, and whose API defaults are production values, are injected too
// (Ethan's ruling, option (b), 2026-11-09). Slot 1 gets them from its own files.
export const SLOT_N_SETTINGS = { BITCOIN_NETWORK: "regtest", LOOP_GRPC_HOST: "127.0.0.1" };

// dev-safety R2 (vault: decisions/2026-11-13-dev-safety-rulings-r1-to-r5-…):
// every slot's API binds loopback only. The API reads it in ports.ts; unset
// there means production's bind, so the harness is its single statement.
export const ALL_SLOT_SETTINGS = { API_LISTEN_HOST: "127.0.0.1" };

// Slot 1: ALL_SLOT_SETTINGS only (R2 supersedes D15 for that value). Slot N:
// its computed values, SLOT_N_SETTINGS and ALL_SLOT_SETTINGS, over its own files.
export function injectedEnv(slot, roleIndex, ctx) {
  if (slot === 1) return { ...ALL_SLOT_SETTINGS };
  const { role, node } = ROLES[roleIndex];
  const ports = slotPorts(slot);
  const network = ctx.network();
  const dir = dataDir(slot, role, ctx.home);
  return {
    PORT: String(ports.api[roleIndex]),
    DB_DIR: `${dir}/db`,
    SECRETS_DIR: `${dir}/secrets`,
    LND_GRPC_HOST: `127.0.0.1:${network.lndGrpcPort[node]}`,
    LND_DIR: lndVolume(ctx.home, network.id, node),
    LOOP_GRPC_PORT: String(ports.loopdRpc[roleIndex]),
    LOOP_TLS_CERT_PATH: `${dir}/loopd/regtest/tls.cert`,
    LOOP_MACAROON_PATH: `${dir}/loopd/regtest/loop.macaroon`,
    ...SLOT_N_SETTINGS,
    ...ALL_SLOT_SETTINGS,
  };
}

// ─── the command lines ────────────────────────────────────────────────────

// Slot 1's member lines carry two spaces before `--`, as they did at 523e6ab.
const API_GAP = { treasury: " ", "member-a": "  ", "member-b": "  " };

function apiCommand(slot, roleIndex, ctx) {
  const { role } = ROLES[roleIndex];
  const assignments = Object.entries(injectedEnv(slot, roleIndex, ctx)).map(([k, v]) => `${k}=${v} `).join("");
  const gap = slot === 1 ? API_GAP[role] : " ";
  return `cd app/api && ${assignments}dotenv -e ../../${envFile(slot, role)}${gap}-- npm run dev`;
}

function webCommand(slot, roleIndex) {
  const ports = slotPorts(slot);
  return `cd app/web && VITE_API_BASE=http://localhost:${ports.api[roleIndex]} npm run dev -- --port ${ports.web[roleIndex]} --strictPort`;
}

function loopdCommand(slot, roleIndex, ctx) {
  const { role, node } = ROLES[roleIndex];
  const ports = slotPorts(slot);
  const network = ctx.network();
  const lnd = lndVolume(ctx.home, network.id, node);
  return [
    "~/.bitcorn-dev/loopserver/loopd --network=regtest",
    `--loopdir=${dataDir(slot, role, ctx.home)}/loopd`,
    `--rpclisten=localhost:${ports.loopdRpc[roleIndex]}`,
    `--restlisten=localhost:${ports.loopdRest[roleIndex]}`,
    `--lnd.host=127.0.0.1:${network.lndGrpcPort[node]}`,
    `--lnd.macaroonpath=${lnd}/data/chain/bitcoin/regtest/admin.macaroon`,
    `--lnd.tlspath=${lnd}/tls.cert`,
    `--server.host=localhost:${ports.loopserver}`,
    "--server.notls",
  ].join(" ");
}

// D9, D12, D13: every slot's loopserver on its Polar network's bridge, RPC
// mapped to 127.0.0.1 only, dialing LND and bitcoind by container name at the
// CONTAINER's ports. ZMQ: rawblock is 28334 and rawtx 28335 inside the
// container (28335 and 29336 on the host), so the host numbers must not be
// carried over. The status port (1100) is not mapped.
function loopserverCommand(slot, ctx) {
  const network = ctx.network();
  const name = loopserverContainer(slot);
  const port = slotPorts(slot).loopserver;
  const n = `polar-n${network.id}-`;
  return [
    `docker rm -f ${name} 2>/dev/null;`,
    `docker run -d --name ${name}`,
    `--network polar-network-${network.id}_default`,
    `-p 127.0.0.1:${port}:11009`,
    `-v ${lndVolume(ctx.home, network.id, "External-Peer-1")}:/lnd:ro`,
    "lightninglabs/loopserver:v0.9.221-beta daemon --maxamt=5000000",
    `--lnd.host=${n}External-Peer-1:10009`,
    "--lnd.macaroondir=/lnd/data/chain/bitcoin/regtest --lnd.tlspath=/lnd/tls.cert",
    `--bitcoin.host=${n}backend1:18443`,
    "--bitcoin.user=polaruser --bitcoin.password=polarpass",
    `--bitcoin.zmqpubrawblock=tcp://${n}backend1:28334`,
    `--bitcoin.zmqpubrawtx=tcp://${n}backend1:28335`,
    `&& echo 'loopserver started on 127.0.0.1:${port} — check \`docker logs ${name}\` (persists on crash)'`,
  ].join(" ");
}

const loopserverStopCommand = (slot) =>
  `docker stop ${loopserverContainer(slot)} 2>/dev/null && echo 'loopserver stopped'`;

// H11: the slot's API, web, loopd RPC and loopd REST ports. Not loopserver's:
// under D13 its port is held by Docker's root-owned proxy, which this cannot
// see or kill; dev:loopserver-stop stops it.
export function killPorts(slot) {
  const p = slotPorts(slot);
  return [...p.api, ...p.web, ...p.loopdRpc, ...p.loopdRest];
}

// H15: listening sockets only. `lsof -i:<port>` also matches a connection whose
// REMOTE end is that port (a browser holding a connection to another host's
// 3101, say), and dev:kill would kill -9 it. -sTCP:LISTEN keeps only listeners.
// --print uses the same selection, so it lists exactly what a real run kills.
const listenerPids = (ports) => `lsof -t -nP -iTCP:${ports} -sTCP:LISTEN`;

function killCommand(slot, print) {
  const ports = killPorts(slot).join(",");
  if (print) return `${listenerPids(ports)} || echo 'no listener on slot ${slot} ports'`;
  return `${listenerPids(ports)} | xargs -r kill -9 2>/dev/null; ` +
    "echo 'dev ports cleared (incl loopd; stop loopserver with npm run dev:loopserver-stop)'";
}

export const SCRIPTS = [
  "dev:treasury", "dev:memberA", "dev:memberB",
  "dev:webT", "dev:webA", "dev:webB",
  "dev:kill",
  "dev:loopserver", "dev:loopd-T", "dev:loopd-A", "dev:loopd-B",
  "dev:loopserver-stop",
];

const quote = (arg) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

// The script name and dev:kill's arguments, checked before anything else
// (main checks them before the lock, so an unknown script is named as such).
export function checkScript(script, args = []) {
  if (!SCRIPTS.includes(script)) throw new Error(`no slot command for ${JSON.stringify(script)}; known: ${SCRIPTS.join(" ")}`);
  if (script === "dev:kill") {
    const unknown = args.filter((a) => a !== "--print");
    if (unknown.length > 0) throw new Error(`dev:kill takes only --print, got ${unknown.join(" ")}`);
  }
}

// Read-only, so they need no lock (H14): printing a command line (the `command`
// subcommand) and dev:kill --print. Everything else `run` starts, stops or kills.
export const isReadOnlyRun = (script, args = []) => script === "dev:kill" && args.includes("--print");

// ctx: { home, network() } — network() resolves lazily, so the scripts that
// need no Polar network (web, kill, stop, slot 1's API) never read networks.json.
export function scriptCommand(script, slot, ctx, args = []) {
  checkScript(script, args);
  const roleIndex = ROLES.findIndex((r) => r.api === script || `dev:web${r.key}` === script || `dev:loopd-${r.key}` === script);
  let command;
  if (script === "dev:kill") {
    return killCommand(slot, args.includes("--print"));
  } else if (script === "dev:loopserver") command = loopserverCommand(slot, ctx);
  else if (script === "dev:loopserver-stop") command = loopserverStopCommand(slot);
  else if (script.startsWith("dev:web") && roleIndex >= 0) command = webCommand(slot, roleIndex);
  else if (script.startsWith("dev:loopd-") && roleIndex >= 0) command = loopdCommand(slot, roleIndex, ctx);
  else if (roleIndex >= 0) command = apiCommand(slot, roleIndex, ctx);
  else throw new Error(`no slot command for ${JSON.stringify(script)}; known: ${SCRIPTS.join(" ")}`);
  // Extra npm arguments land at the end, as they did when the script was literal text.
  return args.length > 0 ? `${command} ${args.map(quote).join(" ")}` : command;
}

// ─── the lock (H14, D11) ──────────────────────────────────────────────────
//
// One lock per slot, ~/.bitcorn-dev/locks/slot-N.lock, and one host-wide lock
// for Polar setup windows, setup.lock. A lock file is created with an exclusive
// create, so a second acquire fails. It holds holder, go, acquired_at (UTC),
// host and the slot number or "setup". The go is a claim: the lock records what
// the acquirer typed and cannot verify it (D11b). Every acquire, release and
// forced release appends one line to history.log. A setup lock and a slot lock
// never coexist: each acquire checks for the other kind before and after its
// own create, and backs out if one appeared in between.
//
// dev-safety (vault: decisions/2026-11-13-dev-safety-rulings-r1-to-r5-…):
// R3 — an unreadable lock is refused by enforcement and by plain release,
//      decided on readLock's `unreadable` flag, never on a holder string; only
//      --force --reason frees it. Acquire writes a complete temp file in locks/
//      and links it into place, so the lock path never exists half-written.
// R4 — release, forced release and acquire's back-out never unlink the lock
//      path after reading it. They rename it to a tombstone private to this
//      process (atomic: of several removers exactly one wins), check the
//      tombstone, then unlink it, or link it back and refuse. The residual:
//      POSIX has no compare-and-delete, so on the refuse path the lock that
//      was there is missing from the rename to the link back; if another
//      acquire lands in that gap, the link back fails and that is reported
//      loudly, with the tombstone kept. heldSlots' anchored regex ignores
//      temp and tombstone names.
// R5 — lock status flags a lock SUSPECT when it is over 24 hours old, taken on
//      another host, or (a slot lock) has no listener on the slot's ports. It
//      frees nothing: the holder is an arc, not a process, so no signal says
//      it is gone. Freeing stays --force --reason.
//
// `race` (acquireLock, releaseLock, forceReleaseLock) is a test seam: callbacks
// run at fixed points, so a test can put another process's lock operations
// between this one's steps. Nothing outside the tests passes it.

export const lockDir = (home) => path.join(home, ".bitcorn-dev", "locks");
const lockFile = (home, target) =>
  path.join(lockDir(home), target === "setup" ? "setup.lock" : target === "heavy" ? "heavy.lock" : `slot-${target}.lock`);
const historyFile = (home) => path.join(lockDir(home), "history.log");
const lockName = (target) => (target === "setup" || target === "heavy" ? target : `slot ${target}`);
const lockFlag = (target) => (target === "setup" ? "--setup" : `--slot ${target}`);
const releaseCommand = (target) => (target === "heavy" ? "heavy release" : `lock release ${lockFlag(target)}`);
const utc = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
const privateName = (file, kind) => `${file}.${kind}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;

// { unreadable: true } when the text does not parse as a lock.
function parseLock(text) {
  try {
    const lock = JSON.parse(text);
    if (typeof lock?.holder === "string") return lock;
  } catch {}
  return { unreadable: true, holder: "(unreadable lock file)" };
}

// The lock file's text, or null when there is none.
function readLockText(home, target) {
  try {
    return fs.readFileSync(lockFile(home, target), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// null when there is no lock; { unreadable: true } when the file does not parse.
export function readLock(home, target) {
  const text = readLockText(home, target);
  return text === null ? null : parseLock(text);
}

const unreadableRefusal = (home, target) =>
  `${lockName(target)}'s lock file ${lockFile(home, target)} is unreadable, so its holder cannot be checked; ` +
  `if it is stale, free it with ${releaseCommand(target)} --force --reason "<why>"`;

// R4: remove `target`'s lock by renaming it to a private tombstone, then
// check(lock, text) the tombstone: null unlinks it and returns the lock; a
// refusal links it back and throws that refusal. Returns null, removing
// nothing, when there is no lock to rename.
function removeLock(home, target, check, race = {}) {
  const file = lockFile(home, target);
  const tomb = privateName(file, "release");
  race.beforeRemove?.();
  try {
    fs.renameSync(file, tomb);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  race.afterRename?.();
  const text = fs.readFileSync(tomb, "utf8");
  const lock = parseLock(text);
  const refusal = check(lock, text);
  if (refusal === null) {
    fs.unlinkSync(tomb);
    return lock;
  }
  try {
    fs.linkSync(tomb, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`${refusal}. AND the lock this took out could not be put back: ${lockName(target)} was ` +
      `acquired again while it was out (now held by ${JSON.stringify(readLock(home, target)?.holder)}). ` +
      `The lock taken out is kept at ${tomb}; nothing else was removed`);
  }
  fs.unlinkSync(tomb);
  throw new Error(refusal);
}

function heldSlots(home) {
  let names;
  try {
    names = fs.readdirSync(lockDir(home));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.map((n) => n.match(/^slot-([1-9][0-9]*)\.lock$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

// The other kind of lock that stands in the way of acquiring `target`, or null.
function exclusionConflict(home, target) {
  if (target === "setup") {
    const slots = heldSlots(home);
    return slots.length === 0 ? null :
      `setup refused: slot locks are held (${slots.map((s) => `slot ${s} by ${JSON.stringify(readLock(home, s)?.holder)}`).join(", ")})`;
  }
  const setup = readLock(home, "setup");
  return setup === null ? null : `slot ${target} refused: setup.lock is held by ${JSON.stringify(setup.holder)}`;
}

function requireText(flag, value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${flag} must be given and not empty`);
  return value;
}

function appendHistory(home, line) {
  fs.appendFileSync(historyFile(home), `${line}\n`);
}

const field = (k, v) => `${k}=${JSON.stringify(v)}`;

function heldFor(from, to) {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return Number.isNaN(minutes) ? "?" : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// A3: a job holding the heavy lock never waits for a slot. Its refusal must not
// contain the two phrases bitcorn-workflow's tests/browser-slot.py waits on,
// "is already locked by " and "refused: setup.lock is held by ", so that
// caller fails at once, its command fails, and the heavy wrapper releases.
const heavyNoWait = (target, what) =>
  `${lockName(target)} refused: this job holds the heavy lock, and a heavy-lock holder never waits for a slot; ${what}`;

function slotRefusalUnderHeavy(home, target) {
  const setup = readLock(home, "setup");
  return setup === null ? null : heavyNoWait(target, `a Polar setup window holds setup.lock (holder ${JSON.stringify(setup.holder)})`);
}

// heavyHeld: this process descends from the heavy lock's holder (heldByThisJob), so A3 applies.
export function acquireLock({ home, target, holder, go, now = new Date(), host = os.hostname(), race = {}, heavyHeld = false }) {
  requireText("--holder", holder);
  requireText("--go", go);
  const before = exclusionConflict(home, target);
  if (before) throw new Error(heavyHeld && target !== "setup" ? slotRefusalUnderHeavy(home, target) ?? before : before);
  fs.mkdirSync(lockDir(home), { recursive: true });
  const lock = { holder, go, acquired_at: utc(now), host, slot: target };
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  // R3: written whole to a temp file, then linked into place, which fails with
  // EEXIST if the lock exists: the lock path never holds a partial file.
  const tmp = privateName(lockFile(home, target), "tmp");
  fs.writeFileSync(tmp, text, { flag: "wx" });
  try {
    fs.linkSync(tmp, lockFile(home, target));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const held = readLock(home, target);
    if (heavyHeld && target !== "setup") {
      throw new Error(heavyNoWait(target, `${lockName(target)} is held by ${JSON.stringify(held?.holder)}` +
        (held?.acquired_at ? ` since ${held.acquired_at}` : "")));
    }
    // workflow-app waits on "is already locked by" (bitcorn-workflow tests/browser-slot.py): keep it.
    throw new Error(`${lockName(target)} is already locked by ${JSON.stringify(held?.holder)}` +
      (held?.acquired_at ? ` since ${held.acquired_at}, go ${JSON.stringify(held.go)}` : "") +
      (held?.unreadable ? ` (${unreadableRefusal(home, target)})` : ""));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  race.afterCreate?.();
  const after = exclusionConflict(home, target);
  if (after) {
    // R4: back out only the lock this acquire wrote, byte for byte.
    removeLock(home, target, (held, heldText) => (heldText === text ? null :
      `${after}; and ${lockName(target)} is no longer this acquire's lock (now held by ` +
      `${JSON.stringify(held.holder)}), so it was left in place`), race);
    throw new Error(heavyHeld && target !== "setup" ? slotRefusalUnderHeavy(home, target) ?? after : after);
  }
  appendHistory(home, `${utc(now)} acquire ${field("lock", lockName(target))} ${field("holder", holder)} ${field("go", go)} ${field("host", host)}`);
  return `acquired ${lockName(target)} for ${holder}: ${lockFile(home, target)}`;
}

export function releaseLock({ home, target, holder, now = new Date(), race = {} }) {
  requireText("--holder", holder);
  const noLock = `${lockName(target)}: no lock to release`;
  // R3: an unreadable lock is refused on its flag, whatever --holder says.
  const refusal = (held) => (held.unreadable ? unreadableRefusal(home, target) :
    held.holder !== holder ? `${lockName(target)} is held by ${JSON.stringify(held.holder)}, not ${JSON.stringify(holder)}; ` +
      "a stale lock is cleared with lock release --force --reason \"<why>\"" : null);
  // The check before the remove is not authoritative (R4): removeLock checks again what it actually took out.
  const seen = readLock(home, target);
  if (seen === null) throw new Error(noLock);
  if (refusal(seen) !== null) throw new Error(refusal(seen));
  const lock = removeLock(home, target, refusal, race);
  if (lock === null) throw new Error(`${noLock} (it was removed after it was read)`);
  return releasedLine(home, target, holder, lock, utc(now));
}

// The history line and the release line. The heavy lock has no go (ruling 7),
// so its line ends at the host.
function releasedLine(home, target, holder, lock, at) {
  appendHistory(home, `${at} release ${field("lock", lockName(target))} ${field("holder", holder)} ` +
    `${field("acquired_at", lock.acquired_at)} ${field("held", heldFor(lock.acquired_at, at))}`);
  return `harness lock released: ${lockName(target)}, holder ${holder}, held ${lock.acquired_at} to ${at} ` +
    `(${heldFor(lock.acquired_at, at)}) on ${lock.host}` + (lock.go === undefined ? "" : `; go ${JSON.stringify(lock.go)}`);
}

export function forceReleaseLock({ home, target, reason, now = new Date(), race = {} }) {
  requireText("--reason", reason);
  const noLock = `${lockName(target)}: no lock to release`;
  // R4: force frees the lock it read, whoever holds it, and only that lock: if
  // what it takes out differs by a byte from what it read, it is put back.
  const seenText = readLockText(home, target);
  if (seenText === null) throw new Error(noLock);
  const lock = removeLock(home, target, (held, heldText) => (heldText === seenText ? null :
    `${lockName(target)} changed between the check and the release (now held by ${JSON.stringify(held.holder)}); ` +
    "nothing was released: run lock status and decide again"), race);
  if (lock === null) throw new Error(`${noLock} (it was removed after it was read)`);
  const at = utc(now);
  appendHistory(home, `${at} force-release ${field("lock", lockName(target))} ${field("holder", lock.holder)} ` +
    `${field("acquired_at", lock.acquired_at ?? null)} ${field("reason", reason)}`);
  return `harness lock FORCE-released: ${lockName(target)}, was held by ${lock.holder} since ${lock.acquired_at ?? "?"}; ` +
    `reason ${JSON.stringify(reason)}`;
}

// R5: whether anything listens on these TCP ports, by the selection dev:kill
// uses (H15): true, false, or null when lsof could not say. lsof sees only
// this user's processes, as dev:kill does.
export function portsListening(ports) {
  const r = spawnSync("lsof", ["-t", "-nP", `-iTCP:${ports.join(",")}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (r.error || r.status === null) return null;
  if (r.stdout.trim() !== "") return true;
  return r.status === 1 ? false : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// R5: the reasons a lock looks stale, and whether its listener check ran.
function suspicion(target, lock, { now, host, listening }) {
  const reasons = [];
  const age = now.getTime() - Date.parse(lock.acquired_at);
  if (Number.isNaN(age)) reasons.push(`its acquired_at ${JSON.stringify(lock.acquired_at)} is not a time`);
  else if (age > DAY_MS) reasons.push(`held ${heldFor(lock.acquired_at, utc(now))}, over 24h`);
  if (lock.host !== host) reasons.push(`host ${JSON.stringify(lock.host)} is not this host (${JSON.stringify(host)})`);
  let unchecked = false;
  if (target !== "setup") {
    let heard = null;
    try {
      heard = listening(killPorts(target));
    } catch {}
    if (heard === false) reasons.push(`no listener on ${lockName(target)}'s ports`);
    if (heard !== true && heard !== false) unchecked = true;
  }
  return { reasons, unchecked };
}

export function lockStatus(home, { now = new Date(), host = os.hostname(), listening = portsListening } = {}) {
  const lines = [];
  for (const target of ["setup", ...heldSlots(home)]) {
    const lock = readLock(home, target);
    if (lock === null) continue;
    if (lock.unreadable) {
      lines.push(`${lockName(target)}: lock file unreadable (${lockFile(home, target)})`);
      continue;
    }
    const { reasons, unchecked } = suspicion(target, lock, { now, host, listening });
    lines.push(`${lockName(target)}: held by ${lock.holder} since ${lock.acquired_at} on ${lock.host}; go ${JSON.stringify(lock.go)}` +
      (unchecked ? " (listener check could not run)" : "") +
      (reasons.length === 0 ? "" : ` — SUSPECT: ${reasons.join("; ")} — status frees nothing; ` +
        `if it is stale: lock release ${lockFlag(target)} --force --reason "<why>"`));
  }
  return lines.length > 0 ? lines.join("\n") : "no locks held";
}

// Enforcement (D11a): null when HARNESS_HOLDER holds the slot's lock, else the
// refusal, naming the current holder or "no lock".
export function lockRefusal(slot, harnessHolder, home) {
  const setup = readLock(home, "setup");
  if (setup !== null) return `slot ${slot} refused: setup.lock is held by ${JSON.stringify(setup.holder)} (a Polar setup window)`;
  const lock = readLock(home, slot);
  if (lock === null) {
    return `slot ${slot} refused: no lock. Acquire it first: node scripts/harness-slot.mjs lock acquire ` +
      `--slot ${slot} --holder <arc> --go "<who gave the go>", then set HARNESS_HOLDER=<arc>`;
  }
  // R3: on the flag, before any holder comparison, so no HARNESS_HOLDER can match an unreadable lock.
  if (lock.unreadable) return `slot ${slot} refused: ${unreadableRefusal(home, slot)}`;
  if (!harnessHolder) return `slot ${slot} refused: locked by ${JSON.stringify(lock.holder)}, and HARNESS_HOLDER is unset`;
  if (harnessHolder !== lock.holder) {
    return `slot ${slot} refused: locked by ${JSON.stringify(lock.holder)}, not HARNESS_HOLDER ${JSON.stringify(harnessHolder)}`;
  }
  return null;
}

const LOCK_USAGE =
  "usage: harness-slot.mjs lock acquire (--slot N | --setup) --holder <arc> --go \"<text>\"\n" +
  "       harness-slot.mjs lock release (--slot N | --setup) --holder <arc>\n" +
  "       harness-slot.mjs lock release (--slot N | --setup) --force --reason \"<text>\"\n" +
  "       harness-slot.mjs lock status";

function parseLockArgs(args) {
  const opts = {};
  const valued = { "--slot": "slot", "--holder": "holder", "--go": "go", "--reason": "reason" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in valued) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      opts[valued[arg]] = args[++i];
    } else if (arg === "--setup" || arg === "--force") {
      opts[arg.slice(2)] = true;
    } else {
      throw new Error(`unknown lock argument ${JSON.stringify(arg)}`);
    }
  }
  return opts;
}

function lockTarget(opts) {
  if ((opts.slot !== undefined) === Boolean(opts.setup)) throw new Error("give exactly one of --slot N or --setup");
  if (opts.setup) return "setup";
  if (!/^[1-9][0-9]*$/.test(opts.slot)) throw new Error(`--slot must be a whole number from 1, got ${JSON.stringify(opts.slot)}`);
  return Number(opts.slot);
}

export function lockMain(args, { home = os.homedir(), now = new Date(), host = os.hostname(), listening = portsListening, heavyHeld = false } = {}) {
  const [action, ...rest] = args;
  const opts = parseLockArgs(rest);
  if (action === "status") {
    if (Object.keys(opts).length > 0) throw new Error("lock status takes no arguments");
    return lockStatus(home, { now, host, listening });
  }
  if (action === "acquire") {
    if (opts.force || opts.reason !== undefined) throw new Error("--force and --reason belong to lock release");
    return acquireLock({ home, target: lockTarget(opts), holder: opts.holder, go: opts.go, now, host, heavyHeld });
  }
  if (action === "release") {
    if (opts.go !== undefined) throw new Error("--go belongs to lock acquire");
    const target = lockTarget(opts);
    if (opts.force) return forceReleaseLock({ home, target, reason: opts.reason, now });
    if (opts.reason !== undefined) throw new Error("--reason needs --force");
    return releaseLock({ home, target, holder: opts.holder, now });
  }
  throw new Error(LOCK_USAGE);
}

// ─── the heavy lock (H1–H7; A1–A4, Ethan 2026-11-18; on flock, 2026-11-19) ─
//
// One heavy job per machine at a time (H1). Heavy (H3): full test suites
// (vitest, node --test), mutation and negative-control batches, Polar gates and
// captures.
//
// THE LOCK IS THE KERNEL'S: an exclusive flock(2) on locks/heavy.lock in ONE
// account's home, taken by util-linux flock(1) (/usr/bin/flock; 2.39.3 on
// ubuntu-pc and on the OptiPlex) on a descriptor this process opened. A flock
// belongs to the open file, not to a process: every process holding that
// descriptor holds the lock, and the kernel frees it when the last of them has
// closed it or exited, however they exit (SIGKILL and the OOM killer included).
// So there is no take-over and no liveness check: a live job's lock is never
// found free, and a dead job's lock is never found held.
//
// What carries the descriptor: a heavy run's command gets it as its fd 9 (so do
// the Stop hook's checks), and a shell passes it on to the children it starts.
// A NODE OR PYTHON PROCESS DOES NOT: Node marks every descriptor it inherits
// close-on-exec at startup (02000000 in /proc/<pid>/fdinfo/9), and Python's
// subprocess closes every descriptor above 2 in its children unless named in
// pass_fds. Such a command holds the lock itself and its own children do not,
// so a job whose top process is SIGKILLed alone while those children run on
// frees the lock early. When a heavy run's top process exits, the wrapper ends
// the rest of its process group (SIGTERM, then SIGKILL after RUN_GRACE_MS), and
// reports the lock released only if no other process still holds the
// descriptor; one that left the group with it is named instead ("NOT
// released").
//
// heavy.lock is never written, truncated, replaced or removed: a removed lock
// file would let the next job lock a new file while a job holds the old one (an
// acquirer re-checks that the path still names the file it locked). Beside it,
// heavy.info.json says who holds it: written by the holder once it has the
// lock, removed by it before it lets go. It is for display and for A3 only; it
// is never the lock.
//
// A1 — the account is this host's entry in HEAVY_ACCOUNTS; its home comes from
//      the password database (os.userInfo()), never $HOME. Any other account,
//      and any host not in the table, is refused.
// A2 — `heavy run [--holder h] [--wait s] -- <command> [args…]` takes the lock,
//      starts the command holding it, and lets go when the command ends. A
//      SIGKILLed wrapper leaves the lock with its still-running command.
//      `heavy acquire` / `heavy release` remain for callers that cannot wrap:
//      acquire starts a small detached holder process (`heavy __hold`) that
//      keeps the lock until release stops it, and records its pid; release
//      stops only a holder process that has the lock open, under the name it
//      was acquired for. With --pid, the holder also lets go when that process
//      exits.
// THE JOB TOKEN (Ethan's ruling on the second review's F2, 2026-11-19): which
//      processes belong to the job holding heavy is carried by the environment,
//      never by process ancestry. HARNESS_HEAVY_JOB=<holder>:<holder pid> is
//      recorded in heavy.info.json as `job`; heavy acquire prints it, heavy run
//      and the Stop hook set it for what they start. A process belongs to the
//      job (heldByThisJob) when its HARNESS_HEAVY_JOB equals the live record's
//      job and a process of that record (its pid, or a run's command) has the
//      lock's file open. Concurrency inside one token is the caller's job: two
//      heavy runs started with the same token both run, at once.
// A3 — a job holding the heavy lock never waits for a slot (heavyNoWait,
//      above), decided by heldByThisJob. Slot holders may wait for heavy: with
//      no heavy holder ever waiting, the two cannot deadlock. Inside its own
//      job, heavy run runs its command without acquiring again and heavy
//      acquire refuses at once.
// A4 — scripts/verify-gate.mjs takes it in process (lockHeavy, recordHeavy)
//      and hands the descriptor to its checks as their fd 9, with its token.
// Setup and heavy are independent (ruling 5). Heavy has no go (ruling 7); the
// default holder is <account>@<host>:<command>.

export const HEAVY_ACCOUNTS = new Map([
  ["ubuntu-pc", "user"],
  // The OptiPlex 7050. Its own hostname, as tailscaled on it reports it
  // (tailscale status --json → HostName), 2026-11-18.
  ["bitcorn-harness", "harnessagent"],
]);

const FLOCK = "/usr/bin/flock"; // by path: browser-slot.py calls this CLI with a scrubbed environment
const FLOCK_BUSY = 200; // flock(1)'s exit code for "held" (-E): -n refused, or -w ran out
export const HEAVY_FD = 9; // the locked descriptor's number in a command or check that holds heavy
const SELF = fileURLToPath(import.meta.url);
const heavyInfoFile = (home) => path.join(lockDir(home), "heavy.info.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closeQuietly = (fd) => {
  try {
    fs.closeSync(fd);
  } catch {}
};

// stdio for a child that is to hold the heavy lock: `base` as its fds 0–2, the
// locked descriptor as its fd HEAVY_FD, nothing in between.
export function heavyStdio(base, fd) {
  const stdio = [...base];
  while (stdio.length < HEAVY_FD) stdio.push("ignore");
  stdio.push(fd);
  return stdio;
}

// /proc/<pid>/stat as { state, ppid, pgrp, start }, or null when there is no
// such process. comm (field 2) may hold spaces and parentheses, so the fields
// are read after its LAST ")": [0] is field 3 (state), [1] ppid, [2] pgrp,
// [19] field 22, the start time in clock ticks since boot.
export function procStat(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
  const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), start: f[19] };
}

// The start time of a RUNNING process, or null: none, or a zombie. The lock does
// not use it; it identifies the process a heavy acquire --pid was made for.
export function procStart(pid) {
  const stat = procStat(pid);
  return stat === null || stat.state === "Z" || stat.state === "X" ? null : stat.start;
}

const running = (pid) => Number.isInteger(pid) && pid > 0 && procStart(pid) !== null;

// "dev:ino" of `file`, or null when there is none.
function fileKey(file) {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Whether process `pid` has open the file `key` (fileKey) names. A process that
// cannot be read (gone, another account's) has not.
export function hasOpen(pid, key) {
  return openFds(pid, key).length > 0;
}

// The descriptor numbers on which process `pid` has open the file `key` names.
function openFds(pid, key) {
  let fds;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  return fds.filter((n) => {
    try {
      const s = fs.statSync(`/proc/${pid}/fd/${n}`);
      return `${s.dev}:${s.ino}` === key;
    } catch {
      return false;
    }
  });
}

const allPids = () => fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).map(Number);

// The processes that hold the flock on the file `key` names, read from
// /proc/<pid>/fdinfo: a descriptor whose open file holds a flock lists it as a
// "lock:" line there, and every process sharing that open file shows it. A
// waiter's own open of the file shows none, so it is not counted.
export function lockHolders(key) {
  return allPids().filter((pid) => openFds(pid, key).some((n) => {
    try {
      return /^lock:\s.*\bFLOCK\b/m.test(fs.readFileSync(`/proc/${pid}/fdinfo/${n}`, "utf8"));
    } catch {
      return false;
    }
  }));
}

const readProcLocks = () => fs.readFileSync("/proc/locks", "utf8");

// Whether the kernel holds a lock on heavy.lock, read from /proc/locks, which
// takes nothing. /proc/locks prints the device its own way, so a line is matched
// on the inode, and (F6) the lock counts only while some process has heavy.lock
// itself open by dev:ino, so another filesystem's file with the same inode
// number is not mistaken for it. procLocks is a test seam.
export function heavyLocked(home, { procLocks = readProcLocks } = {}) {
  const key = fileKey(lockFile(home, "heavy"));
  if (key === null) return false;
  const ino = key.split(":")[1];
  const listed = procLocks().split("\n").some((line) => {
    // "1: FLOCK  ADVISORY  WRITE 1234 fc:00:3576783 0 EOF"; a waiter's line reads "1: -> FLOCK …".
    const f = line.trim().split(/\s+/);
    return f[1] === "FLOCK" && f[5]?.split(":")[2] === ino;
  });
  return listed && allPids().some((pid) => hasOpen(pid, key));
}

function readInfoText(home) {
  try {
    return fs.readFileSync(heavyInfoFile(home), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Who holds heavy, as its holder recorded it: null when nothing is recorded,
// { unreadable: true } when the file does not parse. Display and A3 only.
export function readHeavyInfo(home) {
  const text = readInfoText(home);
  return text === null ? null : parseLock(text);
}

// Removes heavy.info.json if it still holds `text`, and only then.
function dropInfo(home, text) {
  if (readInfoText(home) === text) fs.rmSync(heavyInfoFile(home), { force: true });
}

// The holder as reported to a waiter: who, since when, where, and what of it runs.
export function describeHeavy(info) {
  // No info file: a holder that took the lock an instant ago and has not written it yet,
  // a flock(1) outside these tools, or a process that inherited the lock after its
  // holder's record was removed. Which, the lock cannot say.
  if (info === null) return "a holder that names none (no heavy.info.json: just starting, outside these tools, or an inheritor)";
  if (info.unreadable) return "a holder whose heavy.info.json is unreadable (display only: the lock itself is the kernel's)";
  const who = `${JSON.stringify(info.holder)} since ${info.acquired_at} on ${info.host}`;
  if (running(info.pid)) return `${who}, pid ${info.pid} running`;
  if (running(info.command_pid)) return `${who}, pid ${info.pid} gone but its command (pid ${info.command_pid}) still running`;
  return `${who}, pid ${info.pid} gone: a process that inherited the lock still holds it`;
}

// A3 and nesting: whether the caller (its environment, `env`) belongs to the job
// holding heavy — its HARNESS_HEAVY_JOB is the live record's job, and a process
// of that record has the lock's file open (see THE JOB TOKEN, above). Ancestry
// plays no part.
export function heldByThisJob(home, { env = process.env } = {}) {
  const token = env.HARNESS_HEAVY_JOB;
  if (typeof token !== "string" || token === "") return false;
  let key;
  let info;
  try {
    key = fileKey(lockFile(home, "heavy"));
    info = key === null ? null : readHeavyInfo(home);
  } catch {
    return false;
  }
  if (info === null || info.unreadable || info.job !== token) return false;
  return [info.pid, info.command_pid].some((p) => Number.isInteger(p) && p > 0 && hasOpen(p, key));
}

export const jobToken = (holder, pid) => `${holder}:${pid}`;

// A1: null when `account` is this host's heavy account, else the refusal.
export function heavyAccountRefusal(host, account) {
  const expected = HEAVY_ACCOUNTS.get(host);
  const known = [...HEAVY_ACCOUNTS].map(([h, a]) => `${h} → ${a}`).join(", ");
  if (expected === undefined) return `heavy refused: host ${JSON.stringify(host)} has no heavy-job account (known: ${known})`;
  if (account !== expected) {
    return `heavy refused: heavy jobs on ${host} run as ${expected}, and this is ${account}; run it as ${expected}`;
  }
  return null;
}

// The heavy lock's home, from the password database; the account check is
// separate (heavyContext). Test seam: HARNESS_HEAVY_TEST_HOME, an absolute
// scratch directory in place of the account's home, announced by every
// command that uses it.
export function heavyHome(env, { user = os.userInfo() } = {}) {
  const test = env.HARNESS_HEAVY_TEST_HOME;
  if (test === undefined || test === "") return user.homedir;
  if (!path.isAbsolute(test)) throw new Error(`HARNESS_HEAVY_TEST_HOME must be an absolute path, got ${JSON.stringify(test)}`);
  return test;
}

// A1 for a command that takes the lock: { home, account, host, notes }, or a
// throw naming the refusal. Test seam: HARNESS_HEAVY_TEST_ACCOUNT, an account
// name to act as, honoured only beside HARNESS_HEAVY_TEST_HOME, so it can make
// a run refuse but can never put a real run's lock in another home.
export function heavyContext(env, { host = os.hostname(), user = os.userInfo() } = {}) {
  const home = heavyHome(env, { user });
  const testing = Boolean(env.HARNESS_HEAVY_TEST_HOME);
  const account = (testing && env.HARNESS_HEAVY_TEST_ACCOUNT) || user.username;
  const notes = testing ? [`a TEST lock home, ${home} (HARNESS_HEAVY_TEST_HOME), not the account's` +
    (account !== user.username ? `; acting as account ${account} (HARNESS_HEAVY_TEST_ACCOUNT)` : "")] : [];
  const refusal = heavyAccountRefusal(host, account);
  if (refusal) throw new Error(refusal);
  return { home, account, host, notes };
}

// One flock(1) on `fd` (its fd 3): resolves "locked" or "busy", or rejects when
// flock(1) cannot run. waitMs 0 is -n; Infinity waits for as long as it takes.
// Aborted, the flock(1) is killed: "busy", and if it had just taken the lock,
// the caller's close of `fd` lets it go.
function flockOnce(fd, waitMs, signal) {
  const args = ["-x", "-E", String(FLOCK_BUSY)];
  if (waitMs === 0) args.push("-n");
  else if (waitMs !== Infinity) args.push("-w", String(waitMs / 1000));
  args.push("3");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve("busy");
    const child = spawn(FLOCK, args, { stdio: ["ignore", "ignore", "pipe", fd] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`flock(1) could not run (${FLOCK}): ${error.message}`));
    });
    child.on("close", (code, killed) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve("locked");
      else if (code === FLOCK_BUSY || killed) resolve("busy");
      else reject(new Error(`flock(1) exited ${code}: ${stderr.trim()}`));
    });
  });
}

// A2: take the heavy lock, waiting up to waitMs while it is held, saying who
// holds it. Resolves to { fd } — the locked descriptor; record it with
// recordHeavy — or { fd: null, info, message, cancelled? } when the wait ran
// out or `signal` aborted it. message keeps "is already locked by", the phrase
// the slot lock's waiters read.
export async function lockHeavy({ home, waitMs = Infinity, pollMs = 5000, say = () => {}, signal } = {}) {
  fs.mkdirSync(lockDir(home), { recursive: true });
  const file = lockFile(home, "heavy");
  const t0 = Date.now();
  let said = null;
  const report = () => {
    const desc = describeHeavy(readHeavyInfo(home));
    if (said === null || said.desc !== desc || Date.now() - said.at >= 60_000) {
      say(`heavy lock held by ${desc}; waiting (every ${pollMs / 1000}s, ` +
        `${waitMs === Infinity ? "no limit" : `up to ${Math.round(waitMs / 1000)}s`})`);
      said = { desc, at: Date.now() };
    }
  };
  for (;;) {
    const fd = fs.openSync(file, "a", 0o644);
    let got;
    let timer = null;
    let first = null;
    try {
      got = await flockOnce(fd, 0, signal);
      const left = waitMs - (Date.now() - t0);
      if (got === "busy" && !signal?.aborted && left > 0) {
        // A holder an instant old has the lock but has not written heavy.info.json yet:
        // give it half a second before saying who holds it, rather than naming no one.
        first = setTimeout(report, readHeavyInfo(home) === null ? 500 : 0);
        timer = setInterval(report, pollMs);
        got = await flockOnce(fd, left, signal);
      }
    } catch (error) {
      closeQuietly(fd);
      throw error;
    } finally {
      if (first !== null) clearTimeout(first);
      if (timer !== null) clearInterval(timer);
    }
    if (got === "locked" && !signal?.aborted) {
      const locked = fs.fstatSync(fd);
      if (fileKey(file) === `${locked.dev}:${locked.ino}`) return { fd };
      closeQuietly(fd); // heavy.lock was replaced while this waited: lock the file it names now
      continue;
    }
    closeQuietly(fd);
    const info = readHeavyInfo(home);
    if (signal?.aborted) return { fd: null, cancelled: true, info, message: `cancelled while heavy was held by ${describeHeavy(info)}` };
    const waited = Math.round((Date.now() - t0) / 1000);
    return {
      fd: null,
      info,
      message: `heavy is already locked by ${JSON.stringify(info?.holder ?? "(unrecorded)")}` +
        (info?.acquired_at ? ` since ${info.acquired_at}` : "") + ` (${describeHeavy(info)}); waited ${waited}s`,
    };
  }
}

// Once the lock is held: write heavy.info.json and history.log's acquire line.
// fields: holder, host, kind ("run", "acquire" or "gate"), pid (the process
// holding the descriptor), job (its token), and what the kind adds. Returns
// { info, text, logged, log(extra), release(at) }. With deferLog, the acquire
// line waits for log(extra), which first adds `extra` to the record (heavy run:
// the record is written before its command starts, the command's pid after).
// release removes the info file and, if the acquire was logged, writes the
// release line while still holding, then closes `fd`; it returns the release
// line, or null when nothing was logged.
export function recordHeavy(home, fd, { holder, host, ...rest }, now = new Date(), { deferLog = false } = {}) {
  const info = { holder, acquired_at: utc(now), host, slot: "heavy", ...rest };
  const file = heavyInfoFile(home);
  const write = () => {
    const text = `${JSON.stringify(info, null, 2)}\n`;
    const tmp = privateName(file, "tmp");
    fs.writeFileSync(tmp, text, { flag: "wx" });
    fs.renameSync(tmp, file);
    return text;
  };
  const rec = {
    info,
    text: write(),
    logged: false,
    log: (extra = {}) => {
      if (Object.keys(extra).length > 0) {
        Object.assign(info, extra);
        rec.text = write();
      }
      appendHistory(home, `${info.acquired_at} acquire ${field("lock", "heavy")} ${field("holder", holder)} ` +
        `${field("host", host)} ${field("pid", info.pid ?? null)} ${field("pgid", info.pgid ?? null)}`);
      rec.logged = true;
    },
    release: (at = new Date()) => {
      try {
        dropInfo(home, rec.text);
        return rec.logged ? releasedLine(home, "heavy", holder, info, utc(at)) : null;
      } finally {
        closeQuietly(fd);
      }
    },
  };
  if (!deferLog) rec.log();
  return rec;
}

export function heavyStatus(home) {
  return `heavy lock ${lockFile(home, "heavy")}: ` + (heavyLocked(home) ? `held by ${describeHeavy(readHeavyInfo(home))}` : "free");
}

const HEAVY_USAGE =
  "usage: harness-slot.mjs heavy run [--holder <h>] [--wait <seconds>] -- <command> [args...]\n" +
  "       harness-slot.mjs heavy acquire --holder <h> [--pid <pid>] [--wait <seconds>]\n" +
  "       harness-slot.mjs heavy release --holder <h>\n" +
  "       harness-slot.mjs heavy release --force --reason \"<text>\"\n" +
  "       harness-slot.mjs heavy status";

function parseHeavyArgs(args) {
  const opts = {};
  const valued = { "--holder": "holder", "--wait": "wait", "--pid": "pid", "--reason": "reason" };
  let i = 0;
  for (; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i];
    if (arg in valued) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      opts[valued[arg]] = args[++i];
    } else if (arg === "--force") {
      opts.force = true;
    } else {
      throw new Error(`unknown heavy argument ${JSON.stringify(arg)}\n${HEAVY_USAGE}`);
    }
  }
  if (opts.wait !== undefined && !/^[0-9]+(\.[0-9]+)?$/.test(opts.wait)) {
    throw new Error(`--wait takes a number of seconds, got ${JSON.stringify(opts.wait)}`);
  }
  if (opts.pid !== undefined && !/^[1-9][0-9]*$/.test(opts.pid)) throw new Error(`--pid takes a pid, got ${JSON.stringify(opts.pid)}`);
  return { opts, command: i < args.length ? args.slice(i + 1) : null };
}

const waitMsOf = (opts) => (opts.wait === undefined ? Infinity : Number(opts.wait) * 1000);
const signalCode = (signal) => 128 + (os.constants.signals[signal] ?? 0);

// Ends this process on `signal`. Node ignores some signals (SIGPIPE) and acts
// on others (SIGUSR1 starts its inspector), so the re-raise may not end it:
// the exit code is set first, so it is 128 + the signal's number either way.
function reraise(signal) {
  process.exitCode = signalCode(signal);
  process.kill(process.pid, signal);
}

// F1: how long what is left of a heavy run's process group has, after its top
// process exits, between SIGTERM and SIGKILL.
export const RUN_GRACE_MS = 2000;

// Ends process group `pgid`: SIGTERM, then SIGKILL after RUN_GRACE_MS. Resolves
// once the group is empty, or a second after the SIGKILL.
async function endGroup(pgid) {
  const alive = () => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  try { process.kill(-pgid, "SIGTERM"); } catch {}
  for (const t0 = Date.now(); alive() && Date.now() - t0 < RUN_GRACE_MS;) await sleep(25);
  if (!alive()) return;
  try { process.kill(-pgid, "SIGKILL"); } catch {}
  for (const t0 = Date.now(); alive() && Date.now() - t0 < 1000;) await sleep(25);
}

const procComm = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
};

// `heavy run`: resolves to the exit code to leave with, or null when the
// command ended on a signal that has been re-raised on this process.
function heavyRun(opts, command, env, ctx, { err }) {
  const say = (m) => err(`harness-slot heavy: ${m}`);
  const holder = opts.holder ?? `${ctx.account}@${ctx.host}:${command.join(" ")}`;
  requireText("--holder", holder);
  if (heldByThisJob(ctx.home, { env })) {
    // Nested inside this job's own hold (its token): waiting would wait on itself.
    const held = readHeavyInfo(ctx.home);
    say(`already held by this job (${JSON.stringify(held?.holder ?? "(unrecorded)")}); running without acquiring again`);
    return new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: "inherit", env });
      child.on("error", (error) => { say(`could not start ${JSON.stringify(command[0])}: ${error.message}`); resolve(127); });
      child.on("exit", (code, signal) => resolve(signal ? signalCode(signal) : code));
    });
  }
  return new Promise((resolve) => {
    const waiting = new AbortController();
    let fd = null; // the locked descriptor, once held
    let rec = null; // recordHeavy's record, once written
    let child = null; // the command, once started
    let stopping = null; // a signal received before the command started
    let done = false;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onSignal = (signal) => {
      if (child !== null && child.pid !== undefined) {
        try { process.kill(-child.pid, signal); } catch {}
      } else {
        stopping = signal;
        waiting.abort();
      }
    };
    for (const s of signals) process.on(s, onSignal);
    // Runs once: ends what is left of the command's process group, lets go of
    // the lock if this job holds it, then leaves. F1: a process that still
    // holds the descriptor (it left the group with fd 9) means the lock is NOT
    // released: it is named, the record stays, and no release line is written.
    const finish = async (code, signal) => {
      if (done) return;
      done = true;
      for (const s of signals) process.removeListener(s, onSignal);
      if (child !== null && child.pid !== undefined) await endGroup(child.pid);
      if (rec !== null) {
        try {
          const locked = fs.fstatSync(fd);
          const others = lockHolders(`${locked.dev}:${locked.ino}`).filter((p) => p !== process.pid);
          if (others.length > 0) {
            closeQuietly(fd);
            say(`NOT released: ${others.map((p) => `pid ${p} (${procComm(p)})`).join(", ")} still ` +
              `${others.length === 1 ? "holds" : "hold"} fd 9; the lock frees when ${others.length === 1 ? "it exits" : "they exit"}`);
            if (!signal && code === 0) code = 2;
          } else {
            const line = rec.release();
            if (line !== null) say(line);
          }
        } catch (error) {
          closeQuietly(fd);
          say(`RELEASE FAILED: ${error.message}`);
          if (!signal && code === 0) code = 2;
        }
      } else if (fd !== null) {
        closeQuietly(fd);
      }
      if (signal) {
        reraise(signal);
        resolve(null);
      } else {
        resolve(code);
      }
    };
    lockHeavy({ home: ctx.home, waitMs: waitMsOf(opts), say, signal: waiting.signal }).then((r) => {
      if (r.fd === null) {
        if (stopping !== null) return finish(null, stopping);
        say(`${r.message}; the command was not run`);
        return finish(2, null);
      }
      fd = r.fd;
      if (stopping !== null) return finish(null, stopping);
      // The record (and its job token) is written before the command starts, so
      // nothing the command runs can look for it too early. Without it the token
      // names nothing and a nested call would wait on this job: not run.
      const job = jobToken(holder, process.pid);
      try {
        rec = recordHeavy(ctx.home, fd, { holder, host: ctx.host, kind: "run", pid: process.pid, job, argv: command },
          new Date(), { deferLog: true });
      } catch (error) {
        say(`heavy.info.json could not be written (${error.message}), so this job's token would name nothing; the command was not run`);
        return finish(2, null);
      }
      // detached: its own process group, so a forwarded signal reaches all of it.
      child = spawn(command[0], command.slice(1), {
        stdio: heavyStdio(["inherit", "inherit", "inherit"], fd), detached: true, env: { ...env, HARNESS_HEAVY_JOB: job },
      });
      if (child.pid === undefined) {
        // It never started: "error" follows, and there is nothing to wait for.
        child.on("error", (error) => {
          say(`could not start ${JSON.stringify(command[0])}: ${error.message}; the command was not run`);
          finish(127, null);
        });
        return;
      }
      child.on("exit", (code, signal) => finish(code ?? 1, signal));
      try {
        rec.log({ command_pid: child.pid, pgid: child.pid });
        say(`acquired the heavy lock for ${JSON.stringify(holder)}: pid ${process.pid}, process group ${child.pid}`);
      } catch (error) {
        say(`the heavy lock is held, but heavy.info.json could not be updated: ${error.message}`);
      }
    }, (error) => {
      say(error.message);
      finish(2, null);
    });
  });
}

// `heavy __hold <spec>`: the detached holder process `heavy acquire` starts.
// It takes the lock, records it (its own pid), tells the acquiring CLI over
// IPC, and keeps it until heavy release stops it (SIGTERM; the release line is
// already written) or, with --pid, until that process exits. If the acquiring
// CLI goes away while this still waits, it stops waiting.
async function heavyHold(specText, ctx) {
  const spec = JSON.parse(specText);
  const send = (m) => {
    try {
      if (process.connected) process.send(m);
    } catch {}
  };
  const waiting = new AbortController();
  let held = false;
  process.on("disconnect", () => {
    if (!held) waiting.abort();
  });
  let r;
  try {
    r = await lockHeavy({ home: ctx.home, waitMs: spec.waitMs ?? Infinity, say: (m) => send({ say: m }), signal: waiting.signal });
  } catch (error) {
    send({ failed: error.message }); // this process's stderr goes nowhere: the acquiring CLI says it
    return 2;
  }
  if (r.fd === null) {
    send({ failed: r.message });
    return 2;
  }
  held = true;
  let rec;
  try {
    rec = recordHeavy(ctx.home, r.fd, {
      holder: spec.holder, host: ctx.host, kind: "acquire", pid: process.pid, job: jobToken(spec.holder, process.pid),
      ...(spec.watch ? { owner_pid: spec.ownerPid, owner_start: spec.ownerStart } : {}),
    });
  } catch (error) {
    closeQuietly(r.fd); // unrecorded, release could not find it: let go rather than hold it unnamed
    send({ failed: `the heavy lock was taken but could not be recorded (${error.message}); it was let go` });
    return 2;
  }
  process.on("SIGTERM", () => {
    closeQuietly(r.fd);
    process.exit(0);
  });
  send({ acquired: true, pid: process.pid, job: rec.info.job });
  return new Promise(() => {
    setInterval(() => {
      if (!spec.watch || procStart(spec.ownerPid) === spec.ownerStart) return;
      // The process this lock was taken for has exited: let go, logged as a
      // release, unless a release has already taken the record.
      if (readInfoText(ctx.home) === rec.text) rec.release();
      else closeQuietly(r.fd);
      process.exit(0);
    }, 1000);
  });
}

// `heavy acquire`: starts the holder process and reports what it did, ending
// with the job token as a line `HARNESS_HEAVY_JOB=<token>` (shell-quoted) for
// the caller to set in every command of its job. F3: inside a job that already
// holds heavy it refuses at once: the new holder would wait on this job.
function heavyAcquire(opts, ctx, env, { out, err }) {
  requireText("--holder", opts.holder);
  if (heldByThisJob(ctx.home, { env })) {
    const held = readHeavyInfo(ctx.home);
    throw new Error(`already held by this job (${JSON.stringify(held?.holder ?? "(unrecorded)")}); nothing acquired`);
  }
  const watch = opts.pid !== undefined;
  const ownerPid = watch ? Number(opts.pid) : null;
  const ownerStart = watch ? procStart(ownerPid) : null;
  if (watch && ownerStart === null) throw new Error(`--pid ${ownerPid}: no such running process`);
  const spec = { holder: opts.holder, waitMs: opts.wait === undefined ? null : Number(opts.wait) * 1000, ownerPid, ownerStart, watch };
  const holder = spawn(process.execPath, [SELF, "heavy", "__hold", JSON.stringify(spec)], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise((resolve) => {
    let settled = false;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      for (const s of signals) process.removeListener(s, onSignal);
      if (holder.connected) holder.disconnect();
      holder.unref();
      if (signal) {
        reraise(signal);
        resolve(null);
      } else {
        resolve(code);
      }
    };
    // Stopped while the holder waits: the holder must not take the lock for nobody.
    const onSignal = (signal) => {
      try { holder.kill("SIGKILL"); } catch {}
      settle(null, signal);
    };
    for (const s of signals) process.on(s, onSignal);
    holder.on("message", (m) => {
      if (typeof m?.say === "string") {
        err(`harness-slot heavy: ${m.say}`);
      } else if (m?.acquired) {
        out(`acquired heavy for ${opts.holder}: ${lockFile(ctx.home, "heavy")} (held by pid ${m.pid}` +
          (watch ? ` for pid ${ownerPid}, freed when it exits)` : "; freed by heavy release, or --force --reason)"));
        out(`HARNESS_HEAVY_JOB=${quote(m.job)}`);
        settle(0, null);
      } else if (typeof m?.failed === "string") {
        err(`harness-slot heavy: ${m.failed}`);
        settle(2, null);
      }
    });
    holder.on("error", (error) => {
      err(`harness-slot heavy: could not start the holder process: ${error.message}`);
      settle(2, null);
    });
    holder.on("exit", (code, signal) => {
      if (!settled) err(`harness-slot heavy: the holder process ended (${signal ?? `exit ${code}`}) before it took the lock`);
      settle(2, null);
    });
  });
}

// Waits for a holder process to end, SIGKILL after 10 s.
async function stopHolder(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const t0 = Date.now();
  let killed = signal === "SIGKILL";
  while (running(pid)) {
    if (!killed && Date.now() - t0 > 10_000) {
      process.kill(pid, "SIGKILL");
      killed = true;
    }
    await sleep(25);
  }
}

// `heavy release`: stops a heavy acquire's holder process. Only a holder
// process that has the lock open, and (without --force) only under the name it
// was acquired for. A heavy run, or the Stop hook, holds it for as long as its
// job runs: nothing here can take it from them.
async function heavyRelease(opts, ctx) {
  const home = ctx.home;
  if (!heavyLocked(home)) throw new Error("heavy: no lock to release");
  const text = readInfoText(home);
  const info = text === null ? null : parseLock(text);
  const key = fileKey(lockFile(home, "heavy"));
  const holderProcess = info !== null && !info.unreadable && info.kind === "acquire" && Number.isInteger(info.pid) &&
    key !== null && hasOpen(info.pid, key);
  const notAHolder = `heavy is held by ${describeHeavy(info)}, not by a heavy acquire holder process: ` +
    "the kernel frees it when that job ends, and nothing else can";
  if (opts.force) {
    requireText("--reason", opts.reason);
    if (!holderProcess) throw new Error(notAHolder);
    const at = utc(new Date());
    appendHistory(home, `${at} force-release ${field("lock", "heavy")} ${field("holder", info.holder)} ` +
      `${field("acquired_at", info.acquired_at ?? null)} ${field("reason", opts.reason)}`);
    dropInfo(home, text);
    await stopHolder(info.pid, "SIGKILL");
    return `harness lock FORCE-released: heavy, was held by ${info.holder} since ${info.acquired_at ?? "?"}; ` +
      `reason ${JSON.stringify(opts.reason)}`;
  }
  requireText("--holder", opts.holder);
  if (info !== null && !info.unreadable && info.holder !== opts.holder) {
    throw new Error(`heavy is held by ${JSON.stringify(info.holder)}, not ${JSON.stringify(opts.holder)}; ` +
      "a stale lock is cleared with lock release --force --reason \"<why>\"");
  }
  if (!holderProcess) throw new Error(notAHolder);
  const line = releasedLine(home, "heavy", info.holder, info, utc(new Date()));
  dropInfo(home, text);
  await stopHolder(info.pid, "SIGTERM");
  return line;
}

// Resolves to an exit code, or null (heavy run ended on a re-raised signal).
export async function heavyMain(args, env, { out = console.log, err = console.error } = {}) {
  const [action, ...rest] = args;
  try {
    if (action === "__hold") return await heavyHold(rest[0], heavyContext(env));
    const { opts, command } = parseHeavyArgs(rest);
    if (action === "status") {
      if (Object.keys(opts).length > 0 || command !== null) throw new Error("heavy status takes no arguments");
      const home = heavyHome(env);
      if (env.HARNESS_HEAVY_TEST_HOME) err(`harness-slot heavy: a TEST lock home, ${home} (HARNESS_HEAVY_TEST_HOME), not the account's`);
      out(heavyStatus(home));
      return 0;
    }
    if (!["run", "acquire", "release"].includes(action)) throw new Error(HEAVY_USAGE);
    const ctx = heavyContext(env);
    for (const note of ctx.notes) err(`harness-slot heavy: ${note}`);
    if (action === "run") {
      if (command === null || command.length === 0) throw new Error(`heavy run needs -- <command>\n${HEAVY_USAGE}`);
      if (opts.pid !== undefined || opts.force || opts.reason !== undefined) throw new Error("heavy run takes only --holder and --wait");
      return await heavyRun(opts, command, env, ctx, { err });
    }
    if (command !== null) throw new Error(`heavy ${action} takes no command\n${HEAVY_USAGE}`);
    if (action === "acquire") {
      if (opts.force || opts.reason !== undefined) throw new Error("--force and --reason belong to heavy release");
      return await heavyAcquire(opts, ctx, env, { out, err });
    }
    if (opts.wait !== undefined || opts.pid !== undefined) throw new Error("--wait and --pid belong to heavy acquire");
    if (!opts.force && opts.reason !== undefined) throw new Error("--reason needs --force");
    out(await heavyRelease(opts, ctx));
    return 0;
  } catch (error) {
    err(`harness-slot heavy: ${error.message}`);
    return 2;
  }
}

// ─── entry point ──────────────────────────────────────────────────────────

export function liveContext(slot, home = os.homedir()) {
  let cached;
  const file = path.join(home, ".polar", "networks", "networks.json");
  return {
    home,
    network: () => (cached ??= resolveNetwork(slot, JSON.parse(fs.readFileSync(file, "utf8")))),
  };
}

function spawnShell(command) {
  const child = spawn("sh", ["-c", command], { cwd: ROOT, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    process.removeAllListeners(signal); // so the re-raised signal terminates this process
    process.kill(process.pid, signal);
  });
  return null;
}

// A3's test: does this process belong to the job holding heavy (heldByThisJob)?
// Read from the account's home (heavyHome), never $HOME. Any failure to tell is
// "no": the slot lock then behaves exactly as it did before the heavy lock existed.
function thisJobHoldsHeavy(env) {
  try {
    return heldByThisJob(heavyHome(env), { env });
  } catch {
    return false;
  }
}

// Returns an exit code, or null once `run` has handed over to the shell; for
// `heavy`, a Promise of either.
export function main(argv, env, { home = os.homedir(), shell = spawnShell, out = console.log, err = console.error } = {}) {
  const [sub, ...rest] = argv;
  if (sub === "heavy") return heavyMain(rest, env, { out, err }); // a Promise
  if (sub === "lock") {
    try {
      out(lockMain(rest, { home, heavyHeld: rest[0] === "acquire" && thisJobHoldsHeavy(env) }));
      return 0;
    } catch (error) {
      err(`harness-slot lock: ${error.message}`);
      return 2;
    }
  }
  if (sub !== "command" && sub !== "run") {
    err("usage: harness-slot.mjs command|run <npm-script> [args]\n       harness-slot.mjs lock acquire|release|status ...\n" +
      "       harness-slot.mjs heavy run|acquire|release|status ...");
    return 2;
  }
  const [script, ...args] = rest;
  let command;
  try {
    const slot = parseSlot(env.HARNESS_SLOT);
    checkScript(script, args);
    // H14 enforcement, before the command is even built.
    if (sub === "run" && !isReadOnlyRun(script, args)) {
      const refusal = lockRefusal(slot, env.HARNESS_HOLDER, home);
      if (refusal) throw new Error(refusal);
    }
    command = scriptCommand(script, slot, liveContext(slot, home), args);
  } catch (error) {
    err(`harness-slot: ${error.message}`);
    return 2;
  }
  if (sub === "command") {
    out(command);
    return 0;
  }
  return shell(command);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main(process.argv.slice(2), process.env)).then((code) => {
    if (code !== null) process.exit(code);
  });
}
