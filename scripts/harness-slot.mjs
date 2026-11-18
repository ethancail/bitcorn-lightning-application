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

// ─── the heavy lock (H1–H7; A1–A4, Ethan 2026-11-18) ──────────────────────
//
// One heavy job per machine at a time (H1). Heavy (H3): full test suites
// (vitest, node --test), mutation and negative-control batches, Polar gates and
// captures. One lock, heavy.lock, in the locks/ directory of ONE account's home.
//
// A1 — that account is this host's entry in HEAVY_ACCOUNTS; its home comes from
//      the password database (os.userInfo()), never $HOME. Any other account,
//      and any host not in the table, is refused.
// A2 — `heavy run [--holder h] [--wait s] -- <command> [args…]` holds the lock
//      for exactly the command's life and records its own pid, its start time
//      (/proc/<pid>/stat field 22), the boot id, and the command's process
//      group. A later acquirer that finds the holder PROVABLY dead
//      (provablyDead) logs a take-over line in history.log and takes the lock;
//      anything short of proof is waited on and reported as the holder.
//      `heavy acquire` / `heavy release` remain for callers that cannot wrap.
// A3 — a job holding the heavy lock never waits for a slot (heavyNoWait,
//      above). Slot holders may wait for heavy: with no heavy holder ever
//      waiting, the two cannot deadlock.
// A4 — scripts/verify-gate.mjs takes it before its checks, through acquireHeavy.
// Setup and heavy are independent (ruling 5). Heavy has no go (ruling 7); the
// default holder is <account>@<host>:<command>.
//
// Release and forced release use the slot locks' tombstone protocol
// (removeLock); the create is the same temp-file-and-link exclusive create.

export const HEAVY_ACCOUNTS = new Map([
  ["ubuntu-pc", "user"],
  // The OptiPlex 7050. Its own hostname, as tailscaled on it reports it
  // (tailscale status --json → HostName), 2026-11-18.
  ["bitcorn-harness", "harnessagent"],
]);

export const bootId = () => fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

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

// The start time of a RUNNING process, or null: none, or a zombie (it has
// exited and holds nothing; only its exit status is left to collect).
export function procStart(pid) {
  const stat = procStat(pid);
  return stat === null || stat.state === "Z" || stat.state === "X" ? null : stat.start;
}

// Whether process group `pgid` has any member: kill(-pgid, 0) fails with ESRCH
// only when it has none. EPERM means a member exists, another account's.
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

// A2, with ruling 2. The holder is PROVABLY dead only when the lock was taken
// on this host and either
//   - the machine has booted since (another boot id: no process of that boot
//     survives), or
//   - its pid runs no process with the start time the lock recorded (none, a
//     zombie, or the pid reused by a later process), AND the process group the
//     lock names, if it names one, has no member left: a wrapper killed by
//     SIGKILL leaves its command running, and the command still holds the lock.
// Returns the reason (for history.log), or null: alive, or not provable. Not
// provable is waited on, never taken over: a lock from another host (its
// processes cannot be seen from here), one with no pid (heavy acquire without
// --pid), one with fields missing or malformed, one unreadable.
export function provablyDead(lock, { host, boot, start = procStart, group = groupAlive }) {
  if (lock === null || lock.unreadable || lock.host !== host) return null;
  if (!Number.isInteger(lock.pid) || lock.pid < 1) return null;
  if (typeof lock.pid_start !== "string" || typeof lock.boot_id !== "string") return null;
  const hasGroup = lock.pgid !== undefined;
  // pgid 0 and 1 would make kill(-pgid, 0) ask about this caller's group, or every process.
  if (hasGroup && !(Number.isInteger(lock.pgid) && lock.pgid > 1)) return null;
  if (lock.boot_id !== boot) return `the machine has booted since the lock was taken (boot ${lock.boot_id}, now ${boot})`;
  const running = start(lock.pid);
  if (running === lock.pid_start) return null;
  if (hasGroup && group(lock.pgid)) return null;
  const pid = running === null ? `no process ${lock.pid} runs` :
    `pid ${lock.pid} is another process (started at tick ${running}, the holder at ${lock.pid_start})`;
  return hasGroup ? `${pid}, and process group ${lock.pgid} has no member` : pid;
}

