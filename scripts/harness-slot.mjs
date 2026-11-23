#!/usr/bin/env node
// harness-slot.mjs — the dev harness's slot-dependent values, computed from a
// slot number, and the dev:* npm scripts' command lines built from them.
//
// Run:  node scripts/harness-slot.mjs command <npm-script>   print the resolved command line
//       node scripts/harness-slot.mjs run <npm-script> [args]  run it under sh
//       node scripts/harness-slot.mjs lock acquire|release|status ...   the slot locks (H14)
//       node scripts/harness-slot.mjs heavy run -- <command> [args]    the host's limit of heavy jobs (2 on ubuntu-pc)
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
// A heavy slot's target is "heavy" (slot 0) or "heavy-K" (K from 1); its file is <target>.lock.
const isHeavy = (target) => target === "heavy" || (typeof target === "string" && target.startsWith("heavy-"));
const lockFile = (home, target) =>
  path.join(lockDir(home), target === "setup" ? "setup.lock" : isHeavy(target) ? `${target}.lock` : `slot-${target}.lock`);
const historyFile = (home) => path.join(lockDir(home), "history.log");
const lockName = (target) => (target === "setup" || isHeavy(target) ? target : `slot ${target}`);
const lockFlag = (target) => (target === "setup" ? "--setup" : `--slot ${target}`);
const releaseCommand = (target) => (isHeavy(target) ? "heavy release" : `lock release ${lockFlag(target)}`);
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

// THE LOCK ORDER (2026-11-20, after member-first-run-ui's capture held slot 1
// for 1h24m while it waited on heavy): heavy first, then the slot, everywhere.
// acquireLock takes only the slot; the CLI's `lock acquire --slot N` (lockCli)
// first takes one heavy slot (every slot with --exclusive) for the slot, unless the caller's job already
// holds heavy by its token. So a slot holder never waits on heavy, and a heavy
// holder may wait for a slot. `heavy` is that hold, recorded in the slot lock.
export function acquireLock(args) {
  return takeSlotLock(args).message;
}

// acquireLock, returning also the lock's text, byte for byte as written.
function takeSlotLock({ home, target, holder, go, now = new Date(), host = os.hostname(), race = {}, heavy }) {
  requireText("--holder", holder);
  requireText("--go", go);
  const before = exclusionConflict(home, target);
  if (before) throw new Error(before);
  fs.mkdirSync(lockDir(home), { recursive: true });
  const lock = { holder, go, acquired_at: utc(now), host, slot: target, ...(heavy ? { heavy } : {}) };
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  // R3: written whole to a temp file, then linked into place, which fails with
  // EEXIST if the lock exists: the lock path never holds a partial file.
  const tmp = privateName(lockFile(home, target), "tmp");
  fs.writeFileSync(tmp, text, { flag: "wx" });
  try {
    fs.linkSync(tmp, lockFile(home, target));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(alreadyLocked(home, target, readLock(home, target)));
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
    throw new Error(after);
  }
  appendHistory(home, `${utc(now)} acquire ${field("lock", lockName(target))} ${field("holder", holder)} ${field("go", go)} ${field("host", host)}`);
  return { message: `acquired ${lockName(target)} for ${holder}: ${lockFile(home, target)}`, text };
}

// workflow-app waits on "is already locked by" (bitcorn-workflow tests/browser-slot.py): keep it.
function alreadyLocked(home, target, held) {
  return `${lockName(target)} is already locked by ${JSON.stringify(held?.holder)}` +
    (held?.acquired_at ? ` since ${held.acquired_at}, go ${JSON.stringify(held.go)}` : "") +
    (held?.unreadable ? ` (${unreadableRefusal(home, target)})` : "");
}

export const releaseLock = (args) => releaseSlotLock(args).line;

// releaseLock, returning also the lock it removed (its `heavy`, if any, is the CLI's to release next).
function releaseSlotLock({ home, target, holder, now = new Date(), race = {} }) {
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
  return { line: releasedLine(home, target, holder, lock, utc(now)), lock };
}

// The history line and the release line. The heavy lock has no go (ruling 7),
// so its line ends at the host. `reason`, when given, ends both: a slot's heavy
// holder that let go by itself because its slot lock was gone or changed.
function releasedLine(home, target, holder, lock, at, reason) {
  appendHistory(home, `${at} release ${field("lock", lockName(target))} ${field("holder", holder)} ` +
    `${field("acquired_at", lock.acquired_at)} ${field("held", heldFor(lock.acquired_at, at))}` +
    (reason === undefined ? "" : ` ${field("reason", reason)}`));
  return `harness lock released: ${lockName(target)}, holder ${holder}, held ${lock.acquired_at} to ${at} ` +
    `(${heldFor(lock.acquired_at, at)}) on ${lock.host}` + (lock.go === undefined ? "" : `; go ${JSON.stringify(lock.go)}`) +
    (reason === undefined ? "" : `; reason ${JSON.stringify(reason)}`);
}

export const forceReleaseLock = (args) => forceReleaseSlotLock(args).line;