// Whether this process descends from the heavy lock's recorded holder (the
// wrapper, the gate, or a --pid process): pid and start time both match an
// ancestor. Ancestry, not an environment variable, because browser-slot.py
// calls the lock CLI with a scrubbed environment, and timeout(1) and setsid
// change the process group but not the parent chain.
export function heldByThisJob(lock, { host = os.hostname(), stat = procStat, pid = process.pid } = {}) {
  if (lock === null || lock.unreadable || lock.host !== host || !Number.isInteger(lock.pid)) return false;
  for (let p = pid, hops = 0; p > 1 && hops < 4096; hops++) {
    const s = stat(p);
    if (s === null) return false;
    if (p === lock.pid && s.start === lock.pid_start) return true;
    p = s.ppid;
  }
  return false;
}

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

// The holder as reported to a waiter: who, since when, where, and whether it is
// known to be running.
export function describeHeavy(lock, { host, boot, start = procStart, group = groupAlive }) {
  if (lock.unreadable) return `an unreadable lock file (free it with heavy release --force --reason "<why>")`;
  const who = `${JSON.stringify(lock.holder)} since ${lock.acquired_at} on ${lock.host}`;
  if (lock.host !== host) return `${who} (another host: its processes cannot be checked from here)`;
  if (!Number.isInteger(lock.pid)) return `${who} (no pid recorded: freed only by heavy release, or --force --reason)`;
  const dead = provablyDead(lock, { host, boot, start, group });
  if (dead !== null) return `${who}, PROVABLY DEAD: ${dead}`;
  if (lock.pgid !== undefined && lock.boot_id === boot && typeof lock.pid_start === "string" && start(lock.pid) !== lock.pid_start) {
    return `${who}, pid ${lock.pid} gone but its command (process group ${lock.pgid}) still running`;
  }
  return `${who}, pid ${lock.pid} running`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A2: take the heavy lock, waiting while it is held. One attempt is the
// exclusive create; on EEXIST the holder is checked, and a provably dead one is
// taken out byte for byte (as a forced release is) with a take-over line in
// history.log, and the create is tried again. Resolves to
//   { acquired: true, text, lock }   — release with releaseOwnHeavy(home, text)
//   { acquired: false, held, message } — the wait bound reached, or cancelled()
// message keeps "is already locked by", the phrase the slot lock's waiters read.
export async function acquireHeavy({
  home, holder, host = os.hostname(), boot = bootId(), pid, pidStart, pgid, argv,
  waitMs = Infinity, pollMs = 5000, say = () => {}, sleep = defaultSleep, cancelled = () => false,
  now = () => new Date(), start = procStart, group = groupAlive,
}) {
  requireText("--holder", holder);
  fs.mkdirSync(lockDir(home), { recursive: true });
  const file = lockFile(home, "heavy");
  const t0 = Date.now();
  let said = null;
  for (;;) {
    const lock = { holder, acquired_at: utc(now()), host, slot: "heavy", pid, pid_start: pidStart, boot_id: boot, pgid, argv };
    const text = `${JSON.stringify(lock, null, 2)}\n`;
    const tmp = privateName(file, "tmp");
    fs.writeFileSync(tmp, text, { flag: "wx" });
    let linked = false;
    try {
      fs.linkSync(tmp, file);
      linked = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (linked) {
      appendHistory(home, `${lock.acquired_at} acquire ${field("lock", "heavy")} ${field("holder", holder)} ` +
        `${field("host", host)} ${field("pid", pid ?? null)} ${field("pgid", pgid ?? null)}`);
      return { acquired: true, text, lock: JSON.parse(text) };
    }
    const seenText = readLockText(home, "heavy");
    if (seenText === null) continue; // released between the create and the read: try again
    const held = parseLock(seenText);
    const dead = provablyDead(held, { host, boot, start, group });
    if (dead !== null) {
      const changed = "heavy changed while it was being taken over";
      try {
        const out = removeLock(home, "heavy", (_, heldText) => (heldText === seenText ? null : changed));
        if (out !== null) {
          appendHistory(home, `${utc(now())} take-over ${field("lock", "heavy")} ${field("holder", out.holder)} ` +
            `${field("acquired_at", out.acquired_at ?? null)} ${field("pid", out.pid ?? null)} ` +
            `${field("reason", dead)} ${field("by", holder)}`);
          say(`took over the heavy lock from ${JSON.stringify(out.holder)}: ${dead}`);
        }
      } catch (error) {
        if (error.message !== changed) throw error;
      }
      continue;
    }
    const waited = Date.now() - t0;
    const desc = describeHeavy(held, { host, boot, start, group });
    if (waited >= waitMs || cancelled()) {
      return {
        acquired: false,
        held,
        message: `heavy is already locked by ${JSON.stringify(held.holder)}` +
          (held.acquired_at ? ` since ${held.acquired_at}` : "") + ` (${desc}); waited ${Math.round(waited / 1000)}s`,
      };
    }
    if (said === null || said.desc !== desc || Date.now() - said.at >= 60_000) {
      say(`heavy lock held by ${desc}; waiting (every ${pollMs / 1000}s, ` +
        `${waitMs === Infinity ? "no limit" : `up to ${Math.round(waitMs / 1000)}s`})`);
      said = { desc, at: Date.now() };
    }
    await sleep(Math.max(0, Math.min(pollMs, waitMs - waited)));
  }
}

// Release the lock this job wrote, and only that one: what is taken out must be
// byte for byte the text acquireHeavy returned.
export function releaseOwnHeavy(home, text, now = new Date()) {
  const lock = removeLock(home, "heavy", (held, heldText) => (heldText === text ? null :
    `heavy is no longer this job's lock (now held by ${JSON.stringify(held.holder)}), so it was left in place`));
  if (lock === null) throw new Error("heavy: this job's lock is gone, taken out by something else; nothing was released");
  return releasedLine(home, "heavy", lock.holder, lock, utc(now));
}

export function heavyStatus(home, { host = os.hostname(), boot = bootId() } = {}) {
  const lock = readLock(home, "heavy");
  return `heavy lock ${lockFile(home, "heavy")}: ` + (lock === null ? "free" : `held by ${describeHeavy(lock, { host, boot })}`);
}

// The gated child: sh waits for one line on fd 3 before it execs the command,
// so the command's process group exists, and is in the lock, before the
// command does anything. If the wrapper dies first, fd 3 closes, read fails,
// and the child exits 125 without running it. The command is an argument
// list ("$@"), never shell text.
const GATED = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec "$@"';

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

// `heavy run`: resolves to the exit code to leave with, or null when the
// command ended on a signal that has been re-raised on this process.
function heavyRun(opts, command, env, ctx, { err }) {
  const say = (m) => err(`harness-slot heavy: ${m}`);
  const holder = opts.holder ?? `${ctx.account}@${ctx.host}:${command.join(" ")}`;
  requireText("--holder", holder);
  const current = readLock(ctx.home, "heavy");
  if (heldByThisJob(current, { host: ctx.host })) {
    // Nested inside this job's own hold: waiting would wait on itself.
    say(`already held by this job (${JSON.stringify(current.holder)}); running without acquiring again`);
    return new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: "inherit", env });
      child.on("error", (error) => { say(`could not start ${JSON.stringify(command[0])}: ${error.message}`); resolve(127); });
      child.on("exit", (code, signal) => resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : code));
    });
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", GATED, "sh", ...command], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      detached: true, // its own session and process group, recorded in the lock
      env,
    });
    let held = null; // the lock's text once acquired
    let stopping = null; // a signal received before the command was let go
    let exited = null; // { code, signal } once the child has ended (or failed to start)
    let done = false;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onSignal = (signal) => {
      if (held !== null && exited === null) {
        try { process.kill(-child.pid, signal); } catch {}
      } else {
        stopping = signal;
        child.stdio[3].destroy(); // the gated child sees EOF and exits 125
      }
    };
    for (const s of signals) process.on(s, onSignal);
    // Runs once: releases the lock if this job holds it, then leaves.
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      for (const s of signals) process.removeListener(s, onSignal);
      if (held !== null) {
        try {
          say(releaseOwnHeavy(ctx.home, held));
        } catch (error) {
          say(`RELEASE FAILED: ${error.message}`);
          if (!signal && code === 0) code = 2;
        }
      }
      if (signal) {
        process.kill(process.pid, signal); // no listener now, so this ends the process
        resolve(null);
      } else {
        resolve(code);
      }
    };
    // While waiting, an ended child is only recorded: the wait loop sees it
    // (cancelled) and the .then below decides. Once held, its end is the job's end.
    const ended = (code, signal) => {
      exited = { code, signal };
      if (held !== null) finish(code ?? 1, signal);
    };
    child.on("error", (error) => {
      say(`could not start /bin/sh: ${error.message}`);
      ended(127, null);
    });
    child.on("exit", ended);
    if (child.pid === undefined) return; // spawn failed: "error" follows, and with no pgid there is no lock to take
    acquireHeavy({
      home: ctx.home, holder, host: ctx.host, pid: process.pid, pidStart: procStart(process.pid), pgid: child.pid,
      argv: command, waitMs: waitMsOf(opts), say, cancelled: () => stopping !== null || exited !== null,
    }).then((r) => {
      if (r.acquired) held = r.text;
      if (r.acquired) say(`acquired the heavy lock for ${JSON.stringify(holder)}: pid ${process.pid}, process group ${child.pid}`);
      if (stopping !== null) {
        child.stdio[3].destroy(); // the command never starts
        return finish(null, stopping);
      }
      if (exited !== null) {
        say(`the gated child ended before the command was let go (${exited.signal ?? `exit ${exited.code}`}); nothing ran`);
        return finish(2, null);
      }
      if (!r.acquired) {
        child.stdio[3].destroy();
        say(`${r.message}; the command was not run`);
        return finish(2, null);
      }
      child.stdio[3].end("go\n");
    }, (error) => {
      child.stdio[3].destroy();
      say(error.message);
      finish(2, null);
    });
  });
}