function forceReleaseSlotLock({ home, target, reason, now = new Date(), race = {} }) {
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
  return {
    line: `harness lock FORCE-released: ${lockName(target)}, was held by ${lock.holder} since ${lock.acquired_at ?? "?"}; ` +
      `reason ${JSON.stringify(reason)}`,
    lock,
  };
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

// Whether a slot lock's `heavy` still holds heavy: a holder pid ({ pid, job }) that
// has some heavy slot's file open, or a job token ({ job }, a slot taken inside a
// job that held heavy already) that some slot's live holder carries
// (heldByThisJob). False for a lock with no heavy record. heavyHomeDir is the
// heavy lock's home (heavyHome), which may not be the slot lock's.
export function slotHeavyLive(heavyHomeDir, heavy) {
  if (Number.isInteger(heavy?.pid)) {
    return heavySlotsOnDisk(heavyHomeDir, ".lock").some((k) => {
      const key = fileKey(lockFile(heavyHomeDir, heavySlot(k)));
      return key !== null && hasOpen(heavy.pid, key);
    });
  }
  if (typeof heavy?.job === "string" && heavy.job !== "") {
    return heldByThisJob(heavyHomeDir, { env: { HARNESS_HEAVY_JOB: heavy.job } });
  }
  return false;
}

// What a slot lock's heavy was, for a refusal.
const heavyRecordText = (heavy) => (Number.isInteger(heavy?.pid) ? `heavy holder pid ${heavy.pid}` :
  typeof heavy?.job === "string" ? `heavy job ${JSON.stringify(heavy.job)}` : "no heavy record");

// THE ORPHAN (2026-11-23: a slot-1/workflow-app heavy holder kept heavy-1 for
// 2.5 days after its slot lock, in a test's scratch lock home, was deleted with
// that home; nothing that removes a file tells the holder). A slot's heavy
// holder records where its slot lock lives (for_slot_home); a holder from
// before that record is looked for in `fallback` (the caller's $HOME).
const slotHomeOf = (info, fallback) => (typeof info?.for_slot_home === "string" ? info.for_slot_home : fallback);

// What slot `target`'s lock in `home` is now, against `text` (the lock a
// holder took): "same", "gone", "changed", or null when it cannot be read.
function slotLockNow(home, target, text) {
  let now;
  try {
    now = readLockText(home, target);
  } catch {
    return null;
  }
  return now === null ? "gone" : now === text ? "same" : "changed";
}

// Why heavy record `info` is ORPHANED — a slot's holder whose slot lock is gone
// or no longer records its pid — or null: not a slot's holder, its lock
// records it, or it cannot be told (an unreadable lock).
export function heavyOrphaned(info, fallbackSlotHome) {
  if (info === null || info.unreadable || info.kind !== "slot" || info.for_slot === undefined) return null;
  const home = slotHomeOf(info, fallbackSlotHome);
  let lock;
  try {
    lock = readLock(home, info.for_slot);
  } catch {
    return null;
  }
  const where = `${lockName(info.for_slot)}'s lock (${lockFile(home, info.for_slot)})`;
  if (lock === null) return `${where} is gone`;
  if (lock.unreadable) return null;
  if (lock.heavy?.pid !== info.pid) return `${where} records ${heavyRecordText(lock.heavy)}, not this holder's pid ${info.pid}`;
  return null;
}

// The ORPHANED tail of a status line for heavy slot k: why, and the command that frees it.
const orphanedText = (k, why) => ` — ORPHANED: ${why} — status frees nothing; ` +
  `free it with: heavy release --force --slot ${k} --reason "<why>"`;

// One line per held heavy slot whose record is ORPHANED (heavyOrphaned).
function orphanedHeavyLines(heavyHomeDir, fallbackSlotHome) {
  return heavySlotsOnDisk(heavyHomeDir, ".lock").filter((k) => heavyLocked(heavyHomeDir, k)).flatMap((k) => {
    const info = readHeavyInfo(heavyHomeDir, k);
    const why = heavyOrphaned(info, fallbackSlotHome);
    return why === null ? [] : [`${heavySlot(k)}: held by ${describeHeavy(info)}, for ${lockName(info.for_slot)}` + orphanedText(k, why)];
  });
}

// R5: the reasons a lock looks stale, and whether its listener check ran.
// F1/F2: a slot lock taken with heavy is also SUSPECT once that heavy is gone
// (heavyLive: true, false, or null when it could not say).
function suspicion(target, lock, { now, host, listening, heavyLive }) {
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
  let heavyUnchecked = false;
  if (target !== "setup" && lock.heavy !== undefined) {
    let live = null;
    try {
      live = heavyLive(lock.heavy);
    } catch {}
    if (live === false) {
      reasons.push(Number.isInteger(lock.heavy?.pid) ? `its heavy holder pid ${lock.heavy.pid} no longer holds a heavy slot` :
        `the heavy job ${JSON.stringify(lock.heavy?.job)} it was taken under no longer holds heavy`);
    }
    if (live !== true && live !== false) heavyUnchecked = true;
  }
  return { reasons, unchecked, heavyUnchecked };
}

// heavyHomeDir, when given, is the heavy lock's home: its slots' holders whose
// slot lock is gone are listed too, ORPHANED (the CLI passes it; a library call
// without it reads no heavy home).
export function lockStatus(home, {
  now = new Date(), host = os.hostname(), listening = portsListening,
  heavyLive = (heavy) => slotHeavyLive(os.userInfo().homedir, heavy), heavyHomeDir,
} = {}) {
  const lines = [];
  for (const target of ["setup", ...heldSlots(home)]) {
    const lock = readLock(home, target);
    if (lock === null) continue;
    if (lock.unreadable) {
      lines.push(`${lockName(target)}: lock file unreadable (${lockFile(home, target)})`);
      continue;
    }
    const { reasons, unchecked, heavyUnchecked } = suspicion(target, lock, { now, host, listening, heavyLive });
    lines.push(`${lockName(target)}: held by ${lock.holder} since ${lock.acquired_at} on ${lock.host}; go ${JSON.stringify(lock.go)}` +
      (unchecked ? " (listener check could not run)" : "") + (heavyUnchecked ? " (heavy check could not run)" : "") +
      (reasons.length === 0 ? "" : ` — SUSPECT: ${reasons.join("; ")} — status frees nothing; ` +
        `if it is stale: lock release ${lockFlag(target)} --force --reason "<why>"`));
  }
  if (heavyHomeDir !== undefined) lines.push(...orphanedHeavyLines(heavyHomeDir, home));
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
  "usage: harness-slot.mjs lock acquire --slot N --holder <arc> --go \"<text>\" [--wait <seconds>] [--pid <pid>] [--exclusive]\n" +
  "       harness-slot.mjs lock acquire --setup --holder <arc> --go \"<text>\"\n" +
  "       harness-slot.mjs lock release (--slot N | --setup) --holder <arc>\n" +
  "       harness-slot.mjs lock release (--slot N | --setup) --force --reason \"<text>\"\n" +
  "       harness-slot.mjs lock status\n" +
  "The order is heavy first, then the slot: lock acquire --slot takes one heavy slot (every slot with --exclusive)\n" +
  "before the slot, unless HARNESS_HEAVY_JOB says this job holds heavy already, and lock release --slot releases\n" +
  "that heavy after the slot.";

function parseLockArgs(args) {
  const opts = {};
  const valued = { "--slot": "slot", "--holder": "holder", "--go": "go", "--reason": "reason", "--wait": "wait", "--pid": "pid" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in valued) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      opts[valued[arg]] = args[++i];
    } else if (arg === "--setup" || arg === "--force" || arg === "--exclusive") {
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

// The slot lock alone, synchronously: it never takes heavy (lockCli does that
// for the CLI). --wait, --pid and --exclusive, which only that heavy uses, are lockCli's.
export function lockMain(args, { home = os.homedir(), now = new Date(), host = os.hostname(), listening = portsListening, heavyLive, heavyHomeDir } = {}) {
  const [action, ...rest] = args;
  const opts = parseLockArgs(rest);
  if (opts.wait !== undefined || opts.pid !== undefined || opts.exclusive) {
    throw new Error("--wait, --pid and --exclusive belong to lock acquire --slot, through the CLI");
  }
  if (action === "status") {
    if (Object.keys(opts).length > 0) throw new Error("lock status takes no arguments");
    return lockStatus(home, { now, host, listening, heavyHomeDir, ...(heavyLive ? { heavyLive } : {}) });
  }
  if (action === "acquire") {
    if (opts.force || opts.reason !== undefined) throw new Error("--force and --reason belong to lock release");
    return acquireLock({ home, target: lockTarget(opts), holder: opts.holder, go: opts.go, now, host });
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

// ─── the heavy lock (H1–H7; A1–A4, Ethan 2026-11-18; on flock, 2026-11-19; N slots, 2026-11-20) ─
//
// At most `limit` heavy jobs per machine at a time (H1, widened by Ethan's
// ruling of 2026-11-20: "could we at least expand to 2 heavy jobs at a time").
// Heavy (H3): full test suites (vitest, node --test), mutation and
// negative-control batches, Polar gates and captures.
//
// THE SLOTS ARE THE KERNEL'S: `limit` files, locks/heavy.lock (slot 0, named
// "heavy": the single lock's own file, so a checkout from before the slots and
// one after exclude each other on it while this rolls out), heavy-1.lock, …
// heavy-{limit-1}.lock, in ONE account's home, each locked by an exclusive
// flock(2) taken by util-linux flock(1) (/usr/bin/flock; 2.39.3 on ubuntu-pc
// and on the OptiPlex) on a descriptor this process opened. A job holds one
// slot; an exclusive job holds every slot. A flock belongs to the open file, not
// to a process: every process holding that descriptor holds the slot, and the
// kernel frees it when the last of them has closed it or exited, however they
// exit (SIGKILL and the OOM killer included). So there is no take-over and no
// liveness check: a live job's slot is never found free, a dead job's slot is
// never found held, and a crash frees exactly the crashed job's slot.
//
// THE LIMIT is this host's entry in HEAVY_HOSTS: 2 on ubuntu-pc, 1 on the
// OptiPlex. HARNESS_HEAVY_LIMIT overrides it for tests only, honoured only
// beside HARNESS_HEAVY_TEST_HOME and announced.
//
// ADMISSION: a job takes the first free slot with a non-blocking flock, under a
// short admission flock (heavy-admit.lock, held for milliseconds) so that two
// jobs starting together decide one at a time. When another slot is held, the
// job takes its slot only if MemAvailable (/proc/meminfo) is at least
// HARNESS_HEAVY_MIN_FREE_MB (default 4096), and no exclusive job is waiting;
// otherwise it waits, polling, as when every slot is held. The memory figure is
// a snapshot at admission, nothing more: it is sized to leave room for the
// first job's measured peak (app/web's full vitest, ~1,900 MB at vitest's default
// workers, ~1,052 MB at VITEST_MAX_WORKERS=2; code-audit-2, 2026-11-20); app/api's
// peak is not yet measured. A job that took its slot while another was held gets
// VITEST_MAX_WORKERS=<HARNESS_HEAVY_SHARED_WORKERS, default 3> in its command's
// environment; a job that starts alone gets none. The cap takes effect once
// code-audit-2's VITEST_MAX_WORKERS change (app/web/vitest.config.ts) merges to develop.
//
// EXCLUSIVE (--exclusive, for Polar gates, captures and measurement runs):
// takes every slot, in order, holding each while it waits for the next. Slots
// are always taken in order and a non-exclusive job never waits while holding
// one, so two waiters cannot deadlock. While an exclusive job waits, no other
// job is admitted to a slot it frees.
//
// What carries the descriptors: a heavy run's command gets its slot as fd 9 (an
// exclusive run's further slots as fd 10, 11, …; so do the Stop hook's checks),
// and a shell passes them on to the children it starts. A NODE OR PYTHON
// PROCESS DOES NOT: Node marks every descriptor it inherits close-on-exec at
// startup (02000000 in /proc/<pid>/fdinfo/9), and Python's subprocess closes
// every descriptor above 2 in its children unless named in pass_fds. Such a
// command holds the slot itself and its own children do not, so a job whose top
// process is SIGKILLed alone while those children run on frees its slot early.
// When a heavy run's top process exits, the wrapper ends the rest of its process
// group (SIGTERM, then SIGKILL after RUN_GRACE_MS), and reports a slot released
// only if no other process still holds its descriptor; one that left the group
// with it is named instead ("NOT released").
//
// The slot files are never written, truncated, replaced or removed: a removed
// file would let the next job lock a new file while a job holds the old one (an
// acquirer re-checks that the path still names the file it locked). Beside
// each, its info file (heavy.info.json, heavy-K.info.json) says who holds it: written by the holder once it has
// the slot, removed by it before it lets go. It is for display, the job token and
// admission's exclusive-waiting check only; it is never the lock.
//
// A1 — the account is this host's entry in HEAVY_HOSTS; its home comes from
//      the password database (os.userInfo()), never $HOME. Any other account,
//      and any host not in the table, is refused.
// A2 — `heavy run [--holder h] [--wait s] [--exclusive] -- <command> [args…]`
//      takes a slot, starts the command holding it, and lets go when the
//      command ends. A SIGKILLed wrapper leaves the slot with its still-running
//      command. `heavy acquire` / `heavy release` remain for callers that cannot
//      wrap: acquire starts a small detached holder process (`heavy __hold`)
//      that keeps the slot until release stops it, and records its pid; release
//      stops only a holder process that has its slot open, under the name it
//      was acquired for. With --pid, the holder also lets go when that process
//      exits.
// THE JOB TOKEN (Ethan's ruling on the second review's F2, 2026-11-19): which
//      processes belong to a heavy job is carried by the environment, never by
//      process ancestry. HARNESS_HEAVY_JOB=<holder>:<holder pid> is recorded in
//      its slot's info as `job`; heavy acquire prints it, heavy run and the Stop
//      hook set it for what they start. A process belongs to the job
//      (heldByThisJob) when its HARNESS_HEAVY_JOB equals some slot's live
//      record's job and a process of that record (its pid, or a run's command)
//      has that slot's file open. A token holds exactly one slot (every slot,
//      if exclusive): inside it, heavy run runs its command without acquiring
//      again, never taking a second slot, and heavy acquire refuses at once.
//      Concurrency inside one token is the caller's job.
// THE LOCK ORDER (2026-11-20; reverses A3): heavy first, then the slot. `lock
//      acquire --slot N` from a caller whose job holds no heavy (heldByThisJob)
//      first takes ONE heavy slot, by the same admission as any job (the limit,
//      the memory check), or every slot with --exclusive (Ethan, 2026-11-20),
//      by a holder process of kind "slot" (heavy __hold, as heavy acquire's),
//      waiting as heavy waits (--wait), then the
//      slot; the slot lock records that holder (pid, job), `lock release` lets
//      go of the slot and then of it, and with --pid the holder lets go of both
//      when that process exits. A caller whose job holds heavy just takes the
//      slot. So a slot holder never waits on heavy, and a heavy holder MAY wait
//      for a slot (A3's refuse-instead is gone): with every waiter waiting in
//      that one order, no two can deadlock.
// A4 — scripts/verify-gate.mjs takes a slot in process (lockHeavy), never
//      exclusive, and hands the descriptor to its checks as their fd 9, with its
//      token.
// Setup and heavy are independent (ruling 5). Heavy has no go (ruling 7); the
// default holder is <account>@<host>:<command>.

export const HEAVY_HOSTS = new Map([
  ["ubuntu-pc", { account: "user", limit: 2 }],
  // The OptiPlex 7050. Its own hostname, as tailscaled on it reports it
  // (tailscale status --json → HostName), 2026-11-18. Stays at one job.
  ["bitcorn-harness", { account: "harnessagent", limit: 1 }],
]);
export const HEAVY_MIN_FREE_MB = 4096; // MemAvailable a job needs to share the machine
export const HEAVY_SHARED_WORKERS = 3; // VITEST_MAX_WORKERS for a job that shares it

const FLOCK = "/usr/bin/flock"; // by path: browser-slot.py calls this CLI with a scrubbed environment
const FLOCK_BUSY = 200; // flock(1)'s exit code for "held" (-E): -n refused, or -w ran out
export const HEAVY_FD = 9; // the (first) locked descriptor's number in a command or check that holds heavy
const SELF = fileURLToPath(import.meta.url);
// Slot 0 keeps the single lock's own names (heavy.lock, heavy.info.json, lock="heavy" in
// history.log), so code from before the slots and after exclude each other on it while the
// change rolls out (Ethan, 2026-11-20). Slot k >= 1 is heavy-k.
export const heavySlot = (k) => (k === 0 ? "heavy" : `heavy-${k}`);
const heavyInfoFile = (home, k) => path.join(lockDir(home), `${heavySlot(k)}.info.json`);
const admitFile = (home) => path.join(lockDir(home), "heavy-admit.lock");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closeQuietly = (fd) => {
  try {
    fs.closeSync(fd);
  } catch {}
};

// stdio for a child that is to hold heavy: `base` as its fds 0–2, the locked
// descriptors as its fds HEAVY_FD, HEAVY_FD + 1, …, nothing in between.
export function heavyStdio(base, fds) {
  const stdio = [...base];
  while (stdio.length < HEAVY_FD) stdio.push("ignore");
  stdio.push(...[fds].flat());
  return stdio;
}

// The environment a heavy job's command gets on top of the caller's: its token,
// and, when it took its slot while another was held, the worker cap.
export const heavyJobEnv = (job, shared, sharedWorkers = HEAVY_SHARED_WORKERS) =>
  ({ HARNESS_HEAVY_JOB: job, ...(shared ? { VITEST_MAX_WORKERS: String(sharedWorkers) } : {}) });

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

const fdKey = (fd) => {
  const s = fs.fstatSync(fd);
  return `${s.dev}:${s.ino}`;
};

// Whether process `pid` has open the file `key` (fileKey) names. A process that
// cannot be read (gone, another account's) has not.
export function hasOpen(pid, key) {
  return openFds(pid, key).length > 0;
}

// The /proc directories whose fd/ and fdinfo/ hold process `pid`'s descriptors:
// its own, and, when that lists none, each of its threads'. A thread group whose
// leader has exited (a zombie) while other threads run on keeps its descriptors,
// and a flock with them, only in those threads' entries: the leader's own fd/
// lists nothing. (Probe, 2026-11-20: a SIGKILLed Node holder read state Z with a
// thread still alive, the flock still in /proc/locks, freed ~5 ms later.)
function fdDirs(pid) {
  try {
    if (fs.readdirSync(`/proc/${pid}/fd`).length > 0) return [`/proc/${pid}`];
  } catch {}
  try {
    return fs.readdirSync(`/proc/${pid}/task`).filter((tid) => tid !== String(pid)).map((tid) => `/proc/${pid}/task/${tid}`);
  } catch {
    return [];
  }
}

// The descriptors ({ dir, n }) on which process `pid`, any thread of it, has open the file `key` names.
function openFds(pid, key) {
  return fdDirs(pid).flatMap((dir) => {
    let fds;
    try {
      fds = fs.readdirSync(`${dir}/fd`);
    } catch {
      return [];
    }
    return fds.filter((n) => {
      try {
        const s = fs.statSync(`${dir}/fd/${n}`);
        return `${s.dev}:${s.ino}` === key;
      } catch {
        return false;
      }
    }).map((n) => ({ dir, n }));
  });
}

const allPids = () => fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).map(Number);

// The processes that hold the flock on the file `key` names, read from
// /proc/<pid>/fdinfo (or a thread's, fdDirs): a descriptor whose open file holds
// a flock lists it as a "lock:" line there, and every process sharing that open
// file shows it. A waiter's own open of the file shows none, so it is not counted.
export function lockHolders(key) {
  return allPids().filter((pid) => openFds(pid, key).some(({ dir, n }) => {
    try {
      return /^lock:\s.*\bFLOCK\b/m.test(fs.readFileSync(`${dir}/fdinfo/${n}`, "utf8"));
    } catch {
      return false;
    }
  }));
}

// How long a release waits, after its holder's pid has gone, for the last
// process (or thread) holding the lock to let go, before it says NOT released.
export const LOCK_FREE_WAIT_MS = 3000;

// Polls until no process other than `except` holds the flock on any of `keys`,
// up to waitMs. Resolves to the pids still holding it then: [] when free.
export async function lockFreed(keys, { except = [], waitMs = LOCK_FREE_WAIT_MS } = {}) {
  const held = () => [...new Set(keys.flatMap((key) => lockHolders(key)))].filter((p) => !except.includes(p));
  for (const t0 = Date.now(); ;) {
    const left = held();
    if (left.length === 0 || Date.now() - t0 >= waitMs) return left;
    await sleep(25);
  }
}

const readProcLocks = () => fs.readFileSync("/proc/locks", "utf8");

// Whether the kernel holds heavy slot k, read from /proc/locks, which takes
// nothing. /proc/locks prints the device its own way, so a line is matched on
// the inode, and (F6) the lock counts only while some process has the slot's
// file itself open by dev:ino, so another filesystem's file with the same inode
// number is not mistaken for it. procLocks is a test seam.
export function heavyLocked(home, k, { procLocks = readProcLocks } = {}) {
  const key = fileKey(lockFile(home, heavySlot(k)));
  if (key === null) return false;
  const ino = key.split(":")[1];
  const listed = procLocks().split("\n").some((line) => {
    // "1: FLOCK  ADVISORY  WRITE 1234 fc:00:3576783 0 EOF"; a waiter's line reads "1: -> FLOCK …".
    const f = line.trim().split(/\s+/);
    return f[1] === "FLOCK" && f[5]?.split(":")[2] === ino;
  });
  return listed && allPids().some((pid) => hasOpen(pid, key));
}

// The slot numbers whose files (`suffix`: ".lock" or ".info.json") exist.
function heavySlotsOnDisk(home, suffix) {
  let names;
  try {
    names = fs.readdirSync(lockDir(home));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  // Slot 0 is "heavy" (heavy.lock), slot k >= 1 is "heavy-k"; heavy-admit.lock is neither.
  const re = new RegExp(`^heavy(?:-([1-9][0-9]*))?${suffix.replace(/\./g, "\\.")}$`);
  return names.map((n) => n.match(re)).filter(Boolean).map((m) => (m[1] === undefined ? 0 : Number(m[1]))).sort((a, b) => a - b);
}

function readInfoText(home, k) {
  try {
    return fs.readFileSync(heavyInfoFile(home, k), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Who holds slot k, as its holder recorded it: null when nothing is recorded,
// { unreadable: true } when the file does not parse. Display, the job token and admission only.
export function readHeavyInfo(home, k) {
  const text = readInfoText(home, k);
  return text === null ? null : parseLock(text);
}

// Removes slot k's info if it still holds `text`, and only then.
function dropInfo(home, k, text) {
  if (readInfoText(home, k) === text) fs.rmSync(heavyInfoFile(home, k), { force: true });
}

// A slot's holder as reported to a waiter: who, since when, where, and what of it runs.
export function describeHeavy(info) {
  // No info file: a holder that took the slot an instant ago and has not written it yet,
  // a flock(1) outside these tools, or a process that inherited the slot after its
  // holder's record was removed. Which, the lock cannot say.
  if (info === null) return "a holder that names none (no heavy info file: just starting, outside these tools, or an inheritor)";
  if (info.unreadable) return "a holder whose info file is unreadable (display only: the lock itself is the kernel's)";
  const who = `${JSON.stringify(info.holder)}${info.exclusive ? " (exclusive)" : ""} since ${info.acquired_at} on ${info.host}`;
  if (running(info.pid)) return `${who}, pid ${info.pid} running`;
  if (running(info.command_pid)) return `${who}, pid ${info.pid} gone but its command (pid ${info.command_pid}) still running`;
  return `${who}, pid ${info.pid} gone: a process that inherited the lock still holds it`;
}

// [{ slot, info }] → "<holder description> (heavy) and … (heavy-1)"; short: holder and time only.
const holdersText = (busy, { short = false } = {}) => busy.map(({ slot, info }) =>
  (short ? `${JSON.stringify(info?.holder ?? "(unrecorded)")} since ${info?.acquired_at ?? "?"}` : describeHeavy(info)) +
  ` (${heavySlot(slot)})`).join(" and ");

// The lock order and nesting: whether the caller (its environment, `env`) belongs to a job
// holding heavy — its HARNESS_HEAVY_JOB is some slot's live record's job, and a
// process of that record has that slot's file open (see THE JOB TOKEN, above).
// Ancestry plays no part.
export function heldByThisJob(home, { env = process.env } = {}) {
  const token = env.HARNESS_HEAVY_JOB;
  if (typeof token !== "string" || token === "") return false;
  try {
    return heavySlotsOnDisk(home, ".info.json").some((k) => {
      const key = fileKey(lockFile(home, heavySlot(k)));
      const info = key === null ? null : readHeavyInfo(home, k);
      if (info === null || info.unreadable || info.job !== token) return false;
      return [info.pid, info.command_pid].some((p) => Number.isInteger(p) && p > 0 && hasOpen(p, key));
    });
  } catch {
    return false;
  }
}

// The info of the first slot this token's job holds (for "already held by this job" messages).
export const heldJobInfo = (home, env = process.env) => heavySlotsOnDisk(home, ".info.json").map((k) => readHeavyInfo(home, k))
  .find((i) => i !== null && !i.unreadable && i.job === env.HARNESS_HEAVY_JOB) ?? null;

export const jobToken = (holder, pid) => `${holder}:${pid}`;

// A1: null when `account` is this host's heavy account, else the refusal.
export function heavyAccountRefusal(host, account) {
  const expected = HEAVY_HOSTS.get(host)?.account;
  const known = [...HEAVY_HOSTS].map(([h, e]) => `${h} → ${e.account}`).join(", ");
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

function wholeSetting(name, raw, min) {
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min) throw new Error(`${name} must be a whole number from ${min}, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

// The slot limit, the memory threshold, the worker cap and where MemAvailable
// is read, with a note for each value that is not the default. The limit is the
// host table's (1 for a host not in it); HARNESS_HEAVY_LIMIT and
// HARNESS_HEAVY_TEST_MEMINFO are test seams, honoured only beside
// HARNESS_HEAVY_TEST_HOME; HARNESS_HEAVY_MIN_FREE_MB and
// HARNESS_HEAVY_SHARED_WORKERS are settings.
export function heavySettings(env, host = os.hostname()) {
  const testing = Boolean(env.HARNESS_HEAVY_TEST_HOME);
  const hostLimit = HEAVY_HOSTS.get(host)?.limit ?? 1;
  const notes = [];
  let limit = hostLimit;
  if (testing && env.HARNESS_HEAVY_LIMIT) {
    limit = wholeSetting("HARNESS_HEAVY_LIMIT", env.HARNESS_HEAVY_LIMIT, 1);
    notes.push(`a TEST slot limit, ${limit} (HARNESS_HEAVY_LIMIT), not this host's ${hostLimit}`);
  }
  let minFreeMb = HEAVY_MIN_FREE_MB;
  if (env.HARNESS_HEAVY_MIN_FREE_MB) {
    minFreeMb = wholeSetting("HARNESS_HEAVY_MIN_FREE_MB", env.HARNESS_HEAVY_MIN_FREE_MB, 0);
    notes.push(`a job sharing the machine needs MemAvailable >= ${minFreeMb} MB (HARNESS_HEAVY_MIN_FREE_MB), not ${HEAVY_MIN_FREE_MB}`);
  }
  let sharedWorkers = HEAVY_SHARED_WORKERS;
  if (env.HARNESS_HEAVY_SHARED_WORKERS) {
    sharedWorkers = wholeSetting("HARNESS_HEAVY_SHARED_WORKERS", env.HARNESS_HEAVY_SHARED_WORKERS, 1);
    notes.push(`a job sharing the machine gets VITEST_MAX_WORKERS=${sharedWorkers} (HARNESS_HEAVY_SHARED_WORKERS), not ${HEAVY_SHARED_WORKERS}`);
  }
  let meminfo = "/proc/meminfo";
  if (testing && env.HARNESS_HEAVY_TEST_MEMINFO) {
    meminfo = env.HARNESS_HEAVY_TEST_MEMINFO;
    if (!path.isAbsolute(meminfo)) throw new Error(`HARNESS_HEAVY_TEST_MEMINFO must be an absolute path, got ${JSON.stringify(meminfo)}`);
    notes.push(`a TEST meminfo, ${meminfo} (HARNESS_HEAVY_TEST_MEMINFO), not /proc/meminfo`);
  }
  return { limit, minFreeMb, sharedWorkers, meminfo, notes };
}

// A1 for a command that takes the lock: { home, account, host, notes, limit,
// minFreeMb, sharedWorkers, meminfo }, or a throw naming the refusal. Test
// seam: HARNESS_HEAVY_TEST_ACCOUNT, an account name to act as, honoured only
// beside HARNESS_HEAVY_TEST_HOME, so it can make a run refuse but can never put
// a real run's lock in another home.
export function heavyContext(env, { host = os.hostname(), user = os.userInfo() } = {}) {
  const home = heavyHome(env, { user });
  const testing = Boolean(env.HARNESS_HEAVY_TEST_HOME);
  const account = (testing && env.HARNESS_HEAVY_TEST_ACCOUNT) || user.username;
  const notes = testing ? [`a TEST lock home, ${home} (HARNESS_HEAVY_TEST_HOME), not the account's` +
    (account !== user.username ? `; acting as account ${account} (HARNESS_HEAVY_TEST_ACCOUNT)` : "")] : [];
  const refusal = heavyAccountRefusal(host, account);
  if (refusal) throw new Error(refusal);
  const settings = heavySettings(env, host);
  return { home, account, host, ...settings, notes: [...notes, ...settings.notes] };
}

// MemAvailable, in MB, from a meminfo file. A file without it is an error,
// never a guess.
export function memAvailableMb(file = "/proc/meminfo") {
  const m = fs.readFileSync(file, "utf8").match(/^MemAvailable:\s+([0-9]+) kB$/m);
  if (!m) throw new Error(`no MemAvailable line in ${file}`);
  return Math.floor(Number(m[1]) / 1024);
}

// One flock(1) on `fd` (its fd 3): resolves "locked" or "busy", or rejects when
// flock(1) cannot run. waitMs 0 is -n; Infinity waits for as long as it takes.
// Aborted, the flock(1) is killed: "busy", and if it had just taken the lock,
// the caller's close of `fd` lets it go.
function flockOnce(fd, waitMs, signal) {
  const args = ["-x", "-E", String(FLOCK_BUSY)];
  if (waitMs === 0) args.push("-n");
  else if (waitMs !== Infinity) args.push("-w", (waitMs / 1000).toFixed(3));
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

// Slot k's descriptor, locked, or null when it is held (or its file was
// replaced while this looked: the next poll locks the file the path names).
async function tryTake(home, k, signal) {
  const file = lockFile(home, heavySlot(k));
  const fd = fs.openSync(file, "a", 0o644);
  let got;
  try {
    got = await flockOnce(fd, 0, signal);
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
  if (got === "locked" && !signal?.aborted && fileKey(file) === fdKey(fd)) return fd;
  closeQuietly(fd);
  return null;
}

// The slots of 0..limit-1 other than `skip` that the kernel holds, with their records.
const busySlots = (home, limit, skip = []) => [...Array(limit).keys()]
  .filter((k) => !skip.includes(k) && heavyLocked(home, k))
  .map((slot) => ({ slot, info: readHeavyInfo(home, slot) }));

// One admission decision, under the admission flock. `taken` is an exclusive
// waiter's slots so far (it keeps them between polls). Resolves to
// { entries, shared } on admission, else { kind: "held" | "memory" |
// "exclusive", busy, free?, mb? } saying why not, or { cancelled }.
async function admit(home, { limit, exclusive, minFreeMb, meminfo, record, signal, deadline }, taken) {
  const admitFd = fs.openSync(admitFile(home), "a", 0o644);
  try {
    // F4: the admission flock waits no longer than the job's own wait has left.
    const left = deadline === Infinity ? Infinity : Math.max(0, Math.ceil(deadline - Date.now()));
    if (await flockOnce(admitFd, left, signal) !== "locked") {
      return signal?.aborted ? { cancelled: true } : { kind: "admission", busy: busySlots(home, limit, taken.map((t) => t.slot)) };
    }
    const take = (k, fd, extra = {}) => {
      try {
        return { slot: k, fd, rec: recordHeavy(home, k, fd, { ...record, ...extra }, new Date(), { deferLog: true }) };
      } catch (error) {
        closeQuietly(fd);
        throw error;
      }
    };
    if (exclusive) {
      for (let k = taken.length; k < limit; k++) {
        const fd = await tryTake(home, k, signal);
        if (fd === null) break;
        taken.push(take(k, fd, { exclusive: true }));
      }
      if (taken.length === limit) return { entries: [...taken], shared: false };
      return { kind: "held", busy: busySlots(home, limit, taken.map((t) => t.slot)) };
    }
    for (let k = 0; k < limit; k++) {
      const fd = await tryTake(home, k, signal);
      if (fd === null) continue;
      const others = busySlots(home, limit, [k]);
      if (others.length > 0) {
        const waiting = others.filter((o) => o.info?.exclusive);
        if (waiting.length > 0) {
          closeQuietly(fd);
          return { kind: "exclusive", free: k, busy: waiting };
        }
        let mb;
        try {
          mb = memAvailableMb(meminfo);
        } catch (error) {
          closeQuietly(fd); // F5: the slot this took is let go before the error leaves
          throw error;
        }
        if (mb < minFreeMb) {
          closeQuietly(fd);
          return { kind: "memory", free: k, busy: others, mb };
        }
      }
      return { entries: [take(k, fd)], shared: others.length > 0 };
    }
    return { kind: "held", busy: busySlots(home, limit) };
  } finally {
    closeQuietly(admitFd);
  }
}

// Why a job is not admitted, as a waiter is told it; short names holders by name and time only.
function notAdmitted(r, { minFreeMb }, { short = false } = {}) {
  const holders = holdersText(r.busy, { short });
  if (r.kind === "memory") {
    return `${heavySlot(r.free)} is free, but MemAvailable is ${r.mb} MB, under the ${minFreeMb} MB a job sharing ` +
      `the machine needs, while heavy is held by ${holders}`;
  }
  if (r.kind === "exclusive") return `${heavySlot(r.free)} is free, but an exclusive job is waiting for every slot: ${holders}`;
  if (r.kind === "admission") {
    return "the admission lock (heavy-admit.lock) was held by another job's admission until this one's wait ran out" +
      (r.busy.length > 0 ? `, while heavy is held by ${holders}` : "");
  }
  return `heavy lock held by ${holders}`;
}

// A2: take a heavy slot (exclusive: every slot), waiting up to waitMs, saying
// why it waits, and record it: `record` is the fields recordHeavy writes for
// each slot (holder, host, kind, pid, job, …), written while admission is
// held; the history line waits for hold.log(extra). Resolves to { hold }:
//   hold.entries  [{ slot, fd, rec }]   hold.fds  the descriptors, in slot order
//   hold.shared   whether another slot was held when this one was taken
//   hold.log(extra)  history.log's acquire line, per slot
//   hold.release(at) the release lines, per slot (removes the records, closes the fds)
// or { hold: null, message, notRun, cancelled? } when the wait ran out or
// `signal` aborted it. message keeps "is already locked by", the phrase the
// slot lock's waiters read; notRun is the Stop hook's shorter form.
export async function lockHeavy({ home, limit = 1, exclusive = false, minFreeMb = HEAVY_MIN_FREE_MB, meminfo = "/proc/meminfo",
  record, waitMs = Infinity, pollMs = 1000, say = () => {}, signal } = {}) {
  fs.mkdirSync(lockDir(home), { recursive: true });
  const t0 = Date.now();
  const opts = { limit, exclusive, minFreeMb, meminfo, record, signal, deadline: waitMs === Infinity ? Infinity : t0 + waitMs };
  const taken = [];
  let said = null;
  let last = null;
  try {
    for (;;) {
      const r = await admit(home, opts, taken);
      if (r.entries) {
        const entries = r.entries;
        return {
          hold: {
            entries,
            fds: entries.map((e) => e.fd),
            slots: entries.map((e) => e.slot),
            shared: r.shared,
            log: (extra) => entries.forEach((e) => e.rec.log(extra)),
            release: (at) => entries.map((e) => e.rec.release(at)).filter((line) => line !== null),
          },
        };
      }
      if (!r.cancelled) last = r;
      const left = waitMs - (Date.now() - t0);
      if (r.cancelled || signal?.aborted || left <= 0) break;
      const why = notAdmitted(r, opts);
      // A holder an instant old has its slot but has not recorded it yet: give it
      // half a second before saying who holds it, rather than naming no one.
      const unrecorded = r.busy.some((b) => b.info === null) && Date.now() - t0 < 500;
      if (!unrecorded && (said === null || said.why !== why || Date.now() - said.at >= 60_000)) {
        say(`${why}; waiting (checking every ${pollMs / 1000}s, ` +
          `${waitMs === Infinity ? "no limit" : `up to ${Math.round(waitMs / 1000)}s`}` +
          `${exclusive ? `, for every slot (exclusive)` : ""})`);
        said = { why, at: Date.now() };
      }
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(pollMs, left));
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  } catch (error) {
    for (const t of taken) t.rec.release();
    throw error;
  }
  // Not admitted: an exclusive waiter lets go of the slots it had.
  for (const t of taken) t.rec.release();
  const busy = last?.busy ?? busySlots(home, limit);
  const view = last ?? { kind: "held", busy };
  const waited = Math.round((Date.now() - t0) / 1000);
  if (signal?.aborted) return { hold: null, cancelled: true, message: `cancelled while ${notAdmitted(view, opts)}` };
  return {
    hold: null,
    message: (view.kind === "held" ? `heavy is already locked by ${holdersText(busy)}` : `heavy not admitted: ${notAdmitted(view, opts)}`) +
      `; waited ${waited}s`,
    notRun: notAdmitted(view, opts, { short: true }),
  };
}

// Once slot k is held: write its info and history.log's acquire line.
// fields: holder, host, kind ("run", "acquire" or "gate"), pid (the process
// holding the descriptor), job (its token), and what the kind adds. Returns
// { info, text, logged, log(extra), release(at) }. With deferLog, the acquire
// line waits for log(extra), which first adds `extra` to the record (heavy run:
// the record is written before its command starts, the command's pid after).
// release removes the info file and, if the acquire was logged, writes the
// release line while still holding, then closes `fd`; it returns the release
// line, or null when nothing was logged.
export function recordHeavy(home, k, fd, { holder, host, ...rest }, now = new Date(), { deferLog = false } = {}) {
  const slot = heavySlot(k);
  const info = { holder, acquired_at: utc(now), host, slot, ...rest };
  const file = heavyInfoFile(home, k);
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
      appendHistory(home, `${info.acquired_at} acquire ${field("lock", slot)} ${field("holder", holder)} ` +
        `${field("host", host)} ${field("pid", info.pid ?? null)} ${field("pgid", info.pgid ?? null)}` +
        (info.exclusive ? ` ${field("exclusive", true)}` : "") + (info.shared ? ` ${field("shared", true)}` : ""));
      rec.logged = true;
    },
    release: (at = new Date(), reason = undefined) => {
      try {
        dropInfo(home, k, rec.text);
        return rec.logged ? releasedLine(home, slot, holder, info, utc(at), reason) : null;
      } finally {
        closeQuietly(fd);
      }
    },
  };
  if (!deferLog) rec.log();
  return rec;
}

// One line per slot (0..limit-1, and any other slot file on disk), free or its
// holder; a slot's holder whose slot lock is gone is flagged ORPHANED (looked for
// in slotHome when its record does not say where).
export function heavyStatus(home, limit = 1, { slotHome = os.homedir() } = {}) {
  const slots = [...new Set([...Array(limit).keys(), ...heavySlotsOnDisk(home, ".lock")])].sort((a, b) => a - b);
  return slots.map((k) => {
    if (!heavyLocked(home, k)) return `${heavySlot(k)} ${lockFile(home, heavySlot(k))}: free` + (k >= limit ? ` (beyond this host's limit of ${limit})` : "");
    const info = readHeavyInfo(home, k);
    const why = heavyOrphaned(info, slotHome);
    return `${heavySlot(k)} ${lockFile(home, heavySlot(k))}: held by ${describeHeavy(info)}` +
      (k >= limit ? ` (beyond this host's limit of ${limit})` : "") + (why === null ? "" : orphanedText(k, why));
  }).join("\n");
}

const HEAVY_USAGE =
  "usage: harness-slot.mjs heavy run [--holder <h>] [--wait <seconds>] [--exclusive] -- <command> [args...]\n" +
  "       harness-slot.mjs heavy acquire --holder <h> [--pid <pid>] [--wait <seconds>] [--exclusive]\n" +
  "       harness-slot.mjs heavy release --holder <h> [--slot <K>]\n" +
  "       harness-slot.mjs heavy release --force --reason \"<text>\" [--slot <K>]\n" +
  "       harness-slot.mjs heavy status";

function parseHeavyArgs(args) {
  const opts = {};
  const valued = { "--holder": "holder", "--wait": "wait", "--pid": "pid", "--reason": "reason", "--slot": "slot" };
  let i = 0;
  for (; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i];
    if (arg in valued) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      opts[valued[arg]] = args[++i];
    } else if (arg === "--force" || arg === "--exclusive") {
      opts[arg.slice(2)] = true;
    } else {
      throw new Error(`unknown heavy argument ${JSON.stringify(arg)}\n${HEAVY_USAGE}`);
    }
  }
  if (opts.wait !== undefined && !/^[0-9]+(\.[0-9]+)?$/.test(opts.wait)) {
    throw new Error(`--wait takes a number of seconds, got ${JSON.stringify(opts.wait)}`);
  }
  if (opts.pid !== undefined && !/^[1-9][0-9]*$/.test(opts.pid)) throw new Error(`--pid takes a pid, got ${JSON.stringify(opts.pid)}`);
  if (opts.slot !== undefined && !/^(0|[1-9][0-9]*)$/.test(opts.slot)) throw new Error(`--slot takes a slot number, got ${JSON.stringify(opts.slot)}`);
  return { opts, command: i < args.length ? args.slice(i + 1) : null };
}

const waitMsOf = (opts) => (opts.wait === undefined ? Infinity : Number(opts.wait) * 1000);
const signalCode = (signal) => 128 + (os.constants.signals[signal] ?? 0);

// Signals Node does not die of: it ignores SIGPIPE, and SIGUSR1 starts its
// inspector, whose start can abort the process (Node 20.20.2, 2026-11-20:
// "Assertion failed: start_io_thread_async_initialized", exit 134).
const NOT_FATAL_TO_NODE = new Set(["SIGPIPE", "SIGUSR1"]);

// Ends this process on `signal`, or, for one Node does not die of, leaves with
// its code without raising it: 128 + the signal's number either way.
function reraise(signal) {
  process.exitCode = signalCode(signal);
  if (!NOT_FATAL_TO_NODE.has(signal)) process.kill(process.pid, signal);
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

// The lockHeavy options a context gives.
const admission = (ctx) => ({ home: ctx.home, limit: ctx.limit, minFreeMb: ctx.minFreeMb, meminfo: ctx.meminfo });

// F2, the lock order: null, or the refusal when the caller's holder
// (HARNESS_HOLDER) holds a slot lock whose heavy is not live (slotHeavyLive): a
// heavy wait from it would wait on heavy while holding a slot.
function orderRefusal(slotHome, ctx, env) {
  const holder = env.HARNESS_HOLDER;
  if (typeof holder !== "string" || holder === "") return null;
  const stale = heldSlots(slotHome).map((slot) => ({ slot, lock: readLock(slotHome, slot) }))
    .filter(({ lock }) => lock !== null && !lock.unreadable && lock.holder === holder && !slotHeavyLive(ctx.home, lock.heavy));
  if (stale.length === 0) return null;
  return `heavy refused: HARNESS_HOLDER ${JSON.stringify(holder)} holds ` +
    `${stale.map(({ slot, lock }) => `${lockName(slot)} (${heavyRecordText(lock.heavy)}, not live)`).join(", ")}, ` +
    "and waiting on heavy while holding a slot breaks the lock order (heavy first, then the slot); release the slot " +
    `(lock release ${lockFlag(stale[0].slot)} --holder ${holder}) and take it again, which takes heavy first`;
}

// `heavy run`: resolves to the exit code to leave with, or null when the
// command ended on a signal that has been re-raised on this process.
function heavyRun(opts, command, env, ctx, { err, slotHome }) {
  const say = (m) => err(`harness-slot heavy: ${m}`);
  const holder = opts.holder ?? `${ctx.account}@${ctx.host}:${command.join(" ")}`;
  requireText("--holder", holder);
  if (heldByThisJob(ctx.home, { env })) {
    // Nested inside this job's own hold (its token): waiting would wait on itself,
    // and a token never takes a second slot.
    const held = heldJobInfo(ctx.home, env);
    say(`already held by this job (${JSON.stringify(held?.holder ?? "(unrecorded)")}); running without acquiring again`);
    return new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { stdio: "inherit", env });
      child.on("error", (error) => { say(`could not start ${JSON.stringify(command[0])}: ${error.message}`); resolve(127); });
      child.on("exit", (code, signal) => resolve(signal ? signalCode(signal) : code));
    });
  }
  const refusal = orderRefusal(slotHome, ctx, env);
  if (refusal) throw new Error(refusal);
  return new Promise((resolve) => {
    const waiting = new AbortController();
    let hold = null; // lockHeavy's hold, once taken (its records written)
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
    // each slot this job holds, then leaves. F1: a process that still holds a
    // slot's descriptor (it left the group with it) means that slot is NOT
    // released: it is named, its record stays, and no release line is written.
    const finish = async (code, signal) => {
      if (done) return;
      done = true;
      for (const s of signals) process.removeListener(s, onSignal);
      if (child !== null && child.pid !== undefined) await endGroup(child.pid);
      for (const { slot, fd, rec } of hold?.entries ?? []) {
        try {
          // Bounded: a process of the command that is still exiting (a thread outliving its
          // leader) lets go within milliseconds; one that left the group keeps it.
          const others = await lockFreed([fdKey(fd)], { except: [process.pid] });
          if (others.length > 0) {
            closeQuietly(fd);
            say(`${heavySlot(slot)} NOT released: ${others.map((p) => `pid ${p} (${procComm(p)})`).join(", ")} still ` +
              `${others.length === 1 ? "holds" : "hold"} its descriptor; it frees when ${others.length === 1 ? "it exits" : "they exit"}`);
            if (!signal && code === 0) code = 2;
          } else {
            const line = rec.release();
            if (line !== null) say(line);
          }
        } catch (error) {
          closeQuietly(fd);
          say(`${heavySlot(slot)} RELEASE FAILED: ${error.message}`);
          if (!signal && code === 0) code = 2;
        }
      }
      if (signal) {
        reraise(signal);
        resolve(null);
      } else {
        resolve(code);
      }
    };
    // The record (and its job token) is written before the command starts, so
    // nothing the command runs can look for it too early.
    const job = jobToken(holder, process.pid);
    lockHeavy({
      ...admission(ctx), exclusive: Boolean(opts.exclusive), waitMs: waitMsOf(opts), say, signal: waiting.signal,
      record: { holder, host: ctx.host, kind: "run", pid: process.pid, job, argv: command },
    }).then((r) => {
      if (r.hold === null) {
        if (stopping !== null) return finish(null, stopping);
        say(`${r.message}; the command was not run`);
        return finish(2, null);
      }
      hold = r.hold;
      if (stopping !== null) return finish(null, stopping);
      // detached: its own process group, so a forwarded signal reaches all of it.
      child = spawn(command[0], command.slice(1), {
        stdio: heavyStdio(["inherit", "inherit", "inherit"], hold.fds), detached: true,
        env: { ...env, ...heavyJobEnv(job, hold.shared, ctx.sharedWorkers) },
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
        hold.log({ command_pid: child.pid, pgid: child.pid, ...(hold.shared ? { shared: true } : {}) });
        say(`acquired the heavy lock (${hold.slots.map(heavySlot).join(", ")}) for ${JSON.stringify(holder)}: ` +
          `pid ${process.pid}, process group ${child.pid}` +
          (hold.shared ? `; sharing the machine, so VITEST_MAX_WORKERS=${ctx.sharedWorkers}` : ""));
      } catch (error) {
        say(`the heavy lock is held, but its record could not be updated: ${error.message}`);
      }
    }, (error) => {
      say(error.message);
      finish(2, null);
    });
  });
}

// `heavy __hold <spec>`: the detached holder process `heavy acquire` starts.
// It takes a slot (exclusive: every slot), records it (its own pid), tells the
// acquiring CLI over IPC, and keeps it until heavy release stops it (SIGTERM;
// the release lines are already written) or, with --pid, until that process
// exits. If the acquiring CLI goes away while this still waits, it stops waiting.
// With spec.slot ({ target, home }: lock acquire --slot's heavy, kind "slot"),
// it holds heavy for that slot lock: the CLI takes the slot once this has heavy
// and sends its text ({ slotTaken }), or { abandon } when the slot could not be
// had; if the CLI goes away before either, this lets go of heavy. With --pid,
// when that process exits it removes the slot lock (only if it is still the
// one taken, byte for byte), then lets go of heavy: the reverse of the order.
// Once the slot is taken, with or without --pid, it looks at the slot lock every
// second, and lets go of heavy by itself when that lock has been gone, or been
// another lock, for HOLD_ORPHAN_GRACE_MS: its release line then carries
// reason="slot lock gone" or reason="slot lock changed" (THE ORPHAN).
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
    r = await lockHeavy({
      ...admission(ctx), exclusive: Boolean(spec.exclusive), waitMs: spec.waitMs ?? Infinity,
      say: (m) => send({ say: m }), signal: waiting.signal,
      record: {
        holder: spec.holder, host: ctx.host, kind: spec.slot ? "slot" : "acquire", pid: process.pid,
        job: jobToken(spec.holder, process.pid),
        ...(spec.slot ? { for_slot: spec.slot.target, for_slot_home: spec.slot.home } : {}),
        ...(spec.watch ? { owner_pid: spec.ownerPid, owner_start: spec.ownerStart } : {}),
      },
    });
  } catch (error) {
    send({ failed: error.message }); // this process's stderr goes nowhere: the acquiring CLI says it
    return 2;
  }
  if (r.hold === null) {
    send({ failed: r.message });
    return 2;
  }
  held = true;
  const hold = r.hold;
  try {
    hold.log(hold.shared ? { shared: true } : {});
  } catch (error) {
    hold.release(); // unlogged, release could not find it: let go rather than hold it unnamed
    send({ failed: `the heavy lock was taken but could not be recorded (${error.message}); it was let go` });
    return 2;
  }
  process.on("SIGTERM", () => {
    for (const fd of hold.fds) closeQuietly(fd);
    process.exit(0);
  });
  // Let go, logged as a release (with `reason`, if given), unless a release has already taken the record.
  const letGo = (reason) => {
    for (const { slot, fd, rec } of hold.entries) {
      if (readInfoText(ctx.home, slot) === rec.text) rec.release(new Date(), reason);
      else closeQuietly(fd);
    }
    process.exit(0);
  };
  let slotText = null; // the slot lock's text, once the CLI has taken it
  if (spec.slot) {
    process.on("message", (m) => {
      if (typeof m?.slotTaken === "string") slotText = m.slotTaken;
      else if (m?.abandon) letGo();
    });
  }
  send({ acquired: true, pid: process.pid, job: hold.entries[0].rec.info.job, slots: hold.slots, shared: hold.shared });
  let missingSince = null; // when the slot lock was first seen gone or changed, in this run of looks
  return new Promise(() => {
    setInterval(() => {
      if (spec.watch && procStart(spec.ownerPid) !== spec.ownerStart) {
        // The process this lock was taken for has exited: the slot first, then heavy.
        if (slotText !== null) {
          const { target, home } = spec.slot;
          try {
            const lock = removeLock(home, target, (_, text) => (text === slotText ? null :
              `${lockName(target)} is no longer the lock taken with this heavy`));
            if (lock !== null) releasedLine(home, target, lock.holder, lock, utc(new Date()));
          } catch {} // not this hold's lock any more: left in place
        }
        letGo();
      }
      if (!spec.slot) return;
      if (slotText === null) {
        // The CLI went away before it took the slot: nothing will take it with this heavy.
        // (Polled, not a disconnect listener: one added after the await above misses a disconnect during it.)
        if (!process.connected) letGo();
        return;
      }
      // THE ORPHAN: the slot lock this heavy was taken for is gone, or is another
      // lock now, and nothing told this holder (a file removed, a scratch home
      // deleted). It lets go once that has lasted HOLD_ORPHAN_GRACE_MS, so a
      // normal lock release, which removes the slot and then stops this holder,
      // is never logged as an orphan. A lock it cannot read is not a lock gone.
      const now = slotLockNow(spec.slot.home, spec.slot.target, slotText);
      if (now === "same" || now === null) {
        missingSince = null;
        return;
      }
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= HOLD_ORPHAN_GRACE_MS) letGo(now === "gone" ? "slot lock gone" : "slot lock changed");
    }, 1000);
  });
}

// How long a slot's heavy holder waits, once its slot lock is gone or changed, before it lets go.
export const HOLD_ORPHAN_GRACE_MS = 3000;

// `heavy acquire`: starts the holder process and reports what it did, ending
// with the job token as a line `HARNESS_HEAVY_JOB=<token>` (shell-quoted) for
// the caller to set in every command of its job, and, when it shares the
// machine, `VITEST_MAX_WORKERS=<n>` likewise. F3: inside a job that already
// holds heavy it refuses at once: the new holder would wait on this job.
function heavyAcquire(opts, ctx, env, { out, err, slotHome }) {
  requireText("--holder", opts.holder);
  if (heldByThisJob(ctx.home, { env })) {
    const held = heldJobInfo(ctx.home, env);
    throw new Error(`already held by this job (${JSON.stringify(held?.holder ?? "(unrecorded)")}); nothing acquired`);
  }
  const refusal = orderRefusal(slotHome, ctx, env);
  if (refusal) throw new Error(refusal);
  const watch = opts.pid !== undefined;
  const ownerPid = watch ? Number(opts.pid) : null;
  const ownerStart = watch ? procStart(ownerPid) : null;
  if (watch && ownerStart === null) throw new Error(`--pid ${ownerPid}: no such running process`);
  const spec = {
    holder: opts.holder, waitMs: opts.wait === undefined ? null : Number(opts.wait) * 1000, ownerPid, ownerStart, watch,
    exclusive: Boolean(opts.exclusive),
  };
  const holder = spawn(process.execPath, [SELF, "heavy", "__hold", JSON.stringify(spec)], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    // The holder runs this module afresh: it must read the same test settings as this CLI.
    env,
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
        out(`acquired heavy for ${opts.holder}: ${m.slots.map((k) => lockFile(ctx.home, heavySlot(k))).join(", ")} (held by pid ${m.pid}` +
          (watch ? ` for pid ${ownerPid}, freed when it exits)` : "; freed by heavy release, or --force --reason)"));
        out(`HARNESS_HEAVY_JOB=${quote(m.job)}`);
        if (m.shared) out(`VITEST_MAX_WORKERS=${ctx.sharedWorkers}`);
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

// F4: how long a holder process has, after its SIGKILL, to be gone before its release says NOT released.
export const KILL_WAIT_MS = 2000;

// Signals a holder process and waits for it to end: SIGKILL after 10 s, then at
// most KILL_WAIT_MS more. Resolves true once it is gone, false if it is still
// running then. kill and isRunning are test seams.
export async function stopHolder(pid, signal, { kill = (p, s) => process.kill(p, s), isRunning = running } = {}) {
  const send = (s) => {
    try {
      kill(pid, s);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  send(signal);
  let t0 = Date.now();
  let killed = signal === "SIGKILL";
  while (isRunning(pid)) {
    if (!killed && Date.now() - t0 > 10_000) {
      send("SIGKILL");
      killed = true;
      t0 = Date.now();
    } else if (killed && Date.now() - t0 > KILL_WAIT_MS) {
      return false;
    }
    await sleep(25);
  }
  return true;
}

// Stops holder process `pid` and confirms its `slots` are free, before any
// release of them is written or reported. Under the admission flock, so no job
// can take one of them meanwhile: it signals the holder, waits for its pid to
// go, then for no process to hold any of their locks (a thread outliving the
// pid included: fdDirs), up to LOCK_FREE_WAIT_MS. Throws NOT released, naming
// who still holds them, when they do not free in time, or when the holder is
// still running KILL_WAIT_MS after its SIGKILL. stop is stopHolder's test seams.
export async function stopAndConfirm(home, pid, signal, slots, stop = {}) {
  const admitFd = fs.openSync(admitFile(home), "a", 0o644);
  try {
    if (await flockOnce(admitFd, 10_000) !== "locked") throw new Error("the admission lock was not had within 10 s; nothing was released");
    if (!(await stopHolder(pid, signal, stop))) {
      throw new Error(`${slots.map(heavySlot).join(", ")} NOT released: holder pid ${pid} (${procComm(pid)}) is still running ` +
        `${KILL_WAIT_MS / 1000} s after its SIGKILL; it frees when it exits`);
    }
    const left = await lockFreed(slots.map((k) => fileKey(lockFile(home, heavySlot(k)))).filter((key) => key !== null));
    if (left.length > 0) {
      throw new Error(`${slots.map(heavySlot).join(", ")} NOT released: ${left.map((p) => `pid ${p} (${procComm(p)})`).join(", ")} ` +
        `still ${left.length === 1 ? "holds" : "hold"} the lock ${LOCK_FREE_WAIT_MS / 1000} s after holder pid ${pid} ended; ` +
        `it frees when ${left.length === 1 ? "it exits" : "they exit"}`);
    }
  } finally {
    closeQuietly(admitFd);
  }
}

// `heavy release`: stops a heavy acquire's holder process. Only a holder
// process that has its slot open, and (without --force) only under the name it
// was acquired for; --slot K picks one when several match. A heavy run, or the
// Stop hook, holds its slot for as long as its job runs: nothing here can take
// it from them.
async function heavyRelease(opts, ctx, slotHome) {
  const home = ctx.home;
  const held = [...new Set([...Array(ctx.limit).keys(), ...heavySlotsOnDisk(home, ".lock")])]
    .filter((k) => heavyLocked(home, k))
    .map((k) => {
      const text = readInfoText(home, k);
      const info = text === null ? null : parseLock(text);
      const key = fileKey(lockFile(home, heavySlot(k)));
      const holderProcess = info !== null && !info.unreadable && (info.kind === "acquire" || info.kind === "slot") &&
        Number.isInteger(info.pid) && key !== null && hasOpen(info.pid, key);
      return { slot: k, text, info, holderProcess };
    });
  if (held.length === 0) throw new Error("heavy: no lock to release");
  const inScope = opts.slot === undefined ? held : held.filter((h) => h.slot === Number(opts.slot));
  if (inScope.length === 0) throw new Error(`${heavySlot(opts.slot)}: no lock to release`);
  const notAHolder = (hs) => `heavy is held by ${holdersText(hs)}, not by a heavy acquire holder process: ` +
    "the kernel frees it when that job ends, and nothing else can";
  let targets;
  if (opts.force) {
    requireText("--reason", opts.reason);
    targets = inScope.filter((h) => h.holderProcess);
    if (targets.length === 0) throw new Error(notAHolder(inScope));
    // F1: a slot's heavy whose slot lock still records it goes with that slot, by the slot's own --force.
    const tied = targets.find((h) => h.info.kind === "slot" &&
      readLock(slotHomeOf(h.info, slotHome), h.info.for_slot)?.heavy?.pid === h.info.pid);
    if (tied) {
      throw new Error(`heavy is held for ${lockName(tied.info.for_slot)}'s lock, which still records it (holder pid ` +
        `${tied.info.pid}); free both, the slot first: lock release ${lockFlag(tied.info.for_slot)} --force --reason "<why>"`);
    }
  } else {
    requireText("--holder", opts.holder);
    const named = inScope.filter((h) => h.info !== null && !h.info.unreadable && h.info.holder === opts.holder);
    if (named.length === 0) {
      throw new Error(`heavy is held by ${holdersText(inScope, { short: true })}, not ${JSON.stringify(opts.holder)}; ` +
        "a stale lock is cleared with heavy release --force --reason \"<why>\"");
    }
    targets = named.filter((h) => h.holderProcess);
    if (targets.length === 0) throw new Error(notAHolder(named));
    // The lock order: a slot lock's heavy goes with its slot, after it.
    const forSlot = targets.find((h) => h.info.kind === "slot");
    if (forSlot) {
      throw new Error(`heavy is held for ${lockName(forSlot.info.for_slot)}'s lock; release that slot (lock release ` +
        `${lockFlag(forSlot.info.for_slot)} --holder <arc>), which releases its heavy after it`);
    }
  }
  const pids = [...new Set(targets.map((h) => h.info.pid))];
  if (pids.length > 1) {
    throw new Error(`heavy: ${pids.length} holder processes match (${holdersText(targets, { short: true })}); ` +
      "name one with --slot <K>");
  }
  // The holder process's every slot goes with it (an exclusive holder's are all of them).
  const slots = held.filter((h) => h.holderProcess && h.info.pid === pids[0]);
  // Released only once confirmed free; a record the holder itself has already
  // released (its --pid owner exited meanwhile) is not released twice.
  await stopAndConfirm(home, pids[0], opts.force ? "SIGKILL" : "SIGTERM", slots.map((h) => h.slot));
  const at = utc(new Date());
  const lines = [];
  for (const h of slots.filter((s) => readInfoText(home, s.slot) === s.text)) {
    if (opts.force) {
      appendHistory(home, `${at} force-release ${field("lock", heavySlot(h.slot))} ${field("holder", h.info.holder)} ` +
        `${field("acquired_at", h.info.acquired_at ?? null)} ${field("reason", opts.reason)}`);
      lines.push(`harness lock FORCE-released: ${heavySlot(h.slot)}, was held by ${h.info.holder} since ` +
        `${h.info.acquired_at ?? "?"}; reason ${JSON.stringify(opts.reason)}`);
    } else {
      lines.push(releasedLine(home, heavySlot(h.slot), h.info.holder, h.info, at));
    }
    dropInfo(home, h.slot, h.text);
  }
  return lines.join("\n");
}

// Resolves to an exit code, or null (heavy run ended on a re-raised signal).
// slotHome: where the slot locks are (main's home), for the lock order's checks.
export async function heavyMain(args, env, { out = console.log, err = console.error, slotHome = os.homedir() } = {}) {
  const [action, ...rest] = args;
  try {
    if (action === "__hold") return await heavyHold(rest[0], heavyContext(env));
    const { opts, command } = parseHeavyArgs(rest);
    if (opts.exclusive && action !== "run" && action !== "acquire") throw new Error("--exclusive belongs to heavy run and heavy acquire");
    if (opts.slot !== undefined && action !== "release") throw new Error("--slot belongs to heavy release");
    if (action === "status") {
      if (Object.keys(opts).length > 0 || command !== null) throw new Error("heavy status takes no arguments");
      const home = heavyHome(env);
      const settings = heavySettings(env);
      if (env.HARNESS_HEAVY_TEST_HOME) err(`harness-slot heavy: a TEST lock home, ${home} (HARNESS_HEAVY_TEST_HOME), not the account's`);
      for (const note of settings.notes) err(`harness-slot heavy: ${note}`);
      out(heavyStatus(home, settings.limit, { slotHome }));
      return 0;
    }
    if (!["run", "acquire", "release"].includes(action)) throw new Error(HEAVY_USAGE);
    const ctx = heavyContext(env);
    for (const note of ctx.notes) err(`harness-slot heavy: ${note}`);
    if (action === "run") {
      if (command === null || command.length === 0) throw new Error(`heavy run needs -- <command>\n${HEAVY_USAGE}`);
      if (opts.pid !== undefined || opts.force || opts.reason !== undefined) throw new Error("heavy run takes only --holder, --wait and --exclusive");
      return await heavyRun(opts, command, env, ctx, { err, slotHome });
    }
    if (command !== null) throw new Error(`heavy ${action} takes no command\n${HEAVY_USAGE}`);
    if (action === "acquire") {
      if (opts.force || opts.reason !== undefined) throw new Error("--force and --reason belong to heavy release");
      return await heavyAcquire(opts, ctx, env, { out, err, slotHome });
    }
    if (opts.wait !== undefined || opts.pid !== undefined) throw new Error("--wait and --pid belong to heavy acquire");
    if (!opts.force && opts.reason !== undefined) throw new Error("--reason needs --force");
    out(await heavyRelease(opts, ctx, slotHome));
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

// The lock order's test: does this process belong to a job holding heavy
// (heldByThisJob)? Read from the account's home (heavyHome), never $HOME. Any
// failure to tell is "no": the slot acquire then takes heavy itself.
function thisJobHoldsHeavy(env) {
  try {
    return heldByThisJob(heavyHome(env), { env });
  } catch {
    return false;
  }
}

// The heavy holder's name for slot `target`'s lock, held by `holder`.
const slotHeavyHolder = (target, holder) => `slot-${target}/${holder}`;

// `lock acquire --slot N` with no heavy of this job's: ONE heavy slot (Ethan,
// 2026-11-20), by the same admission as any heavy job (the limit, the memory
// check), or every slot with --exclusive, by a holder process of kind "slot";
// then the slot, recorded with it. If the slot cannot be had, heavy is let go
// again and the slot's refusal thrown as it is (so "is already locked by" still
// reaches browser-slot.py). A heavy wait that runs out is thrown in words that
// carry "is already locked by" too, whatever kept it out (held, memory, an
// exclusive waiter), since browser-slot.py waits on that phrase alone.
function acquireSlotWithHeavy({ home, target, holder, go, wait, pid, exclusive }, ctx, env, { out, err }) {
  const watch = pid !== undefined;
  const ownerPid = watch ? Number(pid) : null;
  const ownerStart = watch ? procStart(ownerPid) : null;
  if (watch && ownerStart === null) throw new Error(`--pid ${ownerPid}: no such running process`);
  // F6: a held slot is refused before heavy is waited for, in the words its waiters read.
  const held = readLock(home, target);
  if (held !== null) throw new Error(alreadyLocked(home, target, held));
  const spec = {
    holder: slotHeavyHolder(target, holder), waitMs: wait === undefined ? null : Number(wait) * 1000,
    ownerPid, ownerStart, watch, exclusive: Boolean(exclusive), slot: { target, home },
  };
  const child = spawn(process.execPath, [SELF, "heavy", "__hold", JSON.stringify(spec)], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env,
  });
  return new Promise((resolve, reject) => {
    let state = "waiting"; // → "abandoning" | "done"
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const settle = (fn) => {
      if (state === "done") return;
      state = "done";
      for (const s of signals) process.removeListener(s, onSignal);
      if (child.connected) child.disconnect();
      child.unref();
      fn();
    };
    // Stopped while the holder waits: it must not take heavy for nobody.
    const onSignal = (signal) => {
      try { child.kill("SIGKILL"); } catch {}
      settle(() => {
        reraise(signal);
        resolve(null);
      });
    };
    for (const s of signals) process.on(s, onSignal);
    child.on("message", (m) => {
      if (typeof m?.say === "string") {
        err(`harness-slot lock: ${m.say}`);
      } else if (m?.acquired && state === "waiting") {
        let taken;
        try {
          taken = takeSlotLock({ home, target, holder, go, heavy: { pid: m.pid, job: m.job } });
        } catch (error) {
          // The slot could not be had: heavy goes back, and the slot's own refusal is the answer.
          state = "abandoning";
          child.once("exit", () => settle(() => {
            err(`harness-slot lock: heavy (${m.slots.map(heavySlot).join(", ")}) let go again: ${lockName(target)} was not taken`);
            reject(error);
          }));
          child.send({ abandon: true });
          return;
        }
        child.send({ slotTaken: taken.text }, () => settle(() => {
          out(taken.message);
          out(`with the heavy lock${exclusive ? ", exclusive" : ""} (${m.slots.map(heavySlot).join(", ")}), taken first, ` +
            `held by pid ${m.pid}: released with the slot${watch ? `, or when pid ${ownerPid} exits` : ""}`);
          out(`HARNESS_HEAVY_JOB=${quote(m.job)}`);
          if (m.shared) out(`VITEST_MAX_WORKERS=${ctx.sharedWorkers}`);
          resolve(0);
        }));
      } else if (typeof m?.failed === "string") {
        const failed = /is already locked by /.test(m.failed) ? m.failed :
          `heavy is already locked by another job, and this one was not admitted: ${m.failed.replace(/^heavy not admitted: /, "")}`;
        settle(() => reject(new Error(failed)));
      }
    });
    child.on("error", (error) => settle(() => reject(new Error(`could not start the heavy holder process: ${error.message}`))));
    child.on("exit", (code, signal) => {
      if (state === "waiting") settle(() => reject(new Error(`the heavy holder process ended (${signal ?? `exit ${code}`}) before it took heavy`)));
    });
  });
}

// After a slot lock is released (or force-released): its heavy, if it had one,
// whose holder process is checked (its record, by pid and job, and the slot's
// file open: F4) before it is stopped. Returns the lines to print.
async function releaseSlotHeavy(heavy, env, { reason } = {}) {
  const home = heavyHome(env);
  const held = heavySlotsOnDisk(home, ".info.json").map((k) => ({ slot: k, text: readInfoText(home, k) }))
    .map((h) => ({ ...h, info: h.text === null ? null : parseLock(h.text) }))
    .filter(({ slot, info }) => {
      const key = fileKey(lockFile(home, heavySlot(slot)));
      return info !== null && !info.unreadable && info.kind === "slot" && info.pid === heavy.pid && info.job === heavy.job &&
        key !== null && hasOpen(heavy.pid, key);
    });
  if (held.length === 0) return [`its heavy (holder pid ${heavy.pid}) had already been let go`];
  // Released only once confirmed free (stopAndConfirm), never before.
  await stopAndConfirm(home, heavy.pid, reason === undefined ? "SIGTERM" : "SIGKILL", held.map((h) => h.slot));
  const at = utc(new Date());
  const lines = held.filter((h) => readInfoText(home, h.slot) === h.text).map(({ slot, text, info }) => {
    let line;
    if (reason === undefined) {
      line = releasedLine(home, heavySlot(slot), info.holder, info, at);
    } else {
      appendHistory(home, `${at} force-release ${field("lock", heavySlot(slot))} ${field("holder", info.holder)} ` +
        `${field("acquired_at", info.acquired_at ?? null)} ${field("reason", reason)}`);
      line = `harness lock FORCE-released: ${heavySlot(slot)}, was held by ${info.holder} since ${info.acquired_at ?? "?"}; ` +
        `reason ${JSON.stringify(reason)}`;
    }
    dropInfo(home, slot, text);
    return line;
  });
  return lines;
}

// `lock …` from the CLI: lockMain, with the lock order around it for slots.
// Resolves to an exit code (null after a re-raised signal).
async function lockCli(args, env, { home, out, err }) {
  const [action, ...rest] = args;
  if (action !== "acquire" && action !== "release") {
    out(lockMain(args, { home, heavyLive: (heavy) => slotHeavyLive(heavyHome(env), heavy), heavyHomeDir: heavyHome(env) }));
    return 0;
  }
  const opts = parseLockArgs(rest);
  const target = lockTarget(opts);
  if (action === "release") {
    if (opts.go !== undefined) throw new Error("--go belongs to lock acquire");
    if (opts.wait !== undefined || opts.pid !== undefined || opts.exclusive) {
      throw new Error("--wait, --pid and --exclusive belong to lock acquire --slot");
    }
    if (!opts.force && opts.reason !== undefined) throw new Error("--reason needs --force");
    // The slot first, then its heavy: the reverse of the order.
    const { line, lock } = opts.force ? forceReleaseSlotLock({ home, target, reason: opts.reason }) :
      releaseSlotLock({ home, target, holder: opts.holder });
    out(line);
    if (lock.heavy && !Number.isInteger(lock.heavy.pid)) {
      // F2: taken inside a job that held heavy already: that heavy is the job's, not the slot's.
      out(`heavy: left to job ${JSON.stringify(lock.heavy.job)}, which held it before the slot was taken`);
    } else if (lock.heavy) {
      try {
        for (const l of await releaseSlotHeavy(lock.heavy, env, opts.force ? { reason: opts.reason } : {})) out(l);
      } catch (error) {
        err(`harness-slot lock: ${lockName(target)} was released, but its heavy (holder pid ${lock.heavy.pid}) was NOT: ${error.message}`);
        return 2;
      }
    }
    return 0;
  }
  if (opts.force || opts.reason !== undefined) throw new Error("--force and --reason belong to lock release");
  if (opts.wait !== undefined && !/^[0-9]+(\.[0-9]+)?$/.test(opts.wait)) throw new Error(`--wait takes a number of seconds, got ${JSON.stringify(opts.wait)}`);
  if (opts.pid !== undefined && !/^[1-9][0-9]*$/.test(opts.pid)) throw new Error(`--pid takes a pid, got ${JSON.stringify(opts.pid)}`);
  if (target === "setup") {
    if (opts.wait !== undefined || opts.pid !== undefined || opts.exclusive) {
      throw new Error("--wait, --pid and --exclusive belong to lock acquire --slot");
    }
    out(acquireLock({ home, target, holder: opts.holder, go: opts.go }));
    return 0;
  }
  requireText("--holder", opts.holder);
  requireText("--go", opts.go);
  if (thisJobHoldsHeavy(env)) {
    // This job holds heavy already (its token): just the slot, under whatever heavy the job took.
    if (opts.wait !== undefined || opts.pid !== undefined || opts.exclusive) {
      err("harness-slot lock: this job holds heavy already (whatever it took), so --wait, --pid and --exclusive have nothing to do");
    }
    // F2: the slot records the job it was taken under, so lock status can say when that hold is gone.
    out(acquireLock({ home, target, holder: opts.holder, go: opts.go, heavy: { job: env.HARNESS_HEAVY_JOB } }));
    out("heavy: already held by this job (HARNESS_HEAVY_JOB), so not taken again; the slot's release leaves it");
    return 0;
  }
  const ctx = heavyContext(env);
  for (const note of ctx.notes) err(`harness-slot lock: ${note}`);
  return acquireSlotWithHeavy({
    home, target, holder: opts.holder, go: opts.go, wait: opts.wait, pid: opts.pid, exclusive: Boolean(opts.exclusive),
  }, ctx, env, { out, err });
}

// Returns an exit code, or null once `run` has handed over to the shell; for
// `heavy` and `lock`, a Promise of either.
export function main(argv, env, { home = os.homedir(), shell = spawnShell, out = console.log, err = console.error } = {}) {
  const [sub, ...rest] = argv;
  if (sub === "heavy") return heavyMain(rest, env, { out, err, slotHome: home }); // a Promise
  if (sub === "lock") {
    // A Promise: lock acquire --slot may wait for heavy, and lock release may stop its holder.
    return lockCli(rest, env, { home, out, err }).catch((error) => {
      err(`harness-slot lock: ${error.message}`);
      return 2;
    });
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