// Resolves to an exit code, or null (heavy run ended on a re-raised signal).
export async function heavyMain(args, env, { out = console.log, err = console.error } = {}) {
  const [action, ...rest] = args;
  try {
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
      let pid, pidStart;
      if (opts.pid !== undefined) {
        pid = Number(opts.pid);
        pidStart = procStart(pid);
        if (pidStart === null) throw new Error(`--pid ${pid}: no such running process`);
      }
      const r = await acquireHeavy({
        home: ctx.home, holder: opts.holder, host: ctx.host, pid, pidStart, waitMs: waitMsOf(opts),
        say: (m) => err(`harness-slot heavy: ${m}`),
      });
      if (!r.acquired) throw new Error(r.message);
      out(`acquired heavy for ${opts.holder}: ${lockFile(ctx.home, "heavy")}` +
        (pid === undefined ? " (no pid: freed only by heavy release, or --force --reason)" : ` (pid ${pid})`));
      return 0;
    }
    if (opts.wait !== undefined || opts.pid !== undefined) throw new Error("--wait and --pid belong to heavy acquire");
    if (opts.force) {
      out(forceReleaseLock({ home: ctx.home, target: "heavy", reason: opts.reason }));
      return 0;
    }
    if (opts.reason !== undefined) throw new Error("--reason needs --force");
    out(releaseLock({ home: ctx.home, target: "heavy", holder: opts.holder }));
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

// A3's test: does this process descend from the heavy lock's holder? Read from
// the account's home (heavyHome), never $HOME. Any failure to tell is "no": the
// slot lock then behaves exactly as it did before the heavy lock existed.
function thisJobHoldsHeavy(env) {
  try {
    return heldByThisJob(readLock(heavyHome(env), "heavy"));
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
